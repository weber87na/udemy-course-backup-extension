export function supportedPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'udemy.com' || url.hostname.endsWith('.udemy.com')) &&
      !url.username && !url.password && /^\/course\/[^/]+\/learn(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

export function summarize(scan) {
  if (scan.loggedOut) return { tone: 'warning', title: '需要登入', text: '請在 Udemy 登入購課帳號，再重新檢查。' };
  const videos = scan.downloads.filter(item => item.kind === 'lecture');
  if (videos.some(item => !item.disabled)) return { tone: 'success', title: '這堂講座有官方下載選項', text: '可使用下方按鈕啟動下載。影片畫質依 Udemy 播放器目前設定。' };
  if (videos.length) return { tone: 'warning', title: '這堂講座的官方下載已停用', text: '目前無法透過此選項取得影片。可請講師開放下載，或使用 Udemy App 的離線觀看功能。' };
  return { tone: 'neutral', title: '尚未找到影片下載選項', text: scan.hasVideo ? '請按「檢查播放器選單」。找不到控制項不代表整門課都禁止下載。' : '請先開啟一堂影片。教材資源可在課程目錄的「資源」選單查看。' };
}

export function safeReport(scan) {
  const page = new URL(scan.pageUrl);
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    pageUrl: page.origin + page.pathname,
    courseTitle: scan.courseTitle,
    lectureTitle: scan.lectureTitle,
    lectureId: scan.lectureId,
    officialDownloads: scan.downloads.map(({label,kind,disabled}) => ({label,kind,available:!disabled})),
    visibleLectureLinks: scan.lectures.map(({title,url}) => {
      const item = new URL(url);
      return {title,url:item.origin + item.pathname};
    }),
    notes: ['這是目前頁面的檢查結果，不是整門課程的完整下載清單。', ...scan.notes]
  };
}
