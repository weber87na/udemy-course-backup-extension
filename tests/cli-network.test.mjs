import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionFetch, checkedMediaUrl} from '../cli/network.mjs';

const authOrigin = 'https://www.udemy.com';
const cdn = 'https://stream.udemycdn.com';
const response = (body = '#EXTM3U', options) => new Response(body, options);
const redirect = location => response('', {status: 302, headers: {location}});
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise, resolve};
}

test('session cookies stay on the exact selected Udemy origin through every redirect', async () => {
  const calls = [], cookieUrls = [];
  const urls = [`${authOrigin}/start`, `${authOrigin}/path/list.m3u8`, `${cdn}/video/list.m3u8`, 'https://udemy.com/different-origin', `${authOrigin}/finish.m3u8`];
  const fetcher = createSessionFetch({authOrigin,
    getCookies: async url => { cookieUrls.push(url); return [{name: 'auth', value: 'private-cookie'}]; },
    fetchImpl: async (url, options) => {
      calls.push({url, cookie: options.headers.get('cookie'), redirect: options.redirect, credentials: options.credentials});
      const next = urls[urls.indexOf(url) + 1];
      return next ? redirect(next) : response('finished');
    }
  });
  const result = await fetcher(urls[0], {redirect: 'follow', credentials: 'include'});
  assert.equal(await result.text(), 'finished');
  assert.equal(result.url, urls.at(-1));
  assert.equal(result.redirected, true);
  assert.deepEqual(cookieUrls, [urls[0], urls[1], urls[4]]);
  assert.deepEqual(calls.map(call => call.cookie), ['auth=private-cookie', 'auth=private-cookie', null, null, 'auth=private-cookie']);
  assert.ok(calls.every(call => call.redirect === 'manual' && call.credentials === 'omit'));
});

test('relative redirects preserve the actual final URL as the playlist base', async () => {
  const fetcher = createSessionFetch({fetchImpl: async url => url.endsWith('/old.m3u8') ? redirect('/new/final.m3u8?own=yes') : response('ok')});
  const result = await fetcher(`${cdn}/old.m3u8`);
  assert.equal(result.url, `${cdn}/new/final.m3u8?own=yes`);
  assert.equal(await result.text(), 'ok');
});

test('forbidden initial URLs are rejected before any network or cookie read', async () => {
  let calls = 0;
  const fetcher = createSessionFetch({authOrigin, getCookies: async () => { calls++; return []; }, fetchImpl: async () => { calls++; return response(); }});
  for (const url of [
    'http://www.udemy.com/a', 'https://udemy.com.evil.test/a', 'https://fakeudemycdn.com/a',
    'https://www.udemy.com:444/a', 'https://user:pass@www.udemy.com/a', 'https://evil.test/a',
    'https://stream.udemycdn.com/a#fragment', 'https:\\www.udemy.com\\a', 'file:///a'
  ]) await assert.rejects(fetcher(url));
  assert.equal(calls, 0);
});

test('every forbidden redirect is rejected before contacting its destination', async () => {
  for (const location of ['https://evil.test/a?token=private-secret', 'http://www.udemy.com/a', '//udemy.com.evil.test/a', 'https://a:b@udemy.com/a', 'https://udemycdn.com:444/a']) {
    const calls = [];
    const fetcher = createSessionFetch({fetchImpl: async url => { calls.push(url); return redirect(location); }});
    await assert.rejects(fetcher(`${cdn}/start`), error => !error.message.includes('private-secret'));
    assert.deepEqual(calls, [`${cdn}/start`]);
  }
});

test('redirect limit allows at most five redirect hops and discards redirect bodies', async () => {
  let calls = 0, discarded = 0;
  const fetcher = createSessionFetch({fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({cancel() { discarded++; }}), {status: 307, headers: {location: '/again'}});
  }});
  await assert.rejects(fetcher(`${cdn}/start`), /重新導向.*上限/);
  assert.equal(calls, 6);
  assert.equal(discarded, 6);
  assert.throws(() => createSessionFetch({maxRedirects: 6}), /設定/);
});

test('missing location and silently followed responses are rejected', async () => {
  const missing = createSessionFetch({fetchImpl: async () => response('', {status: 302})});
  await assert.rejects(missing(`${cdn}/a`), /缺少/);
  const silent = createSessionFetch({fetchImpl: async () => {
    const result = response('ok');
    Object.defineProperty(result, 'url', {value: `${cdn}/unexpected`});
    return result;
  }});
  await assert.rejects(silent(`${cdn}/a`), /逐次/);
});

