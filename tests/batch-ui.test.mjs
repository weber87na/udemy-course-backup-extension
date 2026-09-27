import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runQueue, safeQueueSnapshot} from '../extension/batch-core.mjs';
import {courseIdentity} from '../extension/batch-io.mjs';

// Execute the production UI with real queue helpers and boundary-only IO mocks.
// This verifies state/gesture integration, not browser layout or live Udemy DOM.
const source = readFileSync(new URL('../extension/batch.js', import.meta.url), 'utf8')
  .replace(/^import[^\r\n]+;\r?\n/gm, '');
const html = readFileSync(new URL('../extension/batch.html', import.meta.url), 'utf8');
const pageUrl = 'https://www.udemy.com/course/another-course/learn/lecture/101';
const identity = courseIdentity(pageUrl);
const jobKey = 'course-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = new Map();
    this.disabled = false; this.hidden = false; this.checked = false; this.textContent = '';
    this.value = ''; this.max = 1;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list);
  }
  click() { for (const listener of this.listeners.get('click') || []) listener({target: this}); }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function entry(id, kind = 'video', extra = {}) {
  return {key: `lecture:${id}`, lectureId: String(id), title: `講座 ${id}`, kind,
    sectionIndex: 1, sectionTitle: '另一門課的章節', lectureIndex: Number(id), ...extra};
}

function catalog(entries = [entry(101), entry(102, 'article'), entry(103)], complete = true) {
  return {courseKey: identity.key, courseTitle: '另一門測試課', complete, notes: [],
    sections: [{sectionIndex: 1, title: '另一門課的章節', items: entries}]};
}

const directory = name => ({name, queryPermission: async () => 'granted'});

async function fixture(options = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element('div')]));
  const $ = id => elements.get(id);
  $('quality').value = 'best';
  const local = {}, gestures = [], activations = [], writes = [], observerErrors = [];
  let userGesture = false;
  let currentCatalog = options.catalog || catalog();
  let pickerValue = options.folder || directory('First folder');
  let writer = options.writeLecture;
  let pickerError = null;
  const chrome = {
    runtime: {getManifest: () => ({version: '0.3.0-test'})},
    permissions: {request: async () => { gestures.push(['permission', userGesture]); return true; }, contains: async () => true},
    tabs: {update: async () => {}},
    storage: {
      session: {get: async () => ({[jobKey]: {tabId: 12, createdAt: Date.now(), pageUrl, courseTitle: '另一門測試課'}}), remove: async () => {}},
      local: {get: async key => ({[key]: local[key]}), set: async value => Object.assign(local, structuredClone(value))}
    }
  };
  const bridge = {
    attach: async () => {},
    call: async (method, arg) => {
      if (method === 'collect') return structuredClone(currentCatalog);
      if (method === 'activate') { activations.push(arg.key); return {}; }
      throw new Error(`Unexpected method ${method}`);
    }
  };
  const context = vm.createContext({
    console, URL, Blob, Date, Promise, AbortController, DOMException, setTimeout, clearTimeout,
    document: {getElementById: $, createElement: tag => new Element(tag), createTextNode: text => ({textContent: text})},
    window: {
      addEventListener: () => {},
      showDirectoryPicker: () => {
        gestures.push(['picker', userGesture]);
        if (pickerError) throw pickerError;
        return Promise.resolve(pickerValue);
      }
    },
    navigator: {locks: {}, clipboard: {writeText: async () => {}}},
    location: {href: `chrome-extension://test/batch.html?job=${jobKey}`},
    chrome, courseIdentity, safeQueueSnapshot,
    runQueue: (items, options) => runQueue(items, {...options, onUpdate: async state => {
      try { await options.onUpdate(state); }
      catch (error) { observerErrors.push(error); throw error; }
    }}),
    pageBridge: () => bridge,
    abortIfNeeded: signal => { if (signal?.aborted) throw new DOMException('Stopped', 'AbortError'); },
    withBatchLock: async (_locks, _tabId, _key, action) => action(),
    waitForStream: options.waitForStream || (async (_bridge, item) => ({lectureId: item.lectureId, candidates: [{url: 'https://udemycdn.com/master.m3u8?token=private-secret'}]})),
    readSelectedMedia: options.readSelectedMedia || (async () => ({media: {type: 'media', segments: [{url: 'https://udemycdn.com/one.ts?token=private-secret'}]}, qualityLabel: '720p'})),
    outputTarget: async (folder, item) => ({exists: false, item, folder}),
    writeLecture: async (target, media, options) => {
      writes.push({key: target.item.key, folder: target.folder.name});
      if (writer) return writer(target, media, options);
      options.onProgress({completed: 1, total: 1, bytes: 1000});
      return {status: 'completed', bytes: 1000};
    }
  });
  vm.runInContext(source, context, {filename: 'batch.js'});
  const state = expression => vm.runInContext(expression, context);
  async function settle(predicate = () => !state('busy')) {
    for (let tries = 0; tries < 50; tries++) {
      await new Promise(setImmediate);
      if (predicate()) { await state('persistChain'); return; }
    }
    throw new Error('UI did not settle');
  }
  function dispatch(id, type = 'click') {
    const element = $(id);
    if (type === 'click' && element.disabled) return Promise.resolve();
    userGesture = true;
    let returns;
    try { returns = (element.listeners.get(type) || []).map(listener => listener({target: element})); }
    finally { userGesture = false; }
    return Promise.all(returns);
  }
  await settle(() => Boolean(state('job && identity && bridge')));
  return {$, state, settle, dispatch, local, gestures, writes, activations, observerErrors,
    setCatalog: value => { currentCatalog = value; }, setFolder: value => { pickerValue = value; },
    setWriter: value => { writer = value; }, setPickerError: value => { pickerError = value; }};
}

