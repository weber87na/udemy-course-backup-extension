import {parseCourseUrl} from './options.mjs';

const CONNECT_HELP = '無法連接目前的 Chrome。請使用 Chrome 144 以上版本，手動啟用 Chrome 的遠端偵錯，並在原生連線提示按「允許」後重試。';
const abortError = () => new DOMException('已取消操作。', 'AbortError');
const abortCheck = signal => { if (signal?.aborted) throw abortError(); };
const ignore = async operation => { try { await operation(); } catch { /* Already detached or closed. */ } };

function sameCourse(raw, expected) {
  try { return parseCourseUrl(raw).courseKey === expected.courseKey; } catch { return false; }
}

async function bounded(promise, {signal, timeoutMs, late = async () => {}}) {
  let expired = false, delivered = false, resolved = false, result, cleanup, timer, onAbort;
  const discard = value => cleanup ||= ignore(() => late(value));
  const pending = Promise.resolve(promise).then(async value => {
    resolved = true; result = value;
    if (expired) { await discard(value); return undefined; }
    return value;
  });
  try {
    const value = await Promise.race([pending, new Promise((_, reject) => {
      onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => reject(new Error(CONNECT_HELP)), timeoutMs);
    })]);
    delivered = true;
    return value;
  } finally {
    expired = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!delivered && resolved) await discard(result);
  }
}

// Both guards are needed: navigation can happen between the Node check and
// execution in Chrome. The supplied function is trusted CLI code, not page text.
function guardedEvaluation(fn, expected) {
  if (typeof fn !== 'function') throw new Error('只允許執行課程工具提供的頁面函式。');
  return new Function('...args', `
    const current = new URL(location.href);
    const match = /^\\/course\\/([^/]+)\\/learn(?:\\/lecture\\/[1-9]\\d*)?\\/?$/.exec(current.pathname);
    if (current.origin !== ${JSON.stringify(expected.origin)} || current.username || current.password || !match || match[1] !== ${JSON.stringify(expected.slug)}) {
      throw new Error('目前分頁不是本次指定的課程播放頁。');
    }
    return (${Function.prototype.toString.call(fn)})(...args);
  `);
}

