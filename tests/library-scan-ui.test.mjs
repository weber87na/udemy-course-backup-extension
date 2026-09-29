import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_PREFIX, normalizeCourse, sanitizeRecord, summarizeRecord, reasonLabel } from '../extension/library-core.mjs';
import { checkCourse } from '../extension/library-scan-io.mjs';
import { withBatchLock, abortIfNeeded } from '../extension/batch-io.mjs';
import { LIBRARY_ORIGINS } from '../extension/library-background.mjs';

// Execute the actual page controller and actual record/lock workflow. Only
// browser IO and the inspector's media reads are replaced at their boundaries.
const source = readFileSync(new URL('../extension/library-scan.js', import.meta.url), 'utf8').replace(/^import[^\r\n]+;\r?\n/gm, '');
const html = readFileSync(new URL('../extension/library-scan.html', import.meta.url), 'utf8');
const jobKey = 'library-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const courseKey = 'https://www.udemy.com/course/example-course';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.content = ''; this.disabled = false; this.hidden = false; this.value = 0; this.max = 1; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.content = ''; this.children = nodes; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function fixture(options = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element('div')]));
  const $ = id => elements.get(id);
  for (const id of ['start', 'stop', 'source']) $(id).disabled = true;
  const key = options.courseKey || courseKey;
  const courses = options.courses || [{ courseKey: key, title: 'A course' }];
  const videos = [1, 2, 3].map(id => ({ kind: 'video', lectureId: String(id), title: `Lecture ${id}`, courseKey }));
  const currentCatalog = options.catalog || { courseKey, courseTitle: 'A course', complete: true, items: videos };
  const local = {}, writes = [], sessionRemoved = [], messages = [], gestures = [], inspections = [], collections = [], locks = [], inspectors = [], tabUpdates = [], directCreates = [];
  const windowListeners = new Map();
  let gesture = false;
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.5.0-test' }), sendMessage: async message => { messages.push(structuredClone(message)); return options.workerResponse || { ok: true, tab: { id: 91 } }; } },
    permissions: { request: () => { gestures.push({ active: gesture }); return options.permission || Promise.resolve(true); } },
    tabs: { getCurrent: async () => ({ id: 55 }), update: async (id, value) => tabUpdates.push([id, value]), create: async value => { directCreates.push(value); throw new Error('The scanner page must delegate owned tabs to background'); } },
    storage: {
      session: { get: async () => ({ [jobKey]: { courses, mode: options.mode || 'sample', sourceTabId: 17, createdAt: Date.now() } }), remove: async key => sessionRemoved.push(key) },
      local: { set: async value => { writes.push(structuredClone(value)); Object.assign(local, structuredClone(value)); } }
    }
  };
  const createInspector = (_api, settings) => {
    const inspector = {
      settings, closeCount: 0,
      async collect(course) {
        collections.push(course.courseKey);
        await settings.openTab({ url: normalizeCourse(course.courseKey).url, active: false });
        return options.collect ? options.collect(course, settings) : structuredClone(currentCatalog);
      },
      async inspect(course, item) { inspections.push(item.lectureId); return options.inspect ? options.inspect(course, item, settings) : { status: 'downloadable', reason: 'hls-supported' }; },
      async close() { inspector.closeCount++; }
    };
    inspectors.push(inspector); return inspector;
  };
  const context = vm.createContext({
    URL, Date, Promise, AbortController, DOMException, console,
    chrome, navigator: { locks: { request: async (name, flags, callback) => { locks.push({ name, flags }); return callback(options.deniedLock?.(name) ? null : { name }); } } },
    document: { getElementById: $, createElement: tag => new Element(tag) },
    window: { addEventListener: (type, callback) => { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(callback); } },
    location: { href: `chrome-extension://test/library-scan.html?job=${jobKey}` },
    STORAGE_PREFIX, normalizeCourse, sanitizeRecord, summarizeRecord, reasonLabel, createInspector, checkCourse, withBatchLock, abortIfNeeded, LIBRARY_ORIGINS
  });
  vm.runInContext(source, context, { filename: 'library-scan.js' });
  const state = expression => vm.runInContext(expression, context);
  async function settle(predicate = () => !state('busy')) {
    for (let index = 0; index < 50; index++) { await new Promise(setImmediate); if (predicate()) return; }
    throw new Error('Scanner UI did not settle');
  }
  function dispatch(id) {
    if ($(id).disabled) return Promise.resolve();
    gesture = true;
    let returns;
    try { returns = ($(id).listeners.get('click') || []).map(callback => callback({ target: $(id) })); }
    finally { gesture = false; }
    return Promise.all(returns);
  }
  await settle(() => Boolean(state('job')));
  return { $, key, state, settle, dispatch, local, writes, sessionRemoved, messages, gestures, inspections, collections, locks, inspectors, tabUpdates, directCreates,
    row() { return state(`rows.get(${JSON.stringify(key)})`); },
    event(type) { for (const callback of windowListeners.get(type) || []) callback(); }
  };
}

test('start requests permissions synchronously in the click gesture and waits before IO', async () => {
  const permission = deferred(); const f = await fixture({ permission: permission.promise });
  assert.equal(f.collections.length, 0); assert.equal(f.$('start').disabled, false);
  const running = f.dispatch('start');
  assert.deepEqual(f.gestures, [{ active: true }]); assert.equal(f.$('start').disabled, true); assert.equal(f.$('stop').disabled, false);
  await new Promise(setImmediate); assert.equal(f.collections.length, 0); assert.equal(f.messages.length, 0);
  permission.resolve(false); await running; await f.settle();
  assert.equal(f.collections.length, 0); assert.equal(f.writes.length, 0); assert.match(f.$('error').textContent, /讀取權限/); assert.equal(f.$('start').disabled, false);
});