async function ready(f) {
  await f.dispatch('load'); await f.settle();
  await f.dispatch('folder'); await f.settle();
}

test('permission and directory picker are called in the click gesture; incomplete catalog cannot start', async () => {
  const f = await fixture({catalog: catalog(undefined, false)});
  await f.dispatch('load'); await f.settle();
  assert.equal(f.$('folder').disabled, true);
  assert.equal(f.$('start').disabled, true);
  assert.match(f.$('catalog-status').textContent, /尚未完整/);
  f.setCatalog(catalog());
  await ready(f);
  assert.equal(f.$('start').disabled, false);
  assert.deepEqual(f.gestures, [['permission', true], ['permission', true], ['picker', true]]);
});

test('only selected videos execute and completed queue updates visible counts and controls', async () => {
  const f = await fixture();
  await ready(f);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:101', 'lecture:103']);
  assert.equal(f.$('overall-progress').value, 2);
  assert.match(f.$('overall').textContent, /完成 2/);
  assert.match(f.$('current').textContent, /處理完畢/);
  assert.equal(f.$('start').disabled, true);
  assert.equal(f.$('stop').disabled, true);
  assert.equal(f.$('folder').disabled, false);
});

test('catalog reload cannot carry video selection into a now non-video entry', async () => {
  const f = await fixture();
  await ready(f);
  f.setCatalog(catalog([entry(101, 'article'), entry(103)]));
  await f.dispatch('load'); await f.settle();
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:103']);
  assert.equal(f.state('items.find(item=>item.lectureId==="101").selected'), false);
});

test('changing destination resets completion so the new folder receives every selected lecture', async () => {
  const f = await fixture();
  await ready(f);
  await f.dispatch('start'); await f.settle();
  f.setFolder(directory('Second folder'));
  await f.dispatch('folder'); await f.settle();
  assert.equal(f.$('start').disabled, false);
  assert.equal(f.$('overall-progress').value, 0);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.writes.map(write => write.folder), ['First folder', 'First folder', 'Second folder', 'Second folder']);
});

test('stop waits for active cleanup, then retry resumes unfinished lectures and updates the end label', async () => {
  const entered = deferred(), cleanup = deferred();
  const f = await fixture({writeLecture: async (_target, _media, {signal}) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    await cleanup.promise;
    throw new DOMException('Cancelled', 'AbortError');
  }});
  await ready(f);
  const running = f.dispatch('start');
  await entered.promise;
  assert.equal(f.$('stop').disabled, false);
  await f.dispatch('stop');
  assert.match(f.$('current').textContent, /正在停止/);
  assert.equal(f.$('start').disabled, true);
  cleanup.resolve();
  await running; await f.settle();
  assert.match(f.$('current').textContent, /已停止/);
  assert.equal(f.$('start').disabled, false);
  assert.equal(f.$('overall-progress').value, 0);
  f.setWriter(null);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:101', 'lecture:101', 'lecture:103']);
  assert.match(f.$('overall').textContent, /完成 2/);
});