/** Use Puppeteer's Chrome 144+ discovery and native permission flow, without custom endpoints or credential-file access. */
export async function launchSession({url, browser: mode = 'existing', signal, timeoutMs = 600_000, log = () => {}} = {},
  {loadPuppeteer = () => import('puppeteer-core')} = {}) {
  const expected = parseCourseUrl(url);
  if (mode !== 'existing') throw new Error('目前只支援 --browser existing，請使用已登入的 Chrome。');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error('連線等待時間必須介於 1 毫秒與 1 小時。');
  abortCheck(signal);
  let puppeteer;
  try {
    const loaded = await loadPuppeteer();
    puppeteer = typeof loaded.connect === 'function' ? loaded : loaded.default;
    if (typeof puppeteer?.connect !== 'function') throw new Error();
  } catch {
    abortCheck(signal);
    throw new Error('找不到 Puppeteer。請先在專案資料夾執行 npm install。');
  }
  abortCheck(signal);
  log('請在目前 Chrome 的原生連線提示按「允許」。工具只建立及關閉本次的課程分頁。');
  let browser;
  try {
    browser = await bounded(puppeteer.connect({
      channel: 'chrome', defaultViewport: null, networkEnabled: false, issuesEnabled: false,
      protocolTimeout: Math.min(timeoutMs, 30_000),
      targetFilter(target) {
        try {
          if (target.type() === 'browser') return true;
          return ['page', 'tab'].includes(target.type()) &&
            (target.url() === '' || target.url() === 'about:blank' || sameCourse(target.url(), expected));
        } catch { return false; }
      },
    }), {signal, timeoutMs, late: instance => instance.disconnect()});
    abortCheck(signal);
  } catch {
    if (browser) await ignore(() => browser.disconnect());
    abortCheck(signal);
    throw new Error(CONNECT_HELP);
  }

  let rawPage, pendingPage, client, pendingClient, closed = false, closePromise, disconnectPromise;
  const pageCleanup = new WeakMap();
  const disconnect = () => disconnectPromise ||= ignore(() => browser.disconnect());
  const closePage = page => {
    if (!pageCleanup.has(page)) pageCleanup.set(page, ignore(() => page.close({runBeforeUnload: false})));
    return pageCleanup.get(page);
  };
  const onAbort = () => { void close(); };
  const close = () => {
    if (!closePromise) {
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      closePromise = (async () => {
        if (client) await ignore(() => client.detach());
        if (rawPage) {
          await closePage(rawPage);
          await disconnect();
        } else if (pendingPage) {
          // newPage can resolve after cancellation. Keep the connection briefly
          // so its eventual page can be closed, never any pre-existing tab.
          const fallback = setTimeout(() => { void disconnect(); }, Math.min(timeoutMs, 30_000));
          fallback.unref?.();
          void pendingPage.then(async page => { await closePage(page); await disconnect(); }, disconnect)
            .finally(() => clearTimeout(fallback));
        } else await disconnect();
      })();
    }
    return closePromise;
  };
  signal?.addEventListener('abort', onAbort, {once: true});
  const checkOpen = () => {
    abortCheck(signal);
    if (closed || !rawPage || rawPage.isClosed()) {
      const error = new Error('課程瀏覽器工作階段已關閉。');
      error.code = 'COURSE_SESSION_LOST'; throw error;
    }
  };
  const checkPage = () => {
    checkOpen();
    if (!sameCourse(rawPage.url(), expected) || !new URL(rawPage.url()).pathname.includes('/learn')) {
      const error = new Error('目前分頁不是本次指定的課程播放頁。');
      error.code = 'COURSE_SESSION_LOST';
      throw error;
    }
  };
  try {
    abortCheck(signal);
    pendingPage = Promise.resolve().then(() => { abortCheck(signal); return browser.newPage(); });
    rawPage = await bounded(pendingPage, {signal, timeoutMs: Math.min(timeoutMs, 30_000), late: closePage});
    abortCheck(signal);
    if (closed) throw new Error();
    const page = Object.freeze({
      url: () => rawPage.url(),
      isClosed: () => closed || rawPage.isClosed(),
      async goto(target, options = {}) {
        checkOpen();
        if (!sameCourse(target, expected)) throw new Error('只能開啟本次指定的 Udemy 課程。');
        try {
          await rawPage.goto(parseCourseUrl(target).url, {waitUntil: 'domcontentloaded', timeout: Math.min(options.timeout || 30_000, 30_000)});
        } catch (error) {
          abortCheck(signal);
          const failure = new Error('無法開啟指定課程頁，請確認登入狀態及網路。');
          if (error?.name === 'TimeoutError') failure.name = 'TimeoutError';
          throw failure;
        }
      },
      async evaluate(fn, ...args) {
        checkPage();
        try { return await rawPage.evaluate(guardedEvaluation(fn, expected), ...args); }
        catch {
          abortCheck(signal);
          const failure = new Error('課程頁正在切換或無法讀取，請確認課程仍可正常播放。');
          failure.code = 'PAGE_UNAVAILABLE';
          throw failure;
        }
      },
    });
    return Object.freeze({
      page,
      async getCookies(target) {
        checkPage();
        let cookieUrl;
        try { cookieUrl = new URL(target); } catch { throw new Error('登入資料的請求網址無效。'); }
        if (cookieUrl.protocol !== 'https:' || cookieUrl.username || cookieUrl.password || cookieUrl.port) throw new Error('登入資料的請求網址無效。');
        // CDN requests receive no profile cookies. Chrome filters same-origin
        // cookies by the exact request URL (including path/security rules).
        if (cookieUrl.origin !== expected.origin) return [];
        try {
          if (!pendingClient) pendingClient = Promise.resolve(rawPage.createCDPSession()).then(async value => {
            if (closed) { await ignore(() => value.detach()); throw new Error(); }
            client = value;
            return value;
          });
          const connection = await pendingClient;
          checkPage();
          const result = await connection.send('Network.getCookies', {urls: [cookieUrl.href]});
          checkPage();
          if (!Array.isArray(result?.cookies)) throw new Error();
          return result.cookies;
        } catch {
          abortCheck(signal);
          throw new Error('無法取得本次課程請求的登入狀態。');
        }
      },
      close,
    });
  } catch {
    await close();
    abortCheck(signal);
    throw new Error('無法建立課程分頁。請保持 Chrome 開啟並允許本次連線後重試。');
  }
}