test('custom headers, body and non-download methods are rejected without network access', async () => {
  let calls = 0;
  const fetcher = createSessionFetch({fetchImpl: async () => { calls++; return response(); }});
  for (const options of [{headers: {Cookie: 'private-secret'}}, {headers: {Accept: '*/*'}}, {body: 'secret'}, {method: 'POST'}]) {
    await assert.rejects(fetcher(`${cdn}/a`, options));
  }
  assert.equal(calls, 0);
});

test('cookie supplier gets the complete path and malformed cookie data never reaches fetch', async () => {
  let fetchCalls = 0, cookieUrl;
  const fetcher = createSessionFetch({authOrigin, getCookies: async url => { cookieUrl = url; return [{name: 'auth', value: 'private-secret\r\nX: injected'}]; }, fetchImpl: async () => { fetchCalls++; return response(); }});
  const url = `${authOrigin}/path/list.m3u8?own=value`;
  await assert.rejects(fetcher(url), error => !error.message.includes('private-secret'));
  assert.equal(cookieUrl, url);
  assert.equal(fetchCalls, 0);
  assert.throws(() => createSessionFetch({authOrigin: cdn, getCookies: async () => []}), /登入来源|登入來源/);
  assert.throws(() => createSessionFetch({authOrigin, getCookies: null}), /登入來源/);
});

test('anonymous requests never call a cookie supplier without a selected auth origin', async () => {
  let cookies = 0;
  const fetcher = createSessionFetch({getCookies: async () => { cookies++; return []; }, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('cookie'), null); return response('ok');
  }});
  assert.equal(await (await fetcher(`${authOrigin}/a`)).text(), 'ok');
  assert.equal(cookies, 0);
});

test('timeouts and abort can stop a fetch implementation that never settles', async () => {
  const timeoutFetcher = createSessionFetch({timeoutMs: 10, fetchImpl: () => new Promise(() => {})});
  await assert.rejects(timeoutFetcher(`${cdn}/a`), /逾時/);
  const entered = deferred();
  const controller = new AbortController();
  const fetcher = createSessionFetch({fetchImpl: () => { entered.resolve(); return new Promise(() => {}); }});
  const request = fetcher(`${cdn}/a`, {signal: controller.signal});
  await entered.promise;
  controller.abort('private-secret');
  await assert.rejects(request, error => error.name === 'AbortError' && !error.message.includes('private-secret'));
});

test('abort interrupts cookie lookup before any fetch and cancels body reads', async () => {
  const entered = deferred(), controller = new AbortController();
  let calls = 0;
  const cookieFetcher = createSessionFetch({authOrigin, getCookies: () => { entered.resolve(); return new Promise(() => {}); }, fetchImpl: async () => { calls++; return response(); }});
  const pending = cookieFetcher(`${authOrigin}/a`, {signal: controller.signal});
  await entered.promise; controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(calls, 0);
  let bodyCancelled = false;
  const bodyController = new AbortController();
  const bodyFetcher = createSessionFetch({fetchImpl: async () => new Response(new ReadableStream({pull() { return new Promise(() => {}); }, cancel() { bodyCancelled = true; }}))});
  const result = await bodyFetcher(`${cdn}/a`, {signal: bodyController.signal});
  const reading = result.text();
  bodyController.abort();
  await assert.rejects(reading, {name: 'AbortError'});
  assert.equal(bodyCancelled, true);
});

test('response-body timeout and partial content are errors rather than success', async () => {
  const fetcher = createSessionFetch({timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({pull() { return new Promise(() => {}); }}))});
  const result = await fetcher(`${cdn}/a`);
  await assert.rejects(result.text(), /逾時/);
  const partial = createSessionFetch({fetchImpl: async () => response('partial', {status: 206})});
  await assert.rejects(partial(`${cdn}/a`), /部分內容/);
});

test('a response arriving after cancellation has its body discarded', async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController();
  let discarded = false;
  const fetcher = createSessionFetch({fetchImpl: () => { entered.resolve(); return pending.promise; }});
  const request = fetcher(`${cdn}/a`, {signal: controller.signal});
  await entered.promise; controller.abort();
  await assert.rejects(request, {name: 'AbortError'});
  pending.resolve(new Response(new ReadableStream({cancel() { discarded = true; }})));
  await new Promise(setImmediate);
  assert.equal(discarded, true);
});

test('underlying errors and cookie failures never expose URLs or secret values', async () => {
  for (const setup of [
    {fetchImpl: async () => { throw new Error('fetch failed https://udemycdn.com/a?token=private-secret'); }},
    {authOrigin, getCookies: async () => { throw new Error('cookie private-secret'); }, fetchImpl: async () => response()}
  ]) {
    const fetcher = createSessionFetch(setup);
    await assert.rejects(fetcher(`${authOrigin}/a`), error => !error.message.includes('private-secret') && !error.message.includes('https://'));
  }
  assert.equal(checkedMediaUrl(`${cdn}/a.ts`).origin, cdn);
});
