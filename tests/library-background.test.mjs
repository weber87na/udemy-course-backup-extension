import test from 'node:test';
import assert from 'node:assert/strict';
import {LIBRARY_ORIGINS, isLibraryUrl, scanCourses, startLibraryScan, openWorkerTab} from '../extension/library-background.mjs';

const course = {courseKey: 'https://www.udemy.com/course/fixture-course', title: 'Fixture course'};
const sender = {url: 'https://www.udemy.com/home/my-courses/learning/', frameId: 0, tab: {id: 19}};
const message = {type: 'library-scan', mode: 'sample', courses: [course]};
function fixture({permission = true, failOpen = false} = {}) {
  const stored = new Map(), opened = [], removed = [];
  const api = {
    permissions: {async contains(value) {assert.deepEqual(value, {origins: LIBRARY_ORIGINS}); return permission;}},
    storage: {session: {async set(values) {for (const [key, value] of Object.entries(values)) stored.set(key, value);}, async remove(key) {removed.push(key); stored.delete(key);}}},
    runtime: {getURL: path => `chrome-extension://fixture/${path}`},
    tabs: {async create(value) {if (failOpen) throw new Error('Tab failed'); opened.push(value); return {id: 100};}}
  };
  return {api, stored, opened, removed};
}

test('scan request is limited to a top-frame Udemy library sender and a recognized mode', async () => {
  for (const invalid of [{...sender, frameId: 2}, {...sender, tab: {}}, {...sender, url: 'https://www.udemy.com/course/fixture-course/'},
    {...sender, url: 'https://udemy.com.attacker.invalid/home/my-courses/learning/'}, {...sender, url: 'http://www.udemy.com/home/my-courses/learning/'}]) {
    const f = fixture();
    await assert.rejects(startLibraryScan(f.api, message, invalid));
    assert.equal(f.opened.length, 0); assert.equal(f.stored.size, 0);
  }
  await assert.rejects(startLibraryScan(fixture().api, {...message, mode: 'invalid'}, sender));
});

test('course list canonicalizes URLs, requires sender origin, and refuses duplicates and oversized jobs', () => {
  assert.deepEqual(scanCourses([{...course, courseKey: `${course.courseKey}/learn/lecture/11?token=private`, title: 'A\nB'}], 'https://www.udemy.com'), [{...course, title: 'A B'}]);
  for (const value of [[], [course, course], [{...course, courseKey: 'https://other.udemy.com/course/fixture-course'}], Array(101).fill(course)]) {
    assert.throws(() => scanCourses(value, 'https://www.udemy.com'));
  }
  assert.equal(isLibraryUrl('https://www.udemy.com:8443/home/my-courses/learning/'), false);
});

test('denied optional permissions create neither session data nor a new scan tab', async () => {
  const f = fixture({permission: false});
  assert.deepEqual(await startLibraryScan(f.api, message, sender), {ok: false, error: 'need-permission'});
  assert.equal(f.stored.size, 0); assert.equal(f.opened.length, 0);
});

test('accepted request stores one bounded job and opens only its extension scan URL', async () => {
  const f = fixture();
  assert.deepEqual(await startLibraryScan(f.api, message, sender), {ok: true});
  assert.equal(f.stored.size, 1); assert.equal(f.opened.length, 1);
  const [key, value] = [...f.stored][0];
  assert.match(key, /^library-[0-9a-f-]{36}$/);
  assert.deepEqual(value.courses, [course]); assert.equal(value.sourceTabId, 19); assert.equal(value.mode, 'sample');
  assert.equal(f.opened[0].url, `chrome-extension://fixture/library-scan.html?job=${key}`);
});

test('failed scan-tab creation rolls back its session job', async () => {
  const f = fixture({failOpen: true});
  await assert.rejects(startLibraryScan(f.api, message, sender), /Tab failed/);
  assert.equal(f.stored.size, 0); assert.equal(f.removed.length, 1);
});

