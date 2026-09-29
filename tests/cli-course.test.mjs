import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {navigateCourse, collectCourse, captureLecture} from '../cli/course.mjs';

const courseKey = 'https://www.udemy.com/course/example';
const course = `${courseKey}/learn/lecture/11`;
const item = {key: '12', lectureId: '12', title: 'Next lesson', index: 2, lectureIndex: 2, sectionIndex: 1, sectionTitle: 'Start', kind: 'video', courseKey};
function fixture() {
  const calls = {install: 0, activate: 0, capture: 0, cancel: 0, collect: 0, evaluate: 0, goto: []};
  const state = {url: course, closed: false, sidebar: true, time: 0};
  const catalog = {courseKey, pageUrl: course, courseTitle: 'Example', complete: true, total: 1, notes: [], sections: [{sectionIndex: 1, title: 'Start', expectedCount: 1, items: [{...item}]}]};
  const captured = {status: 'ready', pageUrl: `${courseKey}/learn/lecture/12`, lectureId: '12', lectureTitle: item.title, assetId: '900', candidates: [{url: 'https://www.udemy.com/assets/900/master.m3u8?token=private', at: 1, isMaster: true}]};
  const api = {
    version: 'course-dom-v1',
    async collect() { calls.collect += 1; return catalog; },
    async activate(value) { calls.activate += 1; state.url = `${courseKey}/learn/lecture/${value.lectureId}`; return {ok: true, lectureId: value.lectureId}; },
    capture() { calls.capture += 1; return captured; },
    cancel() { calls.cancel += 1; return {ok: true}; },
  };
  const context = vm.createContext({UdemyCoursePage: api, document: {getElementById: () => state.sidebar ? {querySelector: () => ({})} : null}});
  const page = {
    url: () => state.url, isClosed: () => state.closed,
    async goto(url) { calls.goto.push(url); state.url = url; },
    async evaluate(fn, ...args) {
      calls.evaluate += 1;
      if (fn.toString().includes('const MAX_OBSERVED')) { calls.install += 1; context.UdemyCoursePage = api; return true; }
      context.args = args;
      return vm.runInContext(`(${fn.toString()})(...args)`, context);
    },
  };
  const options = {timeoutMs: 2000, now: () => state.time, sleep: async ms => { state.time += ms; }};
  return {session: {page}, page, api, context, calls, state, catalog, captured, options};
}

test('navigate normalizes course URLs and tolerates loading timeout', async () => {
  const f = fixture();
  await navigateCourse(f.session, `${courseKey}?ref=private`);
  assert.deepEqual(f.calls.goto, [`${courseKey}/learn/`]);
  f.page.goto = async () => { f.state.url = 'https://www.udemy.com/join/login/'; const error = new Error(); error.name = 'TimeoutError'; throw error; };
  await navigateCourse(f.session, course);
  assert.equal(f.calls.evaluate, 0);
});

test('collect waits through manual login without evaluating the login DOM', async () => {
  const f = fixture(); f.state.url = 'https://www.udemy.com/join/login/';
  const options = {...f.options, sleep: async ms => { assert.equal(f.calls.evaluate, 0); f.state.time += ms; f.state.url = course; }};
  assert.equal(await collectCourse(f.session, course, options), f.catalog);
  assert.equal(f.calls.collect, 1);
});

test('collect preserves incomplete catalog and rejects wrong or duplicate lecture identity', async () => {
  const f = fixture(); f.catalog.complete = false; f.catalog.sections[0].expectedCount = 2;
  assert.equal((await collectCourse(f.session, course, f.options)).complete, false);
  f.catalog.sections[0].items.push({...item}); f.catalog.total = 2;
  await assert.rejects(collectCourse(f.session, course, f.options), /講座資料不一致/);
  f.catalog.courseKey = 'https://www.udemy.com/course/other';
  await assert.rejects(collectCourse(f.session, course, f.options), /目錄回傳資料不一致/);
});

test('collect detects manual course change and never inspects other course DOM', async () => {
  const f = fixture(); f.state.url = 'https://www.udemy.com/course/other/learn/';
  await assert.rejects(collectCourse(f.session, course, f.options), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.evaluate, 0);
});

test('capture activates once, waits for pending asset guards and returns matching media', async () => {
  const f = fixture();
  f.api.capture = () => ++f.calls.capture < 3 ? {status: 'pending', reason: 'asset not switched'} : f.captured;
  assert.equal(await captureLecture(f.session, item, f.options), f.captured);
  assert.equal(f.calls.activate, 1); assert.equal(f.calls.capture, 3);
});

test('full navigation reinstalls adapter without repeating the play click', async () => {
  const f = fixture(), activate = f.api.activate;
  f.api.activate = async value => { await activate(value); f.context.UdemyCoursePage = undefined; return {ok: true}; };
  assert.equal(await captureLecture(f.session, item, f.options), f.captured);
  assert.equal(f.calls.activate, 1); assert.equal(f.calls.install, 2);
});

