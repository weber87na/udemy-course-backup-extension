const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class SessionNetworkError extends Error {
  constructor(message) { super(message); this.name = 'SessionNetworkError'; }
}

const cancelled = () => new DOMException('已取消下載。', 'AbortError');

/** Validate before any request, including each redirect destination. */
export function checkedMediaUrl(value, base) {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionNetworkError('媒體網址格式無效。');
  }
  let url;
  try { url = base === undefined ? new URL(value) : new URL(value, base); }
  catch { throw new SessionNetworkError('媒體網址格式無效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !/(^|\.)(udemy\.com|udemycdn\.com)$/i.test(url.hostname)) {
    throw new SessionNetworkError('媒體請求只接受沒有帳密或自訂連接埠的 HTTPS Udemy／Udemy CDN 網址。');
  }
  return url;
}

function cookieHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.some(cookie =>
    !cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) ||
    !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(cookie.value))) {
    throw new SessionNetworkError('瀏覽器回傳的登入狀態格式無效。');
  }
  const value = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  if (value.length > 65536) throw new SessionNetworkError('瀏覽器登入狀態超過支援大小。');
  return value;
}

function discard(response) {
  try { void Promise.resolve(response?.body?.cancel()).catch(() => {}); }
  catch { /* Body is already locked or closed. */ }
}

/**
 * Cookies are obtained by URL from this run's browser session, and are sent only
 * to the exact selected Udemy origin. CDN and other Udemy origins get none.
 * Caller headers/body are forbidden. Each request uses redirect:'manual'; every
 * redirect is validated before fetching. Deadlines include response consumption.
 */
export function createSessionFetch({getCookies, authOrigin, fetchImpl = globalThis.fetch, maxRedirects = 5, timeoutMs = 45000} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SessionNetworkError('下載網路設定無效。');
  let selectedOrigin = null;
  if (authOrigin !== undefined && authOrigin !== null) {
    const selected = checkedMediaUrl(authOrigin);
    if (!/(^|\.)udemy\.com$/i.test(selected.hostname) || selected.pathname !== '/' || selected.search || typeof getCookies !== 'function') {
      throw new SessionNetworkError('登入來源必須是本次瀏覽器選取的 Udemy HTTPS origin。');
    }
    selectedOrigin = selected.origin;
  }
  return async (input, options = {}) => {
    const targetStart = checkedMediaUrl(input);
    if (options.headers != null || options.body != null || !['GET', 'HEAD'].includes(options.method || 'GET')) {
      throw new SessionNetworkError('下載僅支援 GET／HEAD，且不可附加自訂標頭或請求內容。');
    }
    if (options.signal?.aborted) throw cancelled();
    const controller = new AbortController();
    let reader, streamController, finished = false, failure;
    let rejectInterrupted;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    void interrupted.catch(() => {});
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const cancelReader = () => {
      try { void Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* already closed */ }
    };
    const interrupt = error => {
      if (finished) return;
      failure = error;
      controller.abort();
      rejectInterrupted(error);
      try { streamController?.error(error); } catch { /* already closed */ }
      cancelReader();
      cleanup();
    };
    const abort = () => interrupt(cancelled());
    const timer = setTimeout(() => interrupt(new SessionNetworkError('媒體請求逾時，請檢查連線後重試。')), timeoutMs);
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) abort();
    const wait = async promise => {
      const pending = Promise.resolve(promise);
      if (failure) { void pending.catch(() => {}); throw failure; }
      return Promise.race([pending, interrupted]);
    };
    let target = targetStart;
    let response;
    try {
      for (let redirects = 0; ; redirects++) {
        if (failure) throw failure;
        const headers = new Headers();
        if (target.origin === selectedOrigin) {
          let cookies;
          try { cookies = await wait(Promise.resolve().then(() => getCookies(target.href))); }
          catch {
            if (failure) throw failure;
            throw new SessionNetworkError('無法讀取本次瀏覽器工作階段的登入狀態。');
          }
          const value = cookieHeader(cookies);
          if (value) headers.set('cookie', value);
        }
        try {
          response = await wait(Promise.resolve().then(() => fetchImpl(target.href, {
            method: options.method || 'GET', headers, signal: controller.signal,
            redirect: 'manual', credentials: 'omit', cache: 'no-store'
          })).then(value => {
            // A transport may settle after cancellation despite its signal.
            if (failure) discard(value);
            return value;
          }));
        } catch {
          if (failure) throw failure;
          throw new SessionNetworkError('媒體網路請求失敗，請檢查連線後重試。');
        } finally { headers.delete('cookie'); }
        if (failure) { discard(response); throw failure; }
        if (!response || !Number.isInteger(response.status) || !response.headers?.get) {
          throw new SessionNetworkError('伺服器回應格式無效。');
        }
        // A real manual fetch cannot silently change the response URL. Reject a
        // custom transport that violates that contract rather than hiding it.
        if (response.redirected || (response.url && checkedMediaUrl(response.url).href !== target.href)) {
          throw new SessionNetworkError('網路層未遵守逐次檢查重新導向的規則。');
        }
        if (REDIRECTS.has(response.status)) {
          const location = response.headers.get('location');
          discard(response);
          if (redirects >= maxRedirects) throw new SessionNetworkError('媒體重新導向超過五次或設定上限。');
          if (!location) throw new SessionNetworkError('媒體重新導向缺少目的網址。');
          target = checkedMediaUrl(location, target);
          continue;
        }
        if (response.status === 206) throw new SessionNetworkError('伺服器只回傳部分內容，無法確認完整性。');
        let body = null;
        if (response.body) {
          if (typeof response.body.getReader !== 'function') throw new SessionNetworkError('媒體回應沒有可讀取的串流。');
          reader = response.body.getReader();
          body = new ReadableStream({
            start(value) { streamController = value; },
            async pull(destination) {
              try {
                const next = await wait(reader.read());
                if (next.done) {
                  destination.close(); cleanup(); reader.releaseLock();
                } else destination.enqueue(next.value);
              } catch {
                const error = failure || new SessionNetworkError('媒體內容中途讀取失敗。');
                try { destination.error(error); } catch { /* already errored */ }
                controller.abort(); cancelReader(); cleanup();
              }
            },
            cancel() { controller.abort(); cancelReader(); cleanup(); }
          });
        } else cleanup();
        const result = new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
        Object.defineProperties(result, {url: {value: target.href}, redirected: {value: redirects > 0}});
        return result;
      }
    } catch (error) {
      controller.abort(); discard(response); cleanup();
      if (failure) throw failure;
      if (error instanceof SessionNetworkError) throw error;
      throw new SessionNetworkError('媒體請求未完成，請檢查登入狀態及連線。');
    }
  };
}
