// No network or storage access: UI code owns both and passes work into runQueue.
const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'skipped']);
const SAFE_KEY = /^[A-Za-z0-9._:-]{1,256}$/;

function shortText(value, limit, fallback = '') {
  const text = String(value ?? '').normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/\p{Surrogate}/gu, '_').trim();
  let result = '';
  for (const char of text) {
    if (result.length + char.length > limit) break;
    result += char;
  }
  return result || fallback;
}

function pathPart(value, limit, fallback) {
  let text = shortText(value, limit * 2, fallback)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  text = shortText(text, limit, fallback).replace(/[. ]+$/g, '') || fallback;
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(text)) text = '_' + text;
  return text;
}

function ordinal(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function stableHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * A relative path of exactly three components, safe for Windows/Chrome file APIs.
 * Indexes are one-based. Original key + lecture ID participate in the suffix,
 * so duplicate/truncated/sanitized titles cannot silently overwrite each other.
 */
export function lectureDownloadPath(item, {courseTitle = 'Udemy', courseKey, extension = 'ts'} = {}) {
  if (!item || typeof item !== 'object') throw new TypeError('缺少講座資訊。');
  if (typeof extension !== 'string' || !/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('檔案副檔名格式不正確。');
  const key = String(item.key ?? '');
  const id = String(item.lectureId ?? item.id ?? key);
  if (!key && !id) throw new Error('講座缺少穩定識別碼。');
  const section = String(ordinal(item.sectionIndex)).padStart(2, '0');
  const lecture = String(ordinal(item.lectureIndex ?? item.index)).padStart(3, '0');
  // The full identity survives title truncation, including a slug placed at its end.
  const course = `${pathPart(courseTitle, 48, 'Udemy')} [${stableHash(String(courseKey ?? courseTitle))}]`;
  const folder = `${section} - ${pathPart(item.sectionTitle, 42, '課程章節')}`;
  const title = pathPart(item.lectureTitle ?? item.title, 48, '講座');
  const identity = pathPart(id, 20, 'lecture');
  const hash = stableHash(`${key}\u0000${id}`);
  return `${course}/${folder}/${lecture} - ${title} [${identity}-${hash}].${extension}`;
}

function height(variant) {
  return typeof variant.height === 'number' && Number.isFinite(variant.height) && variant.height > 0 ? variant.height : 0;
}

function bandwidth(variant) {
  return typeof variant.bandwidth === 'number' && Number.isFinite(variant.bandwidth) && variant.bandwidth > 0 ? variant.bandwidth : 0;
}

/**
 * Return the original variant object (or null), without sorting/mutating input.
 * Best: greatest known height, then bandwidth. Capped: greatest known height
 * <= cap; if none, smallest known height. Unknown heights are a fallback only.
 */
export function chooseVariant(variants, quality = 'best') {
  if (!['best', '1080', '720', '480'].includes(quality)) throw new Error('不支援的畫質選項。');
  if (!Array.isArray(variants)) throw new TypeError('畫質清單必須是陣列。');
  const all = variants.filter(variant => variant && typeof variant === 'object');
  if (!all.length) return null;
  const known = all.filter(variant => height(variant));
  let pool;
  let ascending = false;
  if (quality === 'best') pool = known.length ? known : all;
  else {
    const eligible = known.filter(variant => height(variant) <= Number(quality));
    pool = eligible.length ? eligible : known.length ? known : all;
    ascending = !eligible.length;
  }
  const direction = ascending ? 1 : -1;
  return pool.reduce((chosen, variant) => {
    const order = (height(variant) - height(chosen) || bandwidth(variant) - bandwidth(chosen)) * direction;
    return order < 0 ? variant : chosen;
  });
}

function metadataText(value, limit) {
  // Titles may themselves contain links. Do not persist those links or tokens.
  return shortText(String(value ?? '').replace(/\b(?:https?:\/\/|blob:|data:)[^\s]+/giu, '[網址略]'), limit);
}

/**
 * JSON-safe metadata only. No URLs, candidates, result, reason or error objects.
 * A saved "running" item becomes "queued" so reloading can resume unfinished work.
 * Invalid keys are omitted, rather than persisting a possible URL/token as a key.
 */
export function safeQueueSnapshot(items) {
  if (!Array.isArray(items)) throw new TypeError('下載佇列必須是陣列。');
  return items.filter(item => item && typeof item.key === 'string' && SAFE_KEY.test(item.key)).map(item => {
    const saved = {
      key: item.key,
      selected: item.selected !== false,
      status: STATUSES.has(item.status) && item.status !== 'running' ? item.status : 'queued'
    };
    for (const field of ['title', 'lectureTitle', 'sectionTitle']) {
      if (typeof item[field] === 'string') saved[field] = metadataText(item[field], 300);
    }
    for (const field of ['sectionIndex', 'lectureIndex', 'index']) {
      if (Number.isSafeInteger(item[field]) && item[field] >= 0) saved[field] = item[field];
    }
    for (const field of ['lectureId', 'id']) {
      if (Number.isSafeInteger(item[field]) && item[field] >= 0) saved[field] = item[field];
      else if (typeof item[field] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item[field])) saved[field] = item[field];
    }
    return saved;
  });
}

/**
 * Sequentially mutate items through queued -> running -> completed/failed/skipped.
 * processItem(item, {signal}) must resolve {status:'completed'|'skipped', ...}.
 * It owns resource cleanup, and must honor signal. Completion is recorded only
 * after it resolves. Its result and errors are kept in memory, never snapshot.
 * onUpdate({item, items, cancelled}) is awaited; observer errors do not change
 * transfer outcomes. A null item reports cancellation before any work starts.
 *
 * Cancellation immediately prevents the next item and propagates to processItem.
 * Await current cleanup before returning {items,cancelled}; an aborted unfinished
 * item returns to queued. A successfully committed item stays completed even if
 * cancellation arrived during its final close. Already completed/skipped keys
 * never run again. Failed items retry on the next explicit runQueue call.
 */
export async function runQueue(items, {signal, processItem, onUpdate = () => {}} = {}) {
  if (!Array.isArray(items)) throw new TypeError('下載佇列必須是陣列。');
  if (typeof processItem !== 'function') throw new TypeError('缺少講座處理函式。');
  if (typeof onUpdate !== 'function') throw new TypeError('更新回呼必須是函式。');
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !SAFE_KEY.test(item.key)) throw new Error('講座缺少有效的佇列識別碼。');
  }
  let cancelled = Boolean(signal?.aborted);
  const abort = () => { cancelled = true; };
  signal?.addEventListener('abort', abort, {once: true});
  const notify = async item => {
    try { await onUpdate({item, items, cancelled}); }
    catch { /* UI/storage observer failures cannot undo a committed download. */ }
  };
  const handled = new Map();
  for (const item of items) {
    if (item.status === 'completed' || (item.status === 'skipped' && !handled.has(item.key))) handled.set(item.key, item.status);
    else if (!STATUSES.has(item.status) || item.status === 'running') item.status = 'queued';
  }
  try {
    if (cancelled) await notify(null);
    for (const item of items) {
      if (cancelled || signal?.aborted) { cancelled = true; break; }
      if (item.selected === false || item.status === 'completed' || item.status === 'skipped') continue;
      if (handled.has(item.key)) {
        item.status = handled.get(item.key);
        if (item.status === 'failed') item.error = '同一講座本次執行失敗，請重新嘗試。';
        item.reason = '同一講座已在佇列中處理。';
        await notify(item);
        continue;
      }
      delete item.error;
      delete item.reason;
      delete item.result;
      item.status = 'running';
      await notify(item);
      if (cancelled || signal?.aborted) {
        cancelled = true;
        item.status = 'queued';
        await notify(item);
        break;
      }
      try {
        const result = await processItem(item, {signal});
        if (!result || !['completed', 'skipped'].includes(result.status)) throw new Error('講座處理未回報完成或略過狀態。');
        item.status = result.status;
        item.result = result;
        if (typeof result.reason === 'string') item.reason = result.reason;
        handled.set(item.key, item.status);
      } catch (error) {
        if (cancelled || signal?.aborted || error?.name === 'AbortError') {
          cancelled = true;
          item.status = 'queued';
        } else {
          item.status = 'failed';
          item.error = typeof error?.message === 'string' ? error.message : '講座下載失敗，請重新嘗試。';
          handled.set(item.key, 'failed');
        }
      }
      await notify(item);
      if (cancelled || signal?.aborted) { cancelled = true; break; }
    }
    return {items, cancelled};
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
