import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {parseCourseUrl} from './options.mjs';

const adapterSource = readFileSync(new URL('../extension/course-adapter.js', import.meta.url), 'utf8');
const installAdapter = new Function(`${adapterSource}\nreturn globalThis.UdemyCoursePage?.version === 'course-dom-v1';`);
// Keep the last confirmed lecture outside the page realm so a full reload
// cannot erase the manual-navigation guard between batch downloads.
const sessions = new WeakMap();
const abortError = () => new DOMException('已取消操作。', 'AbortError');
function abortCheck(signal) { if (signal?.aborted) throw abortError(); }
function fatal(message) { const error = new Error(message); error.code = 'COURSE_SESSION_LOST'; return error; }
function currentCourse(page) { try { return parseCourseUrl(page.url()); } catch { return null; } }
function safeMessage(value) {
  return String(value || '無法讀取課程資料。').replace(/(?:https?:\/\/|blob:|data:)\S+/gi, '[網址已隱藏]')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 500);
}
function checkCourse(page, expected, {allowLoading = false} = {}) {
  if (page.isClosed()) throw fatal('課程分頁已關閉。');
  const current = currentCourse(page);
  if (!current) {
    if (allowLoading) return false;
    throw fatal('課程分頁已離開指定課程，已停止操作。');
  }
  if (current.courseKey !== expected.courseKey) throw fatal('偵測到手動切換課程，已停止操作。');
  if (!new URL(page.url()).pathname.includes('/learn')) return false;
  return current;
}

async function cancelAdapter(page) {
  // The browser wrapper checks the selected course before and during evaluate.
  let timer;
  try { await Promise.race([page.evaluate(() => globalThis.UdemyCoursePage?.cancel()), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
  catch { /* Page can have closed. */ }
  finally { clearTimeout(timer); }
}

async function deadline(promise, {signal, timeoutMs, page, message}) {
  abortCheck(signal);
  let timer, onAbort, interrupted = false;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => { interrupted = true; reject(abortError()); };
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => { interrupted = true; reject(fatal(message)); }, timeoutMs);
    })]);
  } catch (error) {
    if (interrupted) await cancelAdapter(page);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function adapterCall(page, method, value) {
  const result = await page.evaluate(async (name, argument) => {
    const api = globalThis.UdemyCoursePage;
    if (!api || api.version !== 'course-dom-v1') return {missing: true};
    try { return {ok: true, value: await api[name](argument)}; }
    catch (error) {
      const message = String(error?.message || '無法讀取課程資料。');
      return {ok: false, message};
    }
  }, method, value);
  if (result?.missing) return {missing: true};
  if (!result?.ok) {
    const message = safeMessage(result?.message);
    const error = /手動|課程已變更|目前課程|重新掃描|重新建立|目錄操作已取消/.test(message) ? fatal(message) : new Error(message);
    throw error;
  }
  return result.value;
}

function runtime(options) {
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error('課程等待時間必須介於 1 毫秒與 1 小時。');
  return {timeoutMs, signal: options.signal, now: options.now || Date.now,
    sleep: options.sleep || ((ms, signal) => delay(ms, undefined, {signal})), log: options.log || (() => {})};
}

export async function navigateCourse(session, url, {signal, timeoutMs = 30_000} = {}) {
  abortCheck(signal);
  const expected = parseCourseUrl(url);
  try { await session.page.goto(expected.url, {waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30_000)}); }
  catch (error) { if (error?.name !== 'TimeoutError') throw error; }
  abortCheck(signal);
  // A login redirect is allowed to wait for the user's manual login. Its DOM
  // is never inspected; collection only starts after returning to this course.
  checkCourse(session.page, expected, {allowLoading: true});
}

export async function collectCourse(session, url, options = {}) {
  const expected = parseCourseUrl(url), page = session.page, run = runtime(options);
  const end = run.now() + run.timeoutMs;
  let notice = false;
  while (run.now() < end) {
    abortCheck(run.signal);
    const current = checkCourse(page, expected, {allowLoading: true});
    if (current) {
      try {
        await page.evaluate(installAdapter);
        const ready = await page.evaluate(() => Boolean(document.getElementById('ct-sidebar-scroll-container')?.querySelector('[data-purpose^="section-panel-"]')));
        if (ready) {
          const catalog = await deadline(adapterCall(page, 'collect', expected.url), {signal: run.signal, timeoutMs: Math.max(1, end - run.now()), page,
            message: '課程目錄掃描逾時，請確認課程側欄可正常展開。'});
          checkCourse(page, expected);
          if (catalog?.missing) continue;
          validateCatalog(catalog, expected);
          sessions.set(session, {courseKey: expected.courseKey, lectureId: null});
          return catalog;
        }
      } catch (error) {
        abortCheck(run.signal);
        if (error?.code !== 'PAGE_UNAVAILABLE') throw error;
      }
    }
    if (!notice) { run.log('等待指定課程與內容側欄載入；若出現登入頁，請在本次課程分頁完成登入。'); notice = true; }
    await run.sleep(Math.min(500, Math.max(1, end - run.now())), run.signal);
  }
  throw new Error('等待課程目錄逾時。請確認已登入、課程可存取，並開啟課程內容側欄。');
}