test('importing background constants from a scan document registers no competing runtime listener', async () => {
  const priorChrome = globalThis.chrome, priorDocument = globalThis.document;
  let listeners = 0;
  try {
    globalThis.document = {};
    globalThis.chrome = {runtime: {onMessage: {addListener() {listeners++;}}}};
    await import(`../extension/library-background.mjs?document-context-regression=${Date.now()}`);
    assert.equal(listeners, 0);
  } finally {
    if (priorChrome === undefined) delete globalThis.chrome; else globalThis.chrome = priorChrome;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
});

function workerFixture({ownerGone = false} = {}) {
  const ownerUrl = 'chrome-extension://fixture/library-scan.html?job=library-fixture';
  const stored = new Map(), opened = [], removed = [];
  let ownerReads = 0;
  const api = {
    runtime: {id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`},
    tabs: {
      async get(id) {ownerReads++; if (ownerGone && ownerReads > 1) throw new Error('Owner closed'); return {id, url: ownerUrl};},
      async create(value) {opened.push(value); return {id: 50};},
      async remove(id) {removed.push(id);}
    },
    storage: {session: {async set(values) {for (const [key, value] of Object.entries(values)) stored.set(key, value);},
      async remove(key) {stored.delete(key);}, async get(key) {return {[key]: stored.get(key)};}}}
  };
  return {api, stored, opened, removed, sender: {id: 'fixture', url: ownerUrl}, message: {ownerTabId: 9, url: `${course.courseKey}/learn/lecture/11?private=token#overview`}};
}

test('background worker creation requires the owning extension scan page and strips query data', async () => {
  const f = workerFixture();
  assert.deepEqual(await openWorkerTab(f.api, f.message, f.sender), {ok: true, tab: {id: 50}});
  assert.deepEqual(f.opened, [{url: `${course.courseKey}/learn/lecture/11`, active: false}]);
  assert.equal(f.stored.get('libraryOwned:9'), 50);
  for (const sender of [{...f.sender, id: 'other'}, {...f.sender, url: 'https://www.udemy.com/home/my-courses/learning/'},
    {...f.sender, url: 'chrome-extension://fixture/library-scan.html?job=another'}]) {
    const g = workerFixture();
    await assert.rejects(openWorkerTab(g.api, g.message, sender)); assert.equal(g.opened.length, 0);
  }
});

test('background closes its worker if the owning scan page vanished during tab creation', async () => {
  const f = workerFixture({ownerGone: true});
  await assert.rejects(openWorkerTab(f.api, f.message, f.sender), /Owner closed/);
  assert.deepEqual(f.removed, [50]);
});

test('numeric library links retain only the course ID when the background opens a worker',async()=>{
  const f=workerFixture();
  await openWorkerTab(f.api,{...f.message,url:'https://www.udemy.com/course-dashboard-redirect/?course_id=12345&tracking=private#overview'},f.sender);
  assert.deepEqual(f.opened,[{url:'https://www.udemy.com/course-dashboard-redirect/?course_id=12345',active:false}]);
});

test('background cleanup closes only recorded workers when an owner reloads or closes', async () => {
  const priorChrome = globalThis.chrome, priorDocument = globalThis.document;
  const saved = new Map([['libraryOwned:9', 50], ['libraryOwned:10', 51]]), removed = [];
  const listeners = {};
  try {
    delete globalThis.document;
    globalThis.chrome = {
      runtime: {onMessage: {addListener(listener) {listeners.message = listener;}}, getURL: path => `chrome-extension://fixture/${path}`},
      tabs: {onRemoved: {addListener(listener) {listeners.removed = listener;}}, onUpdated: {addListener(listener) {listeners.updated = listener;}},
        async remove(id) {removed.push(id);}},
      storage: {session: {async get(key) {return {[key]: saved.get(key)};}, async remove(key) {saved.delete(key);}}}
    };
    await import(`../extension/library-background.mjs?worker-context-regression=${Date.now()}`);
    listeners.updated(9, {status: 'loading'});
    listeners.removed(10);
    listeners.updated(99, {url: 'https://example.invalid/'});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removed.sort((a, b) => a - b), [50, 51]); assert.equal(saved.size, 0);
  } finally {
    if (priorChrome === undefined) delete globalThis.chrome; else globalThis.chrome = priorChrome;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
});
