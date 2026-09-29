import {readSelectedMedia} from './batch-io.mjs';
import {readResource, validateTransportStream} from './transfer.mjs';

// Only exact parser errors that establish an unsupported feature are negative
// evidence. Malformed responses, size limits and transport failures stay unknown.
const encryptedMessages = new Set([
  '清單包含工作階段金鑰，已停止；不支援加密或 DRM。',
  '影片串流已加密，已停止；不讀取金鑰、不解密，也不處理 DRM。'
]);
const formatMessages = new Set([
  '不支援 fMP4 或需要初始化片段的串流。',
  '不支援以位元組範圍儲存的串流。',
  '串流含有不連續片段，目前不支援。',
  '不支援使用變數的播放清單。',
  '不支援低延遲或部分更新的 HLS 串流。',
  '不支援只有關鍵影格的串流。',
  '清單標示 EXT-X-ALLOW-CACHE:NO，不允許保留播放快取；此版本停止備份。',
  'HLS 版本超出目前支援範圍。',
  '影片使用獨立音軌，目前不支援合併。',
  '不支援這種替代媒體串流。',
  '影片使用替代視訊軌，目前不支援合併。',
  '串流要求內容保護，已停止。',
  '目前只支援完整 VOD 隨選影片，不支援直播或活動串流。',
  '目前只支援副檔名為 .ts 的 MPEG-TS 片段。',
  '此課程使用巢狀串流清單，暫不支援。'
]);

function declaredAttributes(line, tag) {
  if (!line.startsWith(`${tag}:`)) return null;
  const payload = line.slice(tag.length + 1), attributes = {};
  let position = 0;
  while (position < payload.length) {
    const match = /^([A-Z0-9-]+)=("[^"\r\n]*"|[^\s,"]+)(,|$)/.exec(payload.slice(position));
    if (!match || Object.hasOwn(attributes, match[1])) return null;
    attributes[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
    position += match[0].length;
    if (match[3] && position === payload.length) return null;
  }
  return position > 0 ? attributes : null;
}