test('manual switch after a completed capture remains fatal even if the page realm reloads', async () => {
  const f = fixture();
  await captureLecture(f.session, item, f.options);
  f.context.UdemyCoursePage = undefined;
  f.state.url = `${courseKey}/learn/lecture/99`;
  await assert.rejects(captureLecture(f.session, {...item, key: '13', lectureId: '13'}, f.options), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.activate, 1);
});

test('unexpected lesson navigation while capture is pending stops without another play click', async () => {
  const f = fixture(); f.api.capture = () => { f.state.url = `${courseKey}/learn/lecture/99`; return {status: 'pending'}; };
  await assert.rejects(captureLecture(f.session, item, f.options), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.activate, 1);
});

test('DRM refusal is preserved without becoming a session-wide failure', async () => {
  const f = fixture(); f.api.capture = () => { throw new Error('播放器使用受保護的媒體金鑰；此工具不處理 DRM。'); };
  await assert.rejects(captureLecture(f.session, item, f.options), error => /DRM/.test(error.message) && !error.code);
  assert.equal(f.calls.cancel, 1);
});

test('successful lecture then DRM refusal still allows the next confirmed lecture', async () => {
  const f = fixture();
  const drmItem = {...item, key: '13', lectureId: '13', title: 'Protected lesson'};
  const nextItem = {...item, key: '14', lectureId: '14', title: 'Later lesson'};
  f.api.capture = value => {
    if (value.lectureId === '13') throw new Error('播放器使用受保護的媒體金鑰；此工具不處理 DRM。');
    return {...f.captured, pageUrl: `${courseKey}/learn/lecture/${value.lectureId}`, lectureId: value.lectureId, lectureTitle: value.title};
  };
  assert.equal((await captureLecture(f.session, item, f.options)).lectureId, '12');
  await assert.rejects(captureLecture(f.session, drmItem, f.options), error => error.drmRejected && !error.code);
  assert.equal((await captureLecture(f.session, nextItem, f.options)).lectureId, '14');
  assert.equal(f.calls.activate, 3);
});

test('manual navigation during a DRM refusal is fatal and never advances the session baseline', async () => {
  const f = fixture();
  await captureLecture(f.session, item, f.options);
  f.api.capture = () => {
    f.state.url = `${courseKey}/learn/lecture/99`;
    throw new Error('播放器使用受保護的媒體金鑰；此工具不處理 DRM。');
  };
  await assert.rejects(captureLecture(f.session, {...item, key: '13', lectureId: '13'}, f.options), {code: 'COURSE_SESSION_LOST'});
  await assert.rejects(captureLecture(f.session, {...item, key: '14', lectureId: '14'}, f.options), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.activate, 2);
});

test('timeout after switching lecture never advances the confirmed session baseline', async () => {
  const f = fixture();
  await captureLecture(f.session, item, f.options);
  f.api.capture = () => ({status: 'pending'});
  await assert.rejects(captureLecture(f.session, {...item, key: '13', lectureId: '13'}, {...f.options, timeoutMs: 100}), {code: 'COURSE_SESSION_LOST'});
  await assert.rejects(captureLecture(f.session, {...item, key: '14', lectureId: '14'}, f.options), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.activate, 2);
});

test('capture refuses mismatched lecture, stale asset URLs and external candidates', async () => {
  for (const mutate of [f => { f.captured.lectureId = '11'; }, f => { f.captured.candidates[0].url = 'https://www.udemy.com/assets/899/master.m3u8?secret=private'; }, f => { f.captured.candidates[0].url = 'https://example.com/assets/900/master.m3u8?secret=private'; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(captureLecture(f.session, item, f.options), error => error.code === 'COURSE_SESSION_LOST' && !error.message.includes('private'));
  }
});

test('manual lesson change reported by adapter stops the session and strips any URL from errors', async () => {
  const f = fixture();
  f.api.capture = () => { throw new Error('偵測到手動切換講座 https://www.udemy.com/assets/900/master.m3u8?token=private'); };
  await assert.rejects(captureLecture(f.session, item, f.options), error => error.code === 'COURSE_SESSION_LOST' && !error.message.includes('private'));
});

test('capture timeout cancels page activity and is fatal to the batch session', async () => {
  const f = fixture(); f.api.capture = () => ({status: 'pending'});
  await assert.rejects(captureLecture(f.session, item, {...f.options, timeoutMs: 100}), {code: 'COURSE_SESSION_LOST'});
  assert.equal(f.calls.cancel, 1);
});

test('abort during pending activation calls adapter cancellation', async () => {
  const f = fixture(), controller = new AbortController();
  f.api.activate = () => new Promise(() => {});
  const pending = captureLecture(f.session, item, {...f.options, signal: controller.signal});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(f.calls.cancel, 1);
});

test('abort during pending collection calls adapter cancellation', async () => {
  const f = fixture(), controller = new AbortController();
  f.api.collect = () => new Promise(() => {});
  const pending = collectCourse(f.session, course, {...f.options, signal: controller.signal});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(f.calls.cancel, 1);
});
