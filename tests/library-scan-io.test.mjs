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
  redirectTo = `${course.courseKey}/learn/lecture/11`, moduleArgs = [JSON.stringify({courseId: 7190737})], timeoutMs = 1000, onProbe = () => {}} = {}) {
  let id = 10, clock = 1000;
  const tabs = new Map(), created = [], removed = [], probed = [], readUrls = [], scripts = [], updated = [], queried = [];
  const api = {
    tabs: {
      async create(options) {const tab = {id: ++id, windowId: 1, active: false, url: options.url.includes('/course-dashboard-redirect') ? redirectTo : options.url, status: 'complete'}; tabs.set(tab.id, tab); created.push(options); return tab;},
      async get(key) {if (!tabs.has(key)) throw new Error('Tab closed'); return tabs.get(key);},
      async query(options) {queried.push(options); return [...tabs.values()].filter(tab => tab.active && tab.windowId === options.windowId).map(tab => ({...tab}));},
      async update(key, options) {
        if (!tabs.has(key)) throw new Error('Tab closed');
        updated.push({id: key, ...options});
        const tab = tabs.get(key);
        if (options.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = other.id === key;
        return {...tab};
      },
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
        return [{result: typeof state === 'function' ? state({tab: tabs.get(options.target.tabId), clock, tabs, updated}) : state}];
      }
      return [{result: {ok: true}}];
    }}
  };
  const inspector = createInspector(api, {signal, timeoutMs, now: () => clock, sleep: async ms => {clock += ms;},
    probe: async (value, options) => {probed.push(value); assert.equal(await options.permissionCheck('https://www.udemy.com/*'), true); await onProbe(); return supported;},
    read: async (url, options) => {readUrls.push(url); assert.equal(options.maxBytes, 2 * 1024 * 1024); if (readError) throw new Error('https://private.invalid/token'); return new TextEncoder().encode('<MPD/>');},
    parseXml: () => ({documentElement: {localName: xmlValid ? 'MPD' : 'html', namespaceURI: 'urn:mpeg:dash:schema:mpd:2011'},
      querySelector: () => null, getElementsByTagNameNS: () => xmlProtected ? [{getAttribute: name => name === 'schemeIdUri' ? 'urn:mpeg:dash:mp4protection:2011' : null}] : []})
  });
  return {api, inspector, tabs, created, removed, probed, readUrls, scripts, updated, queried};
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
  assert.deepEqual(await switched.inspector.inspect(course, item()), {status: 'unknown', reason: 'source-page-changed'}); assert.equal(switched.probed.length, 0);
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
    onRecord: async value => saved.push(value)}), {code: 'course-identity-mismatch'});
  assert.equal(f.probed.length, 0); assert.equal(f.readUrls.length, 0); assert.equal(f.tabs.size, 0);
  assert.equal(saved.at(-1).results.length, 0); assert.equal(saved.at(-1).finished, false);
  assert.equal(saved.at(-1).issue, 'course-identity-mismatch');
  assert.equal(summarizeRecord(saved.at(-1), 1800000000000).label, '尚未確認');
});

test('missing, duplicate, malformed, or unsafe module course IDs cannot bind a numeric course alias', async () => {
  for (const moduleArgs of [[], ['{}'], ['not-json'], ['null'], [JSON.stringify({courseId: 7190737}), JSON.stringify({courseId: 7190737})],
    [JSON.stringify({courseId: 7190737.5})], [JSON.stringify({courseId: '7190737x'})], [JSON.stringify({courseId: 0})],
    [JSON.stringify({courseId: 9007199254740992})]]) {
    const f = fixture({moduleArgs});
    await assert.rejects(checkCourse(numericCourse, 'full', {inspector: f.inspector, now: () => 1800000000000}), {code: 'course-identity-unconfirmed'});
    assert.equal(f.probed.length, 0); assert.equal(f.tabs.size, 0);
  }
});