function declaredEncryption(text) {
  for (const line of text.split(/\r?\n/)) {
    const tag = line.split(':', 1)[0];
    if (!['#EXT-X-KEY', '#EXT-X-SESSION-KEY'].includes(tag)) continue;
    const attributes = declaredAttributes(line, tag);
    if (tag === '#EXT-X-KEY' && attributes?.METHOD === 'NONE') continue;
    return Boolean(attributes && ['AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(attributes.METHOD) &&
      attributes.URI && (!attributes.IV || /^0x[0-9a-f]+$/i.test(attributes.IV)));
  }
  return false;
}

function supportedFormatEvidence(message, text) {
  const lines = text.split(/\r?\n/);
  const attributesFor = tag => lines.map(line => declaredAttributes(line, tag)).filter(Boolean);
  const firstAttributes = tag => declaredAttributes(lines.find(line => line === tag || line.startsWith(`${tag}:`)) || '', tag);
  switch (message) {
    case '不支援 fMP4 或需要初始化片段的串流。': return Boolean(firstAttributes('#EXT-X-MAP')?.URI);
    case '不支援以位元組範圍儲存的串流。': return lines.some(line => /^#EXT-X-BYTERANGE:[1-9]\d*(?:@\d+)?$/.test(line));
    case '串流含有不連續片段，目前不支援。': return lines.some(line => line === '#EXT-X-DISCONTINUITY' || /^#EXT-X-DISCONTINUITY-SEQUENCE:\d+$/.test(line));
    case '不支援使用變數的播放清單。': return attributesFor('#EXT-X-DEFINE').some(attributes => attributes.IMPORT || (attributes.NAME && attributes.VALUE));
    case '不支援低延遲或部分更新的 HLS 串流。': return false;
    case '不支援只有關鍵影格的串流。': return lines.includes('#EXT-X-I-FRAMES-ONLY') || attributesFor('#EXT-X-I-FRAME-STREAM-INF').some(attributes => attributes.URI && /^[1-9]\d*$/.test(attributes.BANDWIDTH || ''));
    case '不支援這種替代媒體串流。': return attributesFor('#EXT-X-MEDIA').some(attributes => attributes.TYPE === 'VIDEO');
    case '串流要求內容保護，已停止。': return attributesFor('#EXT-X-STREAM-INF').some(attributes => ['TYPE-0', 'TYPE-1'].includes(attributes['HDCP-LEVEL']));
    case '目前只支援完整 VOD 隨選影片，不支援直播或活動串流。': return lines.includes('#EXT-X-PLAYLIST-TYPE:EVENT');
    default: return formatMessages.has(message);
  }
}

export async function probeHls(capture, {signal, fetcher = fetch, permissionCheck} = {}) {
  if (signal?.aborted) return {status: 'unknown', reason: 'cancelled'};
  if (!capture || !Array.isArray(capture.candidates) || !capture.candidates.length || capture.candidates.length > 12 ||
      typeof capture.candidates[0]?.url !== 'string') return {status: 'unknown', reason: 'source-unconfirmed'};
  let stage = 'playlist', lastEvent = null, transportFailed = false;
  let playlistChunks = [], playlistLength = 0;
  const playlistText = () => {
    if (playlistLength < 0) return '';
    const bytes = new Uint8Array(playlistLength);
    let offset = 0;
    for (const chunk of playlistChunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return ''; }
  };
  // Observe the same bounded playlist response already consumed by the parser.
  // This makes negative classifications depend on an actual declaration, never
  // an error string supplied by a network failure. No additional fetch occurs.
  const observePlaylist = response => {
    playlistChunks = []; playlistLength = 0;
    if (!response?.body) return response;
    return {ok: response.ok, status: response.status, url: response.url, redirected: response.redirected, headers: response.headers,
      body: {getReader() {
        const reader = response.body.getReader();
        return {
          async read() {
            const next = await reader.read();
            if (!next.done && playlistLength >= 0) {
              if (playlistLength + next.value.length > 2 * 1024 * 1024) { playlistChunks = []; playlistLength = -1; }
              else { playlistChunks.push(next.value); playlistLength += next.value.length; }
            }
            return next;
          },
          cancel: reason => reader.cancel(reason),
          releaseLock: () => reader.releaseLock()
        };
      }}
    };
  };
  const options = {
    signal,
    fetcher: async (...args) => {
      try { const response = await fetcher(...args); return stage === 'playlist' ? observePlaylist(response) : response; }
      catch (error) { transportFailed = true; throw error; }
    },
    permissionCheck: permissionCheck ? async (...args) => {
      try { return await permissionCheck(...args); }
      catch (error) { transportFailed = true; throw error; }
    } : undefined,
    onDiagnostic: event => { lastEvent = event; }
  };
  try {
    const {media} = await readSelectedMedia(capture, 'best', options);
    if (signal?.aborted) return {status: 'unknown', reason: 'cancelled'};
    stage = 'segment-fetch';
    const bytes = await readResource(media.segments[0].url, {...options, maxBytes: 64 * 1024 * 1024,
      phase: 'segment', segmentIndex: 1, totalSegments: media.segments.length});
    stage = 'segment-validate';
    validateTransportStream(bytes);
    if (signal?.aborted) return {status: 'unknown', reason: 'cancelled'};
    return {status: 'downloadable', reason: 'hls-supported'};
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return {status: 'unknown', reason: 'cancelled'};
    if (lastEvent?.code === 'TIMEOUT') return {status: 'unknown', reason: 'timeout'};
    const message = typeof error?.message === 'string' ? error.message : '';
    if (stage === 'playlist' && !transportFailed && lastEvent?.code === 'READ_OK') {
      const text = playlistText();
      if (encryptedMessages.has(message) && declaredEncryption(text)) return {status: 'unsupported', reason: 'encrypted'};
      if (formatMessages.has(message) && supportedFormatEvidence(message, text)) return {status: 'unsupported', reason: 'unsupported-format'};
    }
    if (stage === 'segment-validate' && message === '影片封包標示加密，已停止儲存；此工具不處理解密。') {
      return {status: 'unsupported', reason: 'encrypted'};
    }
    if (transportFailed || lastEvent?.stage === 'permission' || lastEvent?.code !== 'READ_OK') {
      return {status: 'unknown', reason: 'network'};
    }
    return {status: 'unknown', reason: 'source-unconfirmed'};
  }
}
