// Conservative RFC 8216 subset: unencrypted, complete MPEG-TS VOD only.
// This module performs no network requests and never copies query tokens.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 20000;
const fail = message => { throw new Error(message); };

function allowedUrl(value, base) {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f\u007f]/u.test(value)) {
    fail('播放清單包含無效的網址。');
  }
  let url;
  try { url = base === undefined ? new URL(value) : new URL(value, base); }
  catch { fail('播放清單包含無效的網址。'); }
  const host = url.hostname;
  const allowed = host === 'udemy.com' || host.endsWith('.udemy.com') ||
    host === 'udemycdn.com' || host.endsWith('.udemycdn.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port || url.hash) {
    fail('只接受 HTTPS Udemy 或 udemycdn.com 網址，不接受其他網域、帳密、連接埠或片段識別碼。');
  }
  return url;
}

// Attribute values such as CODECS may contain commas inside double quotes.
function attributes(value) {
  const result = Object.create(null);
  let position = 0;
  while (position < value.length) {
    const keyMatch = /^[A-Z0-9-]+=/.exec(value.slice(position));
    if (!keyMatch) fail('播放清單的屬性格式不正確。');
    const key = keyMatch[0].slice(0, -1);
    if (Object.hasOwn(result, key)) fail('播放清單含有重複的屬性。');
    position += keyMatch[0].length;
    let item;
    if (value[position] === '"') {
      const end = value.indexOf('"', position + 1);
      if (end === -1) fail('播放清單的引號未成對。');
      item = value.slice(position + 1, end);
      position = end + 1;
    } else {
      const end = value.indexOf(',', position);
      const stop = end === -1 ? value.length : end;
      item = value.slice(position, stop);
      if (!item || /[\s"]/u.test(item)) fail('播放清單的屬性值不正確。');
      position = stop;
    }
    result[key] = item;
    if (position < value.length) {
      if (value[position] !== ',' || position === value.length - 1) fail('播放清單的屬性分隔格式不正確。');
      position += 1;
    }
  }
  if (!Object.keys(result).length) fail('播放清單缺少必要屬性。');
  return result;
}

function integer(value, name, allowZero = false) {
  if (!/^\d+$/.test(value ?? '')) fail(`${name}必須是整數。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) fail(`${name}超出支援範圍。`);
  return parsed;
}

function blockedTag(tag, payload) {
  if (tag === '#EXT-X-SESSION-KEY') fail('清單包含工作階段金鑰，已停止；不支援加密或 DRM。');
  if (tag === '#EXT-X-KEY') {
    const attr = attributes(payload);
    if (attr.METHOD !== 'NONE') fail('影片串流已加密，已停止；不讀取金鑰、不解密，也不處理 DRM。');
    if (Object.keys(attr).length !== 1) fail('未加密標記含有其他金鑰屬性，已停止。');
  }
  if (tag === '#EXT-X-MAP') fail('不支援 fMP4 或需要初始化片段的串流。');
  if (tag === '#EXT-X-BYTERANGE') fail('不支援以位元組範圍儲存的串流。');
  if (tag === '#EXT-X-DISCONTINUITY' || tag === '#EXT-X-DISCONTINUITY-SEQUENCE') fail('串流含有不連續片段，目前不支援。');
  if (tag === '#EXT-X-DEFINE') fail('不支援使用變數的播放清單。');
  if (['#EXT-X-PART', '#EXT-X-PART-INF', '#EXT-X-PRELOAD-HINT', '#EXT-X-SERVER-CONTROL', '#EXT-X-RENDITION-REPORT', '#EXT-X-SKIP'].includes(tag)) {
    fail('不支援低延遲或部分更新的 HLS 串流。');
  }
  if (tag === '#EXT-X-I-FRAMES-ONLY' || tag === '#EXT-X-I-FRAME-STREAM-INF') fail('不支援只有關鍵影格的串流。');
  if (tag === '#EXT-X-GAP') fail('串流缺少片段，無法完整備份。');
}

/**
 * Parse an already obtained playlist; validate all referenced URLs without
 * following them. The caller must constrain redirects to the same host allowlist
 * before sending requests and pass the validated final response URL as baseUrl.
 * A master playlist is only a list of candidates: each selected media playlist
 * must pass this parser before any segment is downloaded.
 */
export function parsePlaylist(text, baseUrl) {
  if (typeof text !== 'string') fail('播放清單必須是文字。');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('播放清單超過 2 MiB 限制。');
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) fail('播放清單包含不支援的控制字元。');
  if (text.includes('{$')) fail('不支援使用變數的播放清單。');
  const base = allowedUrl(baseUrl);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '#EXTM3U') fail('不是有效的 HLS 播放清單：缺少開頭的 #EXTM3U。');
  if (text.replace(/\r\n/g, '').includes('\r')) fail('播放清單的換行格式不正確。');
  const variants = [];
  const segments = [];
  const singleton = new Set();
  let mode = null;
  let pending = null;
  let ended = false;
  let targetDuration = null;
  let totalDuration = 0;
  const useMode = next => {
    if (mode && mode !== next) fail('播放清單混用了主清單與媒體清單格式。');
    mode = next;
  };
  const once = tag => {
    if (singleton.has(tag)) fail('播放清單含有重複的控制標記。');
    singleton.add(tag);
  };

  for (const line of lines.slice(1)) {
    if (!line || (line.startsWith('#') && !line.startsWith('#EXT'))) continue;
    if (line !== line.trim()) fail('播放清單行首或行尾含有不支援的空白。');
    if (!line.startsWith('#')) {
      if (ended) fail('播放清單結束後仍有片段。');
      if (!pending) fail('片段或子清單網址前缺少必要的宣告。');
      const url = allowedUrl(line, base);
      if (pending.type === 'master') {
        variants.push({url: url.href, ...pending.variant});
      } else {
        if (!/\.ts$/i.test(url.pathname)) fail('目前只支援副檔名為 .ts 的 MPEG-TS 片段。');
        if (segments.length >= MAX_SEGMENTS) fail('影片超過 20,000 個片段限制。');
        segments.push({url: url.href, duration: pending.duration});
        totalDuration += pending.duration;
        if (!Number.isFinite(totalDuration) || totalDuration > Number.MAX_SAFE_INTEGER) fail('影片總長度超出支援範圍。');
      }
      pending = null;
      continue;
    }
    const colon = line.indexOf(':');
    const tag = colon === -1 ? line : line.slice(0, colon);
    const payload = colon === -1 ? '' : line.slice(colon + 1);
    blockedTag(tag, payload);
    if (ended) fail('播放清單結束後仍有控制標記。');
    // Legacy cache permission and wall-clock metadata do not change the
    // segment bytes/order. They may appear between EXTINF and its URI.
    // draft-pantos-http-live-streaming-12 §3.4.6; RFC 8216 §4.3.2.6.
    if (tag === '#EXT-X-ALLOW-CACHE') {
      useMode('media');
      once(tag);
      if (payload === 'NO') fail('清單標示 EXT-X-ALLOW-CACHE:NO，不允許保留播放快取；此版本停止備份。');
      if (payload !== 'YES') fail('EXT-X-ALLOW-CACHE 必須是 YES 或 NO。');
      continue;
    }
    if (tag === '#EXT-X-PROGRAM-DATE-TIME') {
      useMode('media');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(payload) || !Number.isFinite(Date.parse(payload))) {
        fail('EXT-X-PROGRAM-DATE-TIME 的日期格式不正確。');
      }
      continue;
    }
    if (pending) fail('片段或子清單宣告後缺少網址，或標記順序不正確。');
    switch (tag) {
      case '#EXT-X-VERSION': {
        once(tag);
        if (integer(payload, 'HLS 版本') > 7) fail('HLS 版本超出目前支援範圍。');
        break;
      }
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        once(tag);
        if (colon !== -1) fail('獨立片段標記格式不正確。');
        break;
      case '#EXT-X-MEDIA': {
        useMode('master');
        const attr = attributes(payload);
        if (attr.TYPE === 'AUDIO') fail('影片使用獨立音軌，目前不支援合併。');
        if (attr.TYPE !== 'SUBTITLES' && attr.TYPE !== 'CLOSED-CAPTIONS') fail('不支援這種替代媒體串流。');
        if (attr.URI !== undefined) allowedUrl(attr.URI, base);
        break;
      }
      case '#EXT-X-STREAM-INF': {
        useMode('master');
        const attr = attributes(payload);
        if (Object.hasOwn(attr, 'AUDIO')) fail('影片使用獨立音軌，目前不支援合併。');
        if (Object.hasOwn(attr, 'VIDEO')) fail('影片使用替代視訊軌，目前不支援合併。');
        if (attr['HDCP-LEVEL'] && attr['HDCP-LEVEL'] !== 'NONE') fail('串流要求內容保護，已停止。');
        const bandwidth = integer(attr.BANDWIDTH, '串流頻寬');
        if (attr['AVERAGE-BANDWIDTH'] !== undefined) integer(attr['AVERAGE-BANDWIDTH'], '平均串流頻寬');
        let width = null;
        let height = null;
        if (attr.RESOLUTION !== undefined) {
          const match = /^(\d+)x(\d+)$/.exec(attr.RESOLUTION);
          if (!match) fail('串流解析度格式不正確。');
          width = integer(match[1], '影片寬度');
          height = integer(match[2], '影片高度');
        }
        pending = {type: 'master', variant: {bandwidth, width, height, label: height ? `${height}p` : `${Math.round(bandwidth / 1000)} kbps`}};
        break;
      }
      case '#EXT-X-TARGETDURATION':
        useMode('media');
        once(tag);
        if (segments.length) fail('片段長度上限必須在第一個片段之前。');
        targetDuration = integer(payload, '片段長度上限');
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        useMode('media');
        once(tag);
        if (segments.length) fail('片段序號必須在第一個片段之前。');
        integer(payload, '片段序號', true);
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        useMode('media');
        once(tag);
        if (segments.length) fail('隨選影片標記必須在第一個片段之前。');
        if (payload !== 'VOD') fail('目前只支援完整 VOD 隨選影片，不支援直播或活動串流。');
        break;
      case '#EXT-X-KEY':
        useMode('media'); // METHOD=NONE was already checked above.
        break;
      case '#EXTINF': {
        useMode('media');
        const match = /^(\d+(?:\.\d+)?),.*$/.exec(payload);
        if (!match) fail('影片片段的時間格式不正確。');
        const duration = Number(match[1]);
        if (!Number.isFinite(duration) || duration <= 0 || duration > Number.MAX_SAFE_INTEGER) fail('影片片段的時間必須是有限正數。');
        if (targetDuration === null || Math.round(duration) > targetDuration) fail('影片片段超過宣告的長度上限，或缺少長度上限。');
        pending = {type: 'media', duration};
        break;
      }
      case '#EXT-X-ENDLIST':
        useMode('media');
        if (colon !== -1) fail('播放清單結束標記格式不正確。');
        ended = true;
        break;
      default:
        // Include only the directive name, never its payload or signed URLs.
        fail(/^#EXT[A-Z0-9-]{1,64}$/.test(tag)
          ? `播放清單包含目前不支援的 HLS 標記：${tag}。`
          : '播放清單包含目前不支援的 HLS 標記。');
    }
  }
  if (pending) fail('播放清單在片段或子清單網址之前中斷。');
  if (mode === 'master') {
    if (!variants.length) fail('主清單沒有可用的影片串流。');
    return {type: 'master', variants};
  }
  if (!ended) fail('播放清單尚未結束，可能是直播；只接受含 #EXT-X-ENDLIST 的完整影片。');
  if (!segments.length || targetDuration === null) fail('播放清單沒有可用的完整影片片段。');
  return {type: 'media', segments, duration: totalDuration};
}