test('numeric course aliases reject a redirect to a different origin before reading its course metadata', async () => {
  const f = fixture({redirectTo: 'https://other.udemy.com/course/fixture-course/learn/lecture/11'});
  await assert.rejects(checkCourse(numericCourse, 'full', {inspector: f.inspector, now: () => 1800000000000}), {code: 'course-unavailable'});
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
    assert.deepEqual(await f.inspector.inspect(course, item()), {status: 'unknown', reason: options.readError ? 'network' : 'dash-invalid'}); assert.equal(f.tabs.size, 0);
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

const hiddenPending = {status: 'pending', reasonCode: 'player-loading', needsForeground: true};
function foregroundContext(f) {
  f.tabs.set(99, {id: 99, windowId: 1, active: true, url: 'https://www.udemy.com/home/my-courses/learning/', status: 'complete'});
  f.tabs.set(88, {id: 88, windowId: 1, active: false, url: 'https://example.invalid/user-tab', status: 'complete'});
  f.tabs.set(77, {id: 77, windowId: 2, active: true, url: 'https://example.invalid/other-window', status: 'complete'});
}

test('hidden source waits 1500ms then activates only its worker once and restores before probing', async () => {
  let lastClock = 0;
  const f = fixture({timeoutMs: 6000, state: ({tab, clock}) => {lastClock = clock; return tab.active ? capture() : hiddenPending;},
    onProbe: () => {assert.equal(f.tabs.get(99).active, true); assert.equal(f.tabs.get(11).active, false);}});
  foregroundContext(f);
  const update = f.api.tabs.update;
  f.api.tabs.update = async (id, options) => {
    if (id === 11) assert.equal(lastClock, 2500);
    return update(id, options);
  };
  assert.deepEqual(await f.inspector.inspect(course, item()), supported);
  assert.deepEqual(f.updated, [{id: 11, active: true}, {id: 99, active: true}]);
  assert.ok(f.queried.every(query => query.active === true && query.windowId === 1));
  assert.equal(f.tabs.get(77).active, true);
  assert.deepEqual(f.removed, [11]);
});

test('foreground fallback runs once and reports a still-hidden Chrome window without forcing focus', async () => {
  const f = fixture({timeoutMs: 6000, state: hiddenPending}); foregroundContext(f);
  assert.deepEqual(await f.inspector.inspect(course, item()), {status: 'unknown', reason: 'player-background'});
  assert.deepEqual(f.updated, [{id: 11, active: true}, {id: 99, active: true}]);
  assert.deepEqual(f.removed, [11]);
});

test('foreground fallback requires the exact flag, reason and continuous waiting window', async () => {
  for (const state of [{status: 'pending', reasonCode: 'player-loading'},
    {status: 'pending', reasonCode: 'source-unconfirmed', needsForeground: true},
    ({clock}) => clock < 2000 ? hiddenPending : {status: 'pending', reasonCode: 'source-unconfirmed'}]) {
    const f = fixture({timeoutMs: 4000, state}); foregroundContext(f);
    assert.equal((await f.inspector.inspect(course, item())).status, 'unknown');
    assert.equal(f.updated.length, 0); assert.equal(f.tabs.get(99).active, true);
  }
});

test('restoration respects a manual switch to another tab after worker activation', async () => {
  const f = fixture({timeoutMs: 6000, state: ({tab, tabs}) => {
    if (!tab.active) return hiddenPending;
    tab.active = false; tabs.get(88).active = true;
    return capture();
  }});
  foregroundContext(f);
  assert.deepEqual(await f.inspector.inspect(course, item()), supported);
  assert.deepEqual(f.updated, [{id: 11, active: true}]);
  assert.equal(f.tabs.get(88).active, true); assert.equal(f.tabs.get(99).active, false);
  assert.deepEqual(f.removed, [11]);
});

test('source navigation or a manual tab switch during the activation check prevents activation', async () => {
  for (const changeSource of [false, true]) {
    const f = fixture({timeoutMs: 4000, state: hiddenPending}); foregroundContext(f);
    const query = f.api.tabs.query;
    let changed = false;
    f.api.tabs.query = async options => {
      const result = await query(options);
      if (!changed) {
        changed = true;
        if (changeSource) f.tabs.get(11).url = `${course.courseKey}/learn/lecture/12`;
        else {f.tabs.get(99).active = false; f.tabs.get(88).active = true;}
      }
      return result;
    };
    assert.equal((await f.inspector.inspect(course, item())).status, 'unknown');
    assert.equal(f.updated.length, 0);
    assert.equal(f.tabs.get(changeSource ? 99 : 88).active, true);
  }
});

test('abort while activation is pending waits for it, restores focus and closes only the worker', async () => {
  const controller = new AbortController(), activated = deferred(), release = deferred();
  const f = fixture({timeoutMs: 6000, state: hiddenPending, signal: controller.signal}); foregroundContext(f);
  const update = f.api.tabs.update;
  f.api.tabs.update = async (id, options) => {
    if (id === 11) {activated.resolve(); await release.promise;}
    return update(id, options);
  };
  const running = f.inspector.inspect(course, item());
  await activated.promise;
  controller.abort();
  const stopping = f.inspector.close();
  release.resolve();
  await assert.rejects(running, {name: 'AbortError'});
  await stopping;
  assert.deepEqual(f.updated, [{id: 11, active: true}, {id: 99, active: true}]);
  assert.deepEqual(f.removed, [11]); assert.equal(f.tabs.get(99).active, true);
});

test('closing during a pending activation does not override a later manual active tab', async () => {
  const controller = new AbortController(), activated = deferred(), release = deferred();
  const f = fixture({timeoutMs: 6000, state: hiddenPending, signal: controller.signal}); foregroundContext(f);
  const update = f.api.tabs.update;
  f.api.tabs.update = async (id, options) => {
    const result = await update(id, options);
    if (id === 11) {activated.resolve(); await release.promise;}
    return result;
  };
  const running = f.inspector.inspect(course, item());
  await activated.promise;
  controller.abort();
  const stopping = f.inspector.close();
  f.tabs.get(11).active = false; f.tabs.get(88).active = true;
  release.resolve();
  await assert.rejects(running, {name: 'AbortError'}); await stopping;
  assert.deepEqual(f.updated, [{id: 11, active: true}]);
  assert.equal(f.tabs.get(88).active, true); assert.deepEqual(f.removed, [11]);
});

test('the last fixed player pending reason survives the polling deadline', async () => {
  for (const reasonCode of ['playback-blocked', 'lecture-unconfirmed', 'asset-unconfirmed', 'player-title-unconfirmed', 'source-ambiguous', 'player-loading']) {
    const f = fixture({state: {status: 'pending', reasonCode, reason: 'https://private.invalid/?token=secret'}});
    assert.deepEqual(await f.inspector.inspect(course, item()), {status: 'unknown', reason: reasonCode});
    assert.equal(f.tabs.size, 0);
  }
  const unsafe = fixture({state: {status: 'pending', reasonCode: 'https://private.invalid/token'}});
  assert.deepEqual(await unsafe.inspector.inspect(course, item()), {status: 'unknown', reason: 'timeout'});
});

test('untyped worker and injection errors use their phase without exposing raw error messages', async () => {
  const worker = fixture();
  worker.api.tabs.create = async () => {throw new Error('https://private.invalid/?token=secret');};
  assert.deepEqual(await worker.inspector.inspect(course, item()), {status: 'unknown', reason: 'worker-open-failed'});
  const injection = fixture();
  injection.api.scripting.executeScript = async () => {throw new Error('https://private.invalid/?token=secret');};
  assert.deepEqual(await injection.inspector.inspect(course, item()), {status: 'unknown', reason: 'page-script-failed'});
  assert.equal(injection.tabs.size, 0);
  const playerError = fixture({state: {status: 'error', code: 'lecture-unconfirmed', message: 'https://private.invalid/?token=secret'}});
  assert.deepEqual(await playerError.inspector.inspect(course, item()), {status: 'unknown', reason: 'lecture-unconfirmed'});
});

test('collection and lock failures persist safe run issues and never claim a finished course', async () => {
  for (const typed of [false, true]) {
    const saved = [];
    const inspector = {async collect() {
      const error = new Error('https://private.invalid/?token=secret');
      if (typed) error.code = 'page-script-failed';
      throw error;
    }, async close() {}};
    const code = typed ? 'page-script-failed' : 'catalog-unavailable';
    await assert.rejects(checkCourse(course, 'sample', {inspector, now: () => 1800000000000, onRecord: async value => saved.push(value)}), {code});
    assert.equal(saved.at(-1).issue, code);
    assert.equal(saved.at(-1).finished, false);
    assert.ok(!JSON.stringify(saved).includes('private.invalid'));
  }
  const saved = [];
  const inspector = {async collect() {return {courseKey: course.courseKey, complete: true, items: [item()]};}, async close() {}};
  await assert.rejects(checkCourse(course, 'sample', {inspector, now: () => 1800000000000, onRecord: async value => saved.push(value),
    withCourseLock: async () => {throw new Error('busy https://private.invalid/');}}), {code: 'lock-unavailable'});
  assert.equal(saved.at(-1).issue, 'lock-unavailable');
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
  assert.deepEqual(await running, {status: 'unknown', reason: 'cancelled'});
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
