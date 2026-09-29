// Persist only evidence summaries. Media URLs and credentials never belong here.
export const STORAGE_PREFIX = 'libraryCheck:';
const MAX_RESULTS = 2000;
const DAY = 24 * 60 * 60 * 1000;
const REASONS = Object.freeze({
  'hls-supported': 'HLS 清單與首片段檢查通過',
  encrypted: '串流已加密，本工具不支援',
  'unsupported-format': '目前工具不支援這種串流格式',
  dash: '觀察到 DASH 來源，目前工具不支援 DASH；尚未確認是否加密',
  'dash-drm': 'DASH 清單宣告內容保護，本工具不支援',
  'source-unconfirmed': '尚未確認這堂講座的可用來源',
  network: '媒體讀取失敗，請重新檢查連線、權限或存取狀態',
  timeout: '等待來源或媒體讀取逾時',
  login: '請確認登入與課程存取狀態',
  cancelled: '檢查已停止',
  'catalog-incomplete': '課程目錄尚未核對完整',
  'no-video': '未找到可辨識的影片講座',
  'worker-open-failed': '無法建立工具的背景課程分頁',
  'course-load-timeout': '等待課程頁載入逾時',
  'course-unavailable': '課程頁無法開啟，請確認登入與存取狀態',
  'course-identity-unconfirmed': '尚未讀取到課程頁的課程 ID',
  'course-identity-mismatch': '課程頁 ID 與課程卡片不一致',
  'source-page-changed': '工具建立的課程分頁已關閉、暫停或切換',
  'page-script-failed': '無法在課程頁執行檢查，請確認網站權限',
  'catalog-unavailable': '課程內容側欄或目錄尚未可供讀取',
  'catalog-timeout': '等待課程目錄展開逾時',
  'catalog-invalid': '課程目錄的講座資料或數量不一致',
  'player-unavailable': '尚未找到唯一可辨識的影片播放器',
  'lecture-unconfirmed': '課程網址或目錄尚未確認目前講座',
  'asset-unconfirmed': '尚未確認播放器的影片識別碼',
  'player-title-unconfirmed': '播放器標題尚未對應到目前講座',
  'source-ambiguous': '觀察到多個來源，無法確認這堂影片的清單',
  'playback-blocked': 'Chrome 未允許工具啟動播放，請在課程頁確認可播放',
  'player-loading': '播放器尚未完成載入或穩定性確認',
  'player-background': 'Chrome 未顯示檢查分頁，請讓 Chrome 視窗保持可見後重試',
  'dash-invalid': 'DASH 回應不是可確認的完整 MPD 清單',
  'lock-unavailable': '課程檢查無法取得工作鎖，請先停止其他備份工作'
});
const statuses = new Set(['downloadable', 'unsupported', 'unknown']);
const unsupportedReasons = new Set(['encrypted', 'unsupported-format', 'dash', 'dash-drm']);

