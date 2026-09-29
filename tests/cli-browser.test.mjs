import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {launchSession} from '../cli/browser.mjs';

const course = 'https://www.udemy.com/course/example/learn/lecture/11';
function fixture() {
  const calls = {connect: [], goto: [], evaluate: 0, close: 0, disconnect: 0, cookies: [], detach: 0, newPage: 0};
  const state = {url: 'about:blank', closed: false};
  const context = vm.createContext({URL, location: {get href() { return state.url; }}});
  const rawPage = {
    url: () => state.url, isClosed: () => state.closed,
    async goto(url, options) { calls.goto.push({url, options}); state.url = url; },
    async evaluate(fn, ...args) {
      calls.evaluate += 1; context.args = args;
      return vm.runInContext(`(${fn.toString()})(...args)`, context);
    },
    async close() { calls.close += 1; state.closed = true; },
    async createCDPSession() { return {
      async send(method, params) { calls.cookies.push({method, params}); return {cookies: [{name: 'session', value: 'private'}]}; },
      async detach() { calls.detach += 1; },
    }; },
  };
  const browser = {
    async newPage() { calls.newPage += 1; return rawPage; },
    async disconnect() { calls.disconnect += 1; },
    async close() { assert.fail('must not close the user browser'); },
    async pages() { assert.fail('must not inventory user tabs'); },
  };
  const deps = {loadPuppeteer: async () => ({connect: async options => { calls.connect.push(options); return browser; }})};
  return {calls, state, context, rawPage, browser, deps};
}

test('official existing Chrome connect owns exactly one tab and disconnects idempotently', async () => {
  const f = fixture(), session = await launchSession({url: course}, f.deps);
  assert.equal(f.calls.connect[0].channel, 'chrome');
  assert.equal(f.calls.connect[0].networkEnabled, false);
  assert.equal(f.calls.newPage, 1);
  await session.page.goto(course);
  assert.equal(await session.page.evaluate(() => location.href), course);
  await session.close(); await session.close();
  assert.equal(f.calls.close, 1); assert.equal(f.calls.disconnect, 1);
});

test('target filter excludes internal pages, other courses, workers and foreign origins', async () => {
  const f = fixture(), session = await launchSession({url: course}, f.deps);
  const filter = f.calls.connect[0].targetFilter;
  const target = (url, type = 'page') => ({url: () => url, type: () => type});
  for (const url of ['chrome://settings', 'chrome-extension://id/popup.html', 'https://example.com', 'https://www.udemy.com/course/other/learn/']) assert.equal(filter(target(url)), false);
  assert.equal(filter(target(course, 'service_worker')), false);
  assert.equal(filter(target('about:blank')), true);
  assert.equal(filter(target('', 'tab')), true);
  assert.equal(filter(target(course)), true);
  await session.close();
});

test('page wrapper refuses login DOM, unrelated navigation and in-page navigation race', async () => {
  const f = fixture(), session = await launchSession({url: course}, f.deps);
  await assert.rejects(session.page.goto('https://example.com'), /指定/);
  f.state.url = 'https://www.udemy.com/join/login-popup/';
  await assert.rejects(session.page.evaluate(() => 'private'), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.evaluate, 0);
  f.state.url = course;
  const original = f.rawPage.evaluate;
  f.rawPage.evaluate = async (fn, ...args) => { f.state.url = 'https://www.udemy.com/course/other/learn/'; return original(fn, ...args); };
  await assert.rejects(session.page.evaluate(() => { globalThis.inspected = true; }), {code: 'PAGE_UNAVAILABLE'});
  assert.equal(f.context.inspected, undefined);
  await session.close();
});

test('cookies are requested for exact same-origin URL, never profile or CDN cookies', async () => {
  const f = fixture(), session = await launchSession({url: course}, f.deps);
  await session.page.goto(course);
  const request = 'https://www.udemy.com/assets/99/master.m3u8?token=private';
  assert.deepEqual(await session.getCookies(request), [{name: 'session', value: 'private'}]);
  assert.deepEqual(f.calls.cookies, [{method: 'Network.getCookies', params: {urls: [request]}}]);
  assert.deepEqual(await session.getCookies('https://cdn.udemycdn.com/video.ts'), []);
  assert.deepEqual(await session.getCookies('https://other.udemy.com/assets/99/master.m3u8'), []);
  await assert.rejects(session.getCookies('http://www.udemy.com/assets/99/master.m3u8'), /無效/);
  assert.equal(f.calls.cookies.length, 1);
  await session.close(); assert.equal(f.calls.detach, 1);
});

test('cookie result is discarded when tab leaves selected course during the request', async () => {
  const f = fixture();
  f.rawPage.createCDPSession = async () => ({send: async () => { f.state.url = 'https://www.udemy.com/join/login/'; return {cookies: [{value: 'private'}]}; }, detach: async () => {}});
  const session = await launchSession({url: course}, f.deps);
  await session.page.goto(course);
  await assert.rejects(session.getCookies('https://www.udemy.com/assets/1/file.m3u8'), /無法取得/);
  await session.close();
});

test('aborted connection disconnects a browser that resolves later', async () => {
  const f = fixture(), controller = new AbortController();
  let resolveConnect;
  const launched = launchSession({url: course, signal: controller.signal}, {loadPuppeteer: async () => ({connect: () => new Promise(resolve => { resolveConnect = resolve; })})});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(launched, {name: 'AbortError'});
  resolveConnect(f.browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.disconnect, 1); assert.equal(f.calls.close, 0); assert.equal(f.calls.newPage, 0);
});

test('aborted newPage closes only the late owned page before disconnecting', async () => {
  const f = fixture(), controller = new AbortController();
  let resolvePage;
  f.browser.newPage = () => new Promise(resolve => { resolvePage = resolve; });
  const launched = launchSession({url: course, signal: controller.signal}, f.deps);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(launched, {name: 'AbortError'});
  resolvePage(f.rawPage);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.close, 1); assert.equal(f.calls.disconnect, 1);
});

test('existing session abort closes its own tab and sanitizes browser failures', async () => {
  const f = fixture(), controller = new AbortController();
  const session = await launchSession({url: course, signal: controller.signal}, f.deps);
  await session.page.goto(course);
  f.rawPage.evaluate = async () => { throw new Error('https://www.udemy.com/assets/1/a.m3u8?token=secret'); };
  await assert.rejects(session.page.evaluate(() => true), error => !error.message.includes('secret') && error.code === 'PAGE_UNAVAILABLE');
  controller.abort(); await session.close();
  assert.equal(f.calls.close, 1); assert.equal(f.calls.disconnect, 1);
});

test('invalid browser or URL is rejected before loading browser dependencies', async () => {
  const deps = {loadPuppeteer: () => assert.fail('must not connect')};
  await assert.rejects(launchSession({url: course, browser: 'chrome'}, deps), /existing/);
  await assert.rejects(launchSession({url: 'chrome://settings'}, deps), /HTTPS/);
  await assert.rejects(launchSession({url: course, timeoutMs: 0}, deps), /等待時間/);
});

test('non-English course slugs use the same strict encoded course identity', async () => {
  const f = fixture(), localized = 'https://www.udemy.com/course/%E8%AA%B2%E7%A8%8B/learn/lecture/11';
  const session = await launchSession({url: localized}, f.deps);
  await session.page.goto(localized);
  assert.equal(await session.page.evaluate(() => location.href), localized);
  await session.close();
});
