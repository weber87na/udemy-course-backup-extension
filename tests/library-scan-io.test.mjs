import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createInspector, checkCourse} from '../extension/library-scan-io.mjs';
import {summarizeRecord} from '../extension/library-core.mjs';

const course = {courseKey: 'https://www.udemy.com/course/fixture-course', title: 'Fixture course'};
const item = (id = '11', kind = 'video') => ({...course, lectureId: id, title: `Lecture ${id}`, kind});
const capture = (kind = 'hls', overrides = {}) => ({status: 'ready', kind, lectureId: '11', assetId: '9000',
  pageUrl: `${course.courseKey}/learn/lecture/11`, candidates: [{url: kind === 'hls'
    ? 'https://www.udemy.com/assets/9000/manifest.m3u8?private=token'
    : 'https://dash.udemycdn.com/manifest.mpd?private=token', isMaster: true, at: 1}], ...overrides});
const supported = {status: 'downloadable', reason: 'hls-supported'};
const unknown = {status: 'unknown', reason: 'source-unconfirmed'};
function deferred() { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; }

function fixture({state = capture(), signal, tabChanged = false, readError = false, xmlProtected = false, xmlValid = true,
  redirectTo = `${course.courseKey}/learn/lecture/11`, moduleArgs = [JSON.stringify({courseId: 7190737})]} = {}) {
  let id = 10, clock = 1000;
  const tabs = new Map(), created = [], removed = [], probed = [], readUrls = [], scripts = [];
  const api = {
    tabs: {
      async create(options) {const tab = {id: ++id, url: options.url.includes('/course-dashboard-redirect') ? redirectTo : options.url, status: 'complete'}; tabs.set(tab.id, tab); created.push(options); return tab;},
      async get(key) {if (!tabs.has(key)) throw new Error('Tab closed'); return tabs.get(key);},
      async remove(key) {removed.push(key); tabs.delete(key);}
    },
    permissions: {async contains() {return true;}},
    scripting: {async executeScript(options) {
      scripts.push(options);
      if (options.files) return [];
      if (options.func.toString().includes('data-module-id="course-taking"')) {
        const document = {querySelectorAll: selector => {
          assert.equal(selector, '[data-module-id="course-taking"][data-module-args]');
          return moduleArgs.map(value => ({getAttribute: name => {assert.equal(name, 'data-module-args'); return value;}}));
        }};
        return [{result: vm.runInNewContext(`(${options.func.toString()})()`, {document})}];
      }
      if (options.args?.[0] === 'collect') return [{result: {ok: true, value: {courseKey: course.courseKey,
        courseTitle: course.title, complete: true, sections: [{items: [item()]}]}}}];
      if (options.func.toString().includes('UdemyLibraryPlayer.inspect')) {
        if (tabChanged) tabs.get(options.target.tabId).url = `${course.courseKey}/learn/lecture/12`;
        return [{result: state}];
      }
      return [{result: {ok: true}}];
    }}
  };
  const inspector = createInspector(api, {signal, timeoutMs: 1000, now: () => clock, sleep: async ms => {clock += ms;},
    probe: async (value, options) => {probed.push(value); assert.equal(await options.permissionCheck('https://www.udemy.com/*'), true); return supported;},
    read: async (url, options) => {readUrls.push(url); assert.equal(options.maxBytes, 2 * 1024 * 1024); if (readError) throw new Error('https://private.invalid/token'); return new TextEncoder().encode('<MPD/>');},
    parseXml: () => ({documentElement: {localName: xmlValid ? 'MPD' : 'html', namespaceURI: 'urn:mpeg:dash:schema:mpd:2011'},
      querySelector: () => null, getElementsByTagNameNS: () => xmlProtected ? [{getAttribute: name => name === 'schemeIdUri' ? 'urn:mpeg:dash:mp4protection:2011' : null}] : []})
  });
  return {api, inspector, tabs, created, removed, probed, readUrls, scripts};
}

test('inspector creates a fresh background document for every lecture and only closes its owned tabs', async () => {
  const f = fixture();
  f.tabs.set(99, {id: 99, url: course.courseKey, status: 'complete'});
  assert.deepEqual(await f.inspector.inspect(course, item()), supported);
  assert.deepEqual(await f.inspector.inspect(course, item()), supported);
  assert.equal(f.created.length, 2); assert.ok(f.created.every(tab => tab.active === false));
  assert.ok(f.created.every(tab => tab.url === `${course.courseKey}/learn/lecture/11`));
  assert.deepEqual(f.removed, [11, 12]); assert.ok(f.tabs.has(99));
  assert.equal(f.probed.length, 2);
});

test('source identity, lecture changes, and foreign asset HLS cannot become positive evidence', async () => {
  for (const state of [capture('hls', {lectureId: '12'}), capture('hls', {assetId: '9001'}),
    capture('hls', {pageUrl: `${course.courseKey}/learn/lecture/12`}),
    capture('hls', {candidates: [{url: 'https://cdn.udemycdn.com/assets/9000/video.m3u8'}]})]) {
    const f = fixture({state});
    assert.deepEqual(await f.inspector.inspect(course, item()), unknown); assert.equal(f.probed.length, 0);
    assert.equal(f.tabs.size, 0);
  }
  const switched = fixture({tabChanged: true});
  assert.deepEqual(await switched.inspector.inspect(course, item()), unknown); assert.equal(switched.probed.length, 0);
});