function shortText(value, limit = 240) {
  return String(value ?? '').replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']*/gi, '[網址已隱藏]')
    .replace(/[?&][A-Za-z0-9_.%-]+=[^\s<>"']*/g, '[查詢參數已隱藏]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function normalizeCourse(value, base) {
  const input = value && typeof value === 'object' && !(value instanceof URL) ? value : null;
  const source = input ? input.courseKey ?? input.url : value;
  if (typeof source !== 'string' && !(source instanceof URL)) return null;
  let url;
  try { url = new URL(source, base); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)udemy\.com$/i.test(url.hostname)) return null;
  if (/^\/course-dashboard-redirect\/?$/.test(url.pathname)) {
    const ids = url.searchParams.getAll('course_id');
    if (ids.length !== 1 || !/^[1-9]\d{0,19}$/.test(ids[0])) return null;
    const courseId = ids[0];
    const courseKey = `${url.origin}/course-dashboard-redirect/?course_id=${courseId}`;
    const result = {courseKey, url: courseKey, courseId};
    if (input && typeof input.title === 'string') result.title = shortText(input.title);
    return result;
  }
  const match = /^\/course\/([^/]+)(?:\/(?:learn(?:\/(?:lecture\/\d+\/?)?)?)?)?$/.exec(url.pathname);
  if (!match || match[1].length > 240) return null;
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { return null; }
  if (!slug || /[\s/\\?#\u0000-\u001f\u007f]/u.test(slug)) return null;
  const courseKey = `${url.origin}/course/${match[1]}`;
  const result = {courseKey, url: `${courseKey}/learn/`};
  if (input && typeof input.title === 'string') result.title = shortText(input.title);
  return result;
}

export function reasonLabel(code) { return typeof code === 'string' && Object.hasOwn(REASONS, code) ? REASONS[code] : REASONS['source-unconfirmed']; }
export function diagnosticCode(code, fallback = 'source-unconfirmed') {
  if (typeof code === 'string' && code !== 'hls-supported' && Object.hasOwn(REASONS, code)) return code;
  return typeof fallback === 'string' && fallback !== 'hls-supported' && Object.hasOwn(REASONS, fallback) ? fallback : 'source-unconfirmed';
}

export function sanitizeRecord(record) {
  if (!record || typeof record !== 'object' || record.version !== 1) return null;
  const course = normalizeCourse(record.courseKey);
  if (!course || typeof record.title !== 'string' || typeof record.catalogComplete !== 'boolean' ||
      typeof record.finished !== 'boolean' || !['sample', 'full'].includes(record.mode) ||
      !Number.isSafeInteger(record.checkedAt) || record.checkedAt <= 0 ||
      !Array.isArray(record.results) || record.results.length > MAX_RESULTS) return null;
  const total = record.totalVideos;
  if (total !== null && (!Number.isSafeInteger(total) || total < 0 || total > 100000)) return null;
  if ((record.catalogComplete && total === null) || (total !== null && record.results.length > total)) return null;
  if (record.issue !== undefined && (typeof record.issue !== 'string' || record.issue === 'hls-supported' || !Object.hasOwn(REASONS, record.issue))) return null;
  const seen = new Set(), results = [];
  for (const item of record.results) {
    if (!item || typeof item !== 'object' || typeof item.lectureId !== 'string' || !/^[1-9]\d{0,19}$/.test(item.lectureId) ||
        seen.has(item.lectureId) || typeof item.title !== 'string' || typeof item.reason !== 'string' || !statuses.has(item.status) ||
        !Object.hasOwn(REASONS, item.reason) || (item.status === 'downloadable' && item.reason !== 'hls-supported') ||
        (item.status !== 'downloadable' && item.reason === 'hls-supported') ||
        (item.status === 'unsupported' && !unsupportedReasons.has(item.reason))) return null;
    seen.add(item.lectureId);
    results.push({lectureId: item.lectureId, title: shortText(item.title), status: item.status, reason: item.reason});
  }
  const safe = {version: 1, courseKey: course.courseKey, title: shortText(record.title), totalVideos: total,
    catalogComplete: record.catalogComplete, checkedAt: record.checkedAt, finished: record.finished, mode: record.mode, results};
  if (record.issue !== undefined) safe.issue = record.issue;
  return safe;
}

export function summarizeRecord(record, now = Date.now()) {
  const safe = sanitizeRecord(record);
  if (!safe) return {label: '待檢查', tone: 'neutral', detail: '尚未確認這門課是否符合目前工具支援的 HLS 格式。'};
  if (!Number.isFinite(now) || now - safe.checkedAt >= DAY || safe.checkedAt - now > 300000) {
    return {label: '需重新檢查', tone: 'warning', detail: '紀錄已超過 24 小時或檢查時間無效，請重新確認目前來源。'};
  }
  const count = status => safe.results.filter(item => item.status === status).length;
  const passed = count('downloadable'), unsupported = count('unsupported'), unknown = count('unknown');
  const checked = safe.results.length;
  const coverage = `已檢查 ${checked} / ${safe.totalVideos === null ? '未知' : safe.totalVideos} 堂影片`;
  const scope = '可下載僅表示目前工具的 HLS 清單與首片段檢查通過，不保證全片下載成功。';
  const counts = `${coverage}；通過 ${passed}、不支援 ${unsupported}、尚未確認 ${unknown}。`;
  const explanations = [...new Set([safe.issue, ...safe.results.filter(item => item.status === 'unknown').map(item => item.reason)].filter(Boolean))];
  const diagnosis = explanations.length ? ` ${explanations.slice(0, 4).map(reasonLabel).join('；')}。` : '';
  const full = safe.mode === 'full' && safe.catalogComplete && safe.finished && !safe.issue && safe.totalVideos > 0 && checked === safe.totalVideos;
  if (full && passed === checked) return {label: '可下載', tone: 'good', detail: `${counts}${scope}`};
  if (full && unsupported === checked) return {label: '不可下載', tone: 'bad', detail: `${counts}已檢查影片均不符合目前工具支援範圍。`};
  if (full && passed > 0 && unsupported > 0 && unknown === 0) return {label: '部分可下載', tone: 'warning', detail: `${counts}${scope}`};
  if (passed > 0) return {label: '可下載（部分已確認）', tone: 'warning', detail: `${counts}此結果不代表整門課。${scope}${diagnosis}`};
  if (unsupported > 0) return {label: '已查部分不可下載', tone: 'warning', detail: `${counts}其餘影片尚未確認，不能據此判定整門課。${diagnosis}`};
  return {label: '尚未確認', tone: 'neutral', detail: `${counts}${safe.totalVideos === 0 ? reasonLabel('no-video') : '尚無足夠來源證據，請重新檢查。'}${diagnosis}`};
}
