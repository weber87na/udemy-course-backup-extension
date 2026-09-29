import {lstat, mkdir, open, link, unlink, realpath} from 'node:fs/promises';
import {resolve, dirname, join, relative, isAbsolute, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadPlaylist, saveMedia} from '../extension/transfer.mjs';
import {lectureDownloadPath} from '../extension/batch-core.mjs';
import {checkedMediaUrl, createSessionFetch, SessionNetworkError} from './network.mjs';

export class DownloadError extends Error {
  constructor(message) { super(message); this.name = 'DownloadError'; }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消下載。', 'AbortError');
}

function inside(root, target) {
  const part = relative(root, target);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

async function existing(path) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new DownloadError('無法檢查目的檔案，請確認資料夾權限。'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DownloadError('目的位置不是一般檔案；不會覆寫或跟隨符號連結。');
  if (!stat.size) throw new DownloadError('目的位置已有空白檔案，已保留原檔；請換資料夾或自行處理後重試。');
  return {status: 'skipped', path, bytes: stat.size, segments: 0, verified: false, reason: '已有非空白同名檔案（未驗證），未覆寫。'};
}

async function prepareDirectory(root, directory) {
  await mkdir(root, {recursive: true});
  const canonicalRoot = await realpath(root);
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(canonicalRoot, await realpath(current))) {
      throw new DownloadError('課程輸出資料夾含有符號連結或不安全路徑，已停止。');
    }
  }
}

class AtomicOutput {
  constructor(root, path, signal) {
    this.root = root; this.path = path; this.signal = signal;
    this.temp = null; this.handle = null; this.bytes = 0; this.outcome = null;
  }
  async write(bytes) {
    checkAbort(this.signal);
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new DownloadError('拒絕儲存空白或無效的影片資料。');
    try {
      if (!this.handle) {
        await prepareDirectory(this.root, dirname(this.path));
        checkAbort(this.signal);
        // SaveMedia has already validated this first MPEG-TS segment.
        const temporary = join(dirname(this.path), `.udemy-${randomUUID()}.part`);
        this.handle = await open(temporary, 'wx', 0o600);
        this.temp = temporary;
      }
      let offset = 0;
      while (offset < bytes.length) {
        checkAbort(this.signal);
        const {bytesWritten} = await this.handle.write(bytes.subarray(offset));
        if (!bytesWritten) throw new DownloadError('磁碟未完成寫入，請確認剩餘空間。');
        offset += bytesWritten; this.bytes += bytesWritten;
      }
    } catch (error) {
      checkAbort(this.signal);
      if (error instanceof DownloadError) throw error;
      throw new DownloadError('無法寫入自己的暫存檔案，請確認輸出資料夾與磁碟空間。');
    }
  }
  async close() {
    checkAbort(this.signal);
    if (!this.handle || !this.bytes) throw new DownloadError('影片沒有產生有效資料，未建立正式檔案。');
    try { await this.handle.sync(); await this.handle.close(); this.handle = null; }
    catch { throw new DownloadError('無法完成影片磁碟寫入，未發布正式檔案。'); }
    checkAbort(this.signal);
    try {
      // Hard-link creation is atomic and fails if any destination already exists.
      // Never use rename() here: overwrite behavior differs across platforms.
      await link(this.temp, this.path);
      this.outcome = {status: 'completed', path: this.path, bytes: this.bytes};
    } catch (error) {
      if (error.code === 'EEXIST') {
        this.outcome = await existing(this.path);
        if (!this.outcome) throw new DownloadError('目的檔案在發布時變更，請重新執行。');
      } else throw new DownloadError('無法安全發布影片；輸出磁碟必須支援硬連結，例如本機 NTFS。');
    }
    // After publication, cancellation must not remove the complete destination.
    await this.abort();
  }
  async abort() {
    if (this.handle) { try { await this.handle.close(); } catch { /* retry cleanup below */ } this.handle = null; }
    if (this.temp) {
      try { await unlink(this.temp); this.temp = null; }
      catch (error) { if (error.code === 'ENOENT') this.temp = null; }
    }
  }
}