test('sample results update local storage and the row immediately without claiming the whole course', async () => {
  const gate = deferred(); const f = await fixture({ inspect: () => gate.promise });
  const running = f.dispatch('start'); await f.settle(() => f.inspections.length === 1);
  const storageKey = STORAGE_PREFIX + f.key;
  assert.equal(f.local[storageKey].finished, false); assert.deepEqual(f.local[storageKey].results, []);
  assert.equal(f.row().label.textContent, '尚未確認'); assert.match(f.row().detail.textContent, /已檢查 0 \/ 3 堂影片/);
  assert.equal(f.$('progress').value, 0);
  gate.resolve({ status: 'downloadable', reason: 'hls-supported' }); await running; await f.settle();
  assert.equal(f.local[storageKey].finished, true); assert.equal(f.local[storageKey].mode, 'sample'); assert.equal(f.local[storageKey].results.length, 1);
  assert.equal(f.row().label.textContent, '可下載（部分已確認）'); assert.match(f.row().detail.textContent, /此結果不代表整門課/);
  assert.equal(f.row().list.children.length, 1); assert.equal(f.writes.length, 3); assert.equal(f.$('progress').value, 1);
});

test('each onRecord is published before a full scan finishes, and stopping preserves only checked lectures', async () => {
  const gate = deferred(); const f = await fixture({ mode: 'full', inspect: (_course, item) => item.lectureId === '1' ? { status: 'downloadable', reason: 'hls-supported' } : gate.promise });
  const running = f.dispatch('start'); await f.settle(() => f.inspections.length === 2);
  const key = STORAGE_PREFIX + f.key;
  assert.equal(f.state('busy'), true); assert.equal(f.local[key].finished, false); assert.equal(f.local[key].results.length, 1);
  assert.equal(f.row().label.textContent, '可下載（部分已確認）'); assert.match(f.$('status').textContent, /已檢查 1 \/ 3 堂/);
  await f.dispatch('stop'); assert.equal(f.inspectors[0].settings.signal.aborted, true); assert(f.inspectors[0].closeCount > 0);
  gate.resolve({ status: 'downloadable', reason: 'hls-supported' }); await running; await f.settle();
  assert.deepEqual(f.inspections, ['1', '2']); assert.equal(f.local[key].finished, false); assert.equal(f.local[key].results.length, 1);
  assert.equal(f.$('progress').value, 0); assert.match(f.$('status').textContent, /已停止/); assert.equal(f.$('stop').disabled, true);
  assert.notEqual(f.row().label.textContent, '可下載');
});

test('a busy global scan lock prevents collecting or opening a worker', async () => {
  const f = await fixture({ deniedLock: name => name === 'udemy-library-scan' }); await f.dispatch('start'); await f.settle();
  assert.equal(f.inspectors.length, 0); assert.equal(f.collections.length, 0); assert.equal(f.messages.length, 0); assert.equal(f.writes.length, 0);
  assert.match(f.$('error').textContent, /另一個課程檢查/); assert.match(f.$('status').textContent, /檢查未完成/);
});

test('an existing course backup lock prevents media inspection and persists an unfinished result', async () => {
  const f = await fixture({ mode: 'full', deniedLock: name => name.startsWith('udemy-course-') }); await f.dispatch('start'); await f.settle();
  assert.equal(f.collections.length, 1); assert.equal(f.inspections.length, 0);
  assert.equal(f.local[STORAGE_PREFIX + f.key].finished, false); assert.deepEqual(f.local[STORAGE_PREFIX + f.key].results, []);
  assert.equal(f.row().label.textContent, '尚未確認'); assert.match(f.row().detail.textContent, /其他備份工作/); assert(f.inspectors[0].closeCount > 0);
});

test('worker creation delegates to background with its owner and preserves numeric course identity', async () => {
  const key = 'https://www.udemy.com/course-dashboard-redirect/?course_id=7190737';
  const f = await fixture({ courseKey: key }); await f.dispatch('start'); await f.settle();
  assert.deepEqual(f.messages, [{ type: 'library-open-worker', ownerTabId: 55, url: key }]); assert.deepEqual(f.directCreates, []);
  assert.equal(f.local[STORAGE_PREFIX + key].courseKey, key); assert.deepEqual(f.sessionRemoved, [jobKey]);
});

test('a rejected worker creation cannot inspect media or show a complete course', async () => {
  const f = await fixture({ workerResponse: { ok: false, error: 'blocked' } }); await f.dispatch('start'); await f.settle();
  assert.equal(f.inspections.length, 0); assert.equal(f.row().label.textContent, '尚未確認');
  const stored = f.local[STORAGE_PREFIX + f.key]; assert.equal(stored.finished, false); assert.equal(stored.totalVideos, null); assert.deepEqual(stored.results, []);
  assert(f.inspectors[0].closeCount > 0);
});

test('pagehide aborts the running inspector, closes its worker, and prevents a completion label', async () => {
  const gate = deferred(); const f = await fixture({ mode: 'full', inspect: () => gate.promise });
  const running = f.dispatch('start'); await f.settle(() => f.inspections.length === 1);
  f.event('pagehide'); assert.equal(f.inspectors[0].settings.signal.aborted, true); assert(f.inspectors[0].closeCount > 0);
  gate.resolve({ status: 'downloadable', reason: 'hls-supported' }); await running; await f.settle();
  assert.equal(f.local[STORAGE_PREFIX + f.key].finished, false); assert.deepEqual(f.local[STORAGE_PREFIX + f.key].results, []); assert.equal(f.$('progress').value, 0);
  assert.match(f.$('status').textContent, /已停止/); assert.notEqual(f.row().label.textContent, '可下載');
});