test('failure continues, remains visible, and selecting unfinished retries only failed work', async () => {
  const f = await fixture({writeLecture: async target => {
    if (target.item.lectureId === '101') throw new Error('格式不支援 https://udemycdn.com/a?token=private-secret');
    return {status: 'completed', bytes: 1000};
  }});
  await ready(f);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:101', 'lecture:103']);
  assert.match(f.$('overall').textContent, /完成 1.*失敗 1/);
  assert.match(f.$('current').textContent, /1 堂失敗/);
  assert.equal(f.state('items[0].status'), 'failed');
  assert.ok(!f.state('items[0].error').includes('private-secret'));
  assert.equal(f.local.batchReports[0].items[0].status, 'failed');
  await f.dispatch('remaining');
  f.setWriter(null);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:101', 'lecture:103', 'lecture:101']);
  assert.equal(f.state('items[0].status'), 'completed');
  assert.equal(f.local.batchReports[0].items[0].status, 'completed');
  assert.ok(!JSON.stringify(f.local.batchReports).includes('private-secret'));
});

test('capture source failure stops the batch while retaining failed and remaining queued states', async () => {
  const f = await fixture({waitForStream: async () => { throw new Error('原課程分頁已關閉，請重新開啟。'); }});
  await ready(f);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:101']);
  assert.deepEqual(f.writes, []);
  assert.equal(f.state('items[0].status'), 'failed');
  assert.equal(f.state('items[2].status'), 'queued');
  assert.equal(f.local.batchReports[0].items[0].status, 'failed');
  assert.equal(f.local.batchReports[0].items[2].status, 'queued');
  assert.match(f.$('current').textContent, /整批已停止/);
  assert.match(f.$('error').textContent, /分頁已關閉/);
});

test('encrypted media failure continues to next lecture without opening an output writer', async () => {
  const f = await fixture({readSelectedMedia: async capture => {
    if (capture.lectureId === '101') throw new Error('影片串流已加密，已停止；不讀取金鑰、不解密，也不處理 DRM。');
    return {media: {type: 'media', segments: [{url: 'https://udemycdn.com/a.ts'}]}, qualityLabel: '720p'};
  }});
  await ready(f);
  await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.activations, ['lecture:101', 'lecture:103']);
  assert.deepEqual(f.writes.map(write => write.key), ['lecture:103']);
  assert.equal(f.state('items[0].status'), 'failed');
  assert.equal(f.state('items[2].status'), 'completed');
  assert.match(f.$('current').textContent, /1 堂失敗/);
});

test('stopping before queue starts handles null-item update without observer errors', async () => {
  const permission = deferred(), entered = deferred();
  const folder = {name: 'Delayed permission', queryPermission: () => { entered.resolve(); return permission.promise; }};
  const f = await fixture({folder});
  await ready(f);
  const running = f.dispatch('start');
  await entered.promise;
  await f.dispatch('stop');
  permission.resolve('granted');
  await running; await f.settle();
  assert.deepEqual(f.observerErrors, []);
  assert.deepEqual(f.activations, []);
  assert.match(f.$('current').textContent, /已停止/);
  assert.equal(f.$('start').disabled, false);
});

test('persisted reports contain status metadata but exclude candidates, URLs and raw errors', async () => {
  const raw = entry(101, 'video', {
    url: 'https://udemycdn.com/a?token=private-secret', candidates: [{url: 'private-secret'}],
    error: 'private-secret', credentials: 'private-secret'
  });
  const f = await fixture({catalog: catalog([raw])});
  await ready(f);
  await f.dispatch('start'); await f.settle();
  const report = f.local.batchReports[0];
  assert.equal(report.items[0].status, 'completed');
  assert.ok(!JSON.stringify(report).includes('private-secret'));
  for (const key of ['url', 'candidates', 'error', 'credentials', 'result']) assert.ok(!(key in report.items[0]));
});

test('synchronous directory picker denial stays in UI without leaving a busy state', async () => {
  const f = await fixture();
  await f.dispatch('load'); await f.settle();
  f.setPickerError(new DOMException('Picker denied', 'SecurityError'));
  await assert.doesNotReject(() => f.dispatch('folder'));
  await f.settle();
  assert.equal(f.state('busy'), false);
  assert.equal(f.$('error').hidden, false);
  assert.match(f.$('error').textContent, /Picker denied/);
  assert.equal(f.$('start').disabled, true);
});