function variantFor(variants, quality, maxHeight) {
  const height = item => Number.isFinite(item.height) && item.height > 0 ? item.height : 0;
  let candidates = variants.filter(item => item && typeof item.url === 'string');
  if (maxHeight !== undefined) candidates = candidates.filter(item => height(item) && height(item) <= maxHeight);
  else {
    const known = candidates.filter(item => height(item));
    if (known.length) candidates = known;
  }
  if (!candidates.length) throw new DownloadError('沒有符合高度上限的已知影片畫質。');
  candidates.sort((a, b) => height(a) - height(b) || (a.bandwidth || 0) - (b.bandwidth || 0));
  return quality === 'worst' ? candidates[0] : candidates.at(-1);
}

/**
 * Save exactly one clear MPEG-TS VOD lecture. capture.candidates[0].url is the
 * current player HLS URL; URLs/credentials are never written as metadata.
 * best/worst uses declared height then bandwidth; maxHeight is a strict positive
 * integer cap requiring declared height in a master variant. Direct media
 * playlists have unknown height and are rejected when maxHeight is supplied.
 * Existing nonempty files are skipped as unverified; existing zero-byte files
 * cause an error and remain untouched. Only this invocation's random .part is
 * cleaned up. The returned path is absolute.
 */
export async function downloadLecture({capture, item, courseTitle = 'Udemy', courseKey, outputDir, fetcher = createSessionFetch(), signal, quality = 'best', maxHeight, onProgress = () => {}} = {}) {
  if (!['best', 'worst'].includes(quality)) throw new DownloadError('畫質必須是 best 或 worst。');
  if (maxHeight !== undefined && (!Number.isSafeInteger(maxHeight) || maxHeight <= 0)) throw new DownloadError('影片高度上限必須是正整數。');
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new DownloadError('請指定輸出資料夾。');
  if (typeof fetcher !== 'function' || typeof onProgress !== 'function') throw new DownloadError('下載處理函式設定無效。');
  checkAbort(signal);
  const root = resolve(outputDir);
  const path = resolve(root, lectureDownloadPath(item, {courseTitle, courseKey}));
  if (!inside(root, path)) throw new DownloadError('影片輸出位置超出選定資料夾。');
  const found = await existing(path);
  if (found) return found;
  const url = checkedMediaUrl(capture?.candidates?.[0]?.url).href;
  const guardedFetch = async (target, options) => {
    try { return await fetcher(target, options); }
    catch (error) {
      checkAbort(signal);
      if (error instanceof SessionNetworkError) throw error;
      throw new DownloadError('媒體請求失敗，請確認網路及本次瀏覽器登入狀態。');
    }
  };
  const writer = new AtomicOutput(root, path, signal);
  try {
    let media = await loadPlaylist(url, {fetcher: guardedFetch, signal});
    let qualityLabel = '來源畫質（未提供解析度）';
    if (media.type === 'master') {
      const selected = variantFor(media.variants, quality, maxHeight);
      qualityLabel = selected.label;
      media = await loadPlaylist(selected.url, {fetcher: guardedFetch, signal});
      if (media.type !== 'media') throw new DownloadError('不支援巢狀主清單，尚未開始儲存。');
    } else if (maxHeight !== undefined) throw new DownloadError('直接媒體清單未提供可驗證的影片高度，無法確認符合高度上限；若要保留未知來源畫質，請省略 --max-height。');
    checkAbort(signal);
    const result = await saveMedia(media, writer, {fetcher: guardedFetch, signal, onProgress});
    if (!writer.outcome) throw new DownloadError('影片未完成發布。');
    return {...result, ...writer.outcome, qualityLabel};
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DownloadError || error instanceof SessionNetworkError) throw error;
    // Shared HLS/TS validation messages contain no raw URLs; remove any URL that
    // might nevertheless appear in an unexpected external error before returning.
    throw new DownloadError(String(error?.message || '影片下載失敗。').replace(/https?:\/\/\S+/giu, '[網址已隱藏]').slice(0,800));
  } finally { await writer.abort(); }
}