function validateCatalog(catalog, expected) {
  if (!catalog || catalog.courseKey !== expected.courseKey || parseCourseUrl(catalog.pageUrl).courseKey !== expected.courseKey ||
    !Array.isArray(catalog.sections) || typeof catalog.complete !== 'boolean') throw new Error('課程目錄回傳資料不一致，已停止操作。');
  const seen = new Set();
  let total = 0;
  for (const section of catalog.sections) {
    if (!Number.isSafeInteger(section.sectionIndex) || section.sectionIndex < 1 || !Array.isArray(section.items)) throw new Error('課程章節資料不完整，請重新掃描。');
    for (const item of section.items) {
      if (item.courseKey !== expected.courseKey || item.sectionIndex !== section.sectionIndex || item.key !== item.lectureId ||
        !/^[1-9]\d*$/.test(item.lectureId || '') || !item.title || seen.has(item.lectureId)) throw new Error('課程講座資料不一致，請重新掃描。');
      seen.add(item.lectureId); total += 1;
    }
  }
  if (catalog.total !== total || (catalog.complete && (!total || catalog.sections.some(section => section.expectedCount !== section.items.length)))) throw new Error('課程目錄堂數不一致，請重新掃描。');
}

function validateCapture(capture, item, expected, page) {
  const current = checkCourse(page, expected);
  let captured;
  try { captured = parseCourseUrl(capture.pageUrl); }
  catch { throw fatal('播放器與指定講座資料不一致，已停止操作。'); }
  if (current.lectureId !== item.lectureId || captured.lectureId !== item.lectureId || captured.courseKey !== expected.courseKey ||
    capture.lectureId !== item.lectureId || capture.lectureTitle !== item.title || !/^[1-9]\d*$/.test(capture.assetId || '') ||
    !Array.isArray(capture.candidates) || !capture.candidates.length || capture.candidates.length > 12) throw fatal('播放器與指定講座資料不一致，已停止操作。');
  for (const candidate of capture.candidates) {
    let url;
    try { url = new URL(candidate.url); } catch { throw fatal('影片清單來源無效，已停止操作。'); }
    if (url.origin !== expected.origin || url.username || url.password || url.port ||
      !url.pathname.startsWith(`/assets/${capture.assetId}/`) || !/\.m3u8$/i.test(url.pathname)) throw fatal('影片清單與目前播放器不一致，已停止操作。');
  }
  return capture;
}

export async function captureLecture(session, item, options = {}) {
  const page = session.page, run = runtime({...options, timeoutMs: options.timeoutMs ?? 60_000});
  if (!item || item.kind !== 'video' || !item.courseKey || item.key !== item.lectureId || !/^[1-9]\d*$/.test(item.lectureId || '')) throw new Error('請提供目錄中可辨識的影片講座。');
  const expected = parseCourseUrl(`${item.courseKey}/learn/`);
  const before = checkCourse(page, expected);
  const previous = sessions.get(session);
  if (previous?.lectureId && (previous.courseKey !== expected.courseKey || previous.lectureId !== before.lectureId)) throw fatal('偵測到手動切換講座，已停止操作；請重新掃描課程。');
  abortCheck(run.signal);
  const end = run.now() + run.timeoutMs;
  let lastPendingReason = '';
  const captureTimeout = () => `等待影片清單逾時，請確認這堂講座可正常播放。${lastPendingReason ? ` 最後狀態：${lastPendingReason}` : ''}`;
  await page.evaluate(installAdapter);
  if (checkCourse(page, expected).lectureId !== before.lectureId) throw fatal('偵測到手動切換講座，已停止操作；請重新掃描課程。');
  try {
    await deadline(adapterCall(page, 'activate', item), {signal: run.signal, timeoutMs: Math.max(1, end - run.now()), page,
      message: '切換講座逾時，請確認這堂講座可正常播放。'});
  } catch (error) {
    abortCheck(run.signal);
    if (error?.code !== 'PAGE_UNAVAILABLE') throw error;
  }
  try {
    while (run.now() < end) {
      abortCheck(run.signal);
      const current = checkCourse(page, expected);
      if (![before.lectureId, item.lectureId].includes(current.lectureId)) throw fatal('偵測到手動切換講座，已停止操作；請重新掃描課程。');
      try {
        const captured = await deadline(adapterCall(page, 'capture', item), {signal: run.signal, timeoutMs: Math.max(1, end - run.now()), page,
          message: captureTimeout()});
        if (captured?.missing) {
          // Full navigation loses the adapter. Reinstall and let its two-poll
          // DOM/asset guard validate readiness, without clicking the row again.
          await page.evaluate(installAdapter);
        } else if (captured?.status === 'ready') {
          const result = validateCapture(captured, item, expected, page);
          sessions.set(session, {courseKey: expected.courseKey, lectureId: item.lectureId});
          return result;
        }
        else if (captured?.status === 'pending') {
          if (typeof captured.reason === 'string' && captured.reason.trim()) lastPendingReason = safeMessage(captured.reason);
        } else throw new Error('影片播放器回傳未知狀態，已停止操作。');
      } catch (error) {
        abortCheck(run.signal);
        if (error?.code !== 'PAGE_UNAVAILABLE') throw error;
      }
      await run.sleep(Math.min(500, Math.max(1, end - run.now())), run.signal);
    }
    throw fatal(captureTimeout());
  } catch (error) {
    await cancelAdapter(page);
    if (error?.name !== 'AbortError') {
      const current = checkCourse(page, expected);
      if (![before.lectureId, item.lectureId].includes(current.lectureId)) throw fatal('偵測到手動切換講座，已停止操作；請重新掃描課程。');
    }
    throw error;
  }
}