const numericCourse = {courseKey: 'https://www.udemy.com/course-dashboard-redirect/?course_id=7190737', title: 'Fixture course'};

test('numeric course alias binds the redirected slug through the document course ID before inspection', async () => {
  for (const courseId of [7190737, '7190737']) {
    const f = fixture({moduleArgs: [JSON.stringify({courseId, otherField: 'unrelated private data'})]});
    const saved = [];
    const record = await checkCourse(numericCourse, 'full', {inspector: f.inspector, now: () => 1800000000000,
      onRecord: async value => saved.push(value)});
    assert.equal(f.created[0].url, numericCourse.courseKey);
    assert.equal(f.created[1].url, `${course.courseKey}/learn/lecture/11`);
    assert.equal(record.courseKey, numericCourse.courseKey);
    assert.equal(record.results[0].status, 'downloadable');
    assert.equal(summarizeRecord(record, 1800000000000).label, '可下載');
    assert.equal(f.tabs.size, 0); assert.equal(f.probed.length, 1);
    assert.ok(saved.every(value => !JSON.stringify(value).includes('unrelated private data')));
  }
});

test('a numeric alias with a mismatched document course ID never inspects or classifies another course', async () => {
  const f = fixture({moduleArgs: [JSON.stringify({courseId: 7190738})]}), saved = [];
  await assert.rejects(checkCourse(numericCourse, 'full', {inspector: f.inspector, now: () => 1800000000000,
    onRecord: async value => saved.push(value)}), /課程 ID 與卡片不一致/);
  assert.equal(f.probed.length, 0); assert.equal(f.readUrls.length, 0); assert.equal(f.tabs.size, 0);
  assert.equal(saved.at(-1).results.length, 0); assert.equal(saved.at(-1).finished, false);
  assert.equal(summarizeRecord(saved.at(-1), 1800000000000).label, '尚未確認');
});

test('missing, duplicate, malformed, or unsafe module course IDs cannot bind a numeric course alias', async () => {
  for (const moduleArgs of [[], ['{}'], ['not-json'], ['null'], [JSON.stringify({courseId: 7190737}), JSON.stringify({courseId: 7190737})],
    [JSON.stringify({courseId: 7190737.5})], [JSON.stringify({courseId: '7190737x'})], [JSON.stringify({courseId: 0})],
    [JSON.stringify({courseId: 9007199254740992})]]) {
    const f = fixture({moduleArgs});
    await assert.rejects(checkCourse(numericCourse, 'full', {inspector: f.inspector, now: () => 1800000000000}), /課程 ID 與卡片不一致/);
    assert.equal(f.probed.length, 0); assert.equal(f.tabs.size, 0);
  }
});

test('numeric course aliases reject a redirect to a different origin before reading its course metadata', async () => {
  const f = fixture({redirectTo: 'https://other.udemy.com/course/fixture-course/learn/lecture/11'});
  await assert.rejects(checkCourse(numericCourse, 'full', {inspector: f.inspector, now: () => 1800000000000}), /需要登入或無法開啟/);
  assert.equal(f.probed.length, 0); assert.equal(f.tabs.size, 0);
  assert.ok(f.scripts.every(options => !options.func?.toString().includes('data-module-id="course-taking"')));
});

test('DASH classification depends on parsed MPD ContentProtection rather than mediaKeys', async () => {
  for (const xmlProtected of [false, true]) {
    const f = fixture({state: capture('dash'), xmlProtected});
    assert.deepEqual(await f.inspector.inspect(course, item()), {status: 'unsupported', reason: xmlProtected ? 'dash-drm' : 'dash'});
    assert.equal(f.readUrls.length, 1); assert.equal(f.probed.length, 0); assert.equal(f.tabs.size, 0);
  }
});

test('malformed MPD and request failures remain unknown without leaking the error URL', async () => {
  for (const options of [{xmlValid: false}, {readError: true}]) {
    const f = fixture({state: capture('dash'), ...options});
    assert.deepEqual(await f.inspector.inspect(course, item()), unknown); assert.equal(f.tabs.size, 0);
  }
});

test('DASH candidate URL is independently restricted before any manifest read', async () => {
  for (const url of ['https://www.udemy.com/license.mpd', 'https://udemycdn.com.evil.invalid/video.mpd',
    'http://dash.udemycdn.com/video.mpd', 'https://user:secret@dash.udemycdn.com/video.mpd',
    'https://dash.udemycdn.com:8443/video.mpd', 'https://dash.udemycdn.com/license']) {
    const f = fixture({state: capture('dash', {candidates: [{url}]})});
    assert.deepEqual(await f.inspector.inspect(course, item()), unknown, url);
    assert.equal(f.readUrls.length, 0); assert.equal(f.tabs.size, 0);
  }
});

