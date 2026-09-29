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
  'no-video': '未找到可辨識的影片講座'
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

export function reasonLabel(code) { return REASONS[code] || REASONS['source-unconfirmed']; }

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
  return {version: 1, courseKey: course.courseKey, title: shortText(record.title), totalVideos: total,
    catalogComplete: record.catalogComplete, checkedAt: record.checkedAt, finished: record.finished, mode: record.mode, results};
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
  const full = safe.mode === 'full' && safe.catalogComplete && safe.finished && safe.totalVideos > 0 && checked === safe.totalVideos;
  if (full && passed === checked) return {label: '可下載', tone: 'good', detail: `${counts}${scope}`};
  if (full && unsupported === checked) return {label: '不可下載', tone: 'bad', detail: `${counts}已檢查影片均不符合目前工具支援範圍。`};
  if (full && passed > 0 && unsupported > 0 && unknown === 0) return {label: '部分可下載', tone: 'warning', detail: `${counts}${scope}`};
  if (passed > 0) return {label: '可下載（部分已確認）', tone: 'warning', detail: `${counts}此結果不代表整門課。${scope}`};
  if (unsupported > 0) return {label: '已查部分不可下載', tone: 'warning', detail: `${counts}其餘影片尚未確認，不能據此判定整門課。`};
  return {label: '尚未確認', tone: 'neutral', detail: `${counts}${safe.totalVideos === 0 ? reasonLabel('no-video') : '尚無足夠來源證據，請重新檢查。'}`};
}