test('source polling timeout remains unknown and closes the inspection tab', async () => {
  const f = fixture({state: {status: 'pending', reason: 'Waiting for player'}});
  assert.deepEqual(await f.inspector.inspect(course, item()), {status: 'unknown', reason: 'timeout'});
  assert.equal(f.tabs.size, 0); assert.equal(f.probed.length, 0);
});

test('cancel before inspect opens no tab and returns AbortError', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture({signal: controller.signal});
  await assert.rejects(f.inspector.inspect(course, item()), {name: 'AbortError'});
  assert.equal(f.created.length, 0); assert.equal(f.tabs.size, 0);
});

test('cancel while tabs.create is pending closes the late-created tab once control returns', async () => {
  const controller = new AbortController(), created = deferred(), entered = deferred();
  const f = fixture({signal: controller.signal});
  f.api.tabs.create = async () => {entered.resolve(); return created.promise;};
  const running = f.inspector.inspect(course, item());
  await entered.promise;
  controller.abort(); await f.inspector.close();
  f.tabs.set(50, {id: 50, url: `${course.courseKey}/learn/lecture/11`, status: 'complete'});
  created.resolve(f.tabs.get(50));
  await assert.rejects(running, {name: 'AbortError'});
  assert.deepEqual(f.removed, [50]); assert.equal(f.tabs.size, 0);
});

test('explicit close during a pending open invalidates its generation even without an abort signal', async () => {
  const created = deferred(), entered = deferred(), f = fixture();
  f.api.tabs.create = async () => {entered.resolve(); return created.promise;};
  const running = f.inspector.inspect(course, item());
  await entered.promise; await f.inspector.close();
  f.tabs.set(50, {id: 50, url: `${course.courseKey}/learn/lecture/11`, status: 'complete'});
  created.resolve(f.tabs.get(50));
  assert.deepEqual(await running, unknown);
  assert.equal(f.probed.length, 0); assert.deepEqual(f.removed, [50]);
});

test('full check persists only summary fields and gives a full label only after exact coverage', async () => {
  const saved = [], inspected = [], close = [];
  const inspector = {async collect() {return {courseKey: course.courseKey, courseTitle: 'Fixture', complete: true, items: [item(), item('12'), item('13', 'article')]};},
    async inspect(_course, value) {inspected.push(value.lectureId); return {...supported, url: 'https://private.invalid/token'};}, async close() {close.push(true);}};
  const record = await checkCourse(course, 'full', {inspector, now: () => 1800000000000, onRecord: async value => saved.push(value)});
  assert.deepEqual(inspected, ['11', '12']); assert.equal(record.totalVideos, 2);
  assert.equal(saved[0].finished, false); assert.equal(saved.at(-2).finished, false); assert.equal(saved.at(-1).finished, true);
  assert.ok(saved.every(value => !JSON.stringify(value).includes('private.invalid')));
  assert.equal(summarizeRecord(record, 1800000000000).label, '可下載'); assert.equal(close.length, 1);
});

test('sampling one unsupported lecture never marks the whole course undownloadable', async () => {
  const inspected = [];
  const inspector = {async collect() {return {courseKey: course.courseKey, complete: true, items: [item(), item('12')]};},
    async inspect(_course, value) {inspected.push(value.lectureId); return {status: 'unsupported', reason: 'dash-drm'};}, async close() {}};
  const record = await checkCourse(course, 'sample', {inspector, now: () => 1800000000000});
  assert.deepEqual(inspected, ['11']); assert.equal(record.finished, true);
  assert.equal(summarizeRecord(record, 1800000000000).label, '已查部分不可下載');
});

test('unknown catalog item types prevent a full-course conclusion', async () => {
  const inspector = {async collect() {return {courseKey: course.courseKey, complete: true, items: [item(), item('12', 'unknown')]};},
    async inspect() {return supported;}, async close() {}};
  const record = await checkCourse(course, 'full', {inspector, now: () => 1800000000000});
  assert.equal(record.catalogComplete, false);
  assert.equal(summarizeRecord(record, 1800000000000).label, '可下載（部分已確認）');
});

test('cancellation preserves completed lecture evidence but never marks the run complete', async () => {
  const controller = new AbortController(), saved = [];
  let closed = false, count = 0;
  const inspector = {async collect() {return {courseKey: course.courseKey, complete: true, items: [item(), item('12')]};},
    async inspect() {count++; if (count === 2) controller.abort(); return supported;}, async close() {closed = true;}};
  await assert.rejects(checkCourse(course, 'full', {inspector, signal: controller.signal, now: () => 1800000000000,
    onRecord: async value => saved.push(value)}), {name: 'AbortError'});
  const last = saved.at(-1);
  assert.equal(last.finished, false); assert.equal(last.results.length, 1); assert.equal(closed, true);
  assert.notEqual(summarizeRecord(last, 1800000000000).label, '可下載');
});
