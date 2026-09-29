import test from 'node:test';
import assert from 'node:assert/strict';
import {STORAGE_PREFIX, normalizeCourse, sanitizeRecord, summarizeRecord, reasonLabel, diagnosticCode} from '../extension/library-core.mjs';

const courseKey = 'https://www.udemy.com/course/fixture-course';
const now = 1_800_000_000_000;
const result = (id, status = 'downloadable', reason = status === 'downloadable' ? 'hls-supported' : status === 'unsupported' ? 'encrypted' : 'network') =>
  ({lectureId: String(id), title: `Lecture ${id}`, status, reason});
const record = overrides => ({version: 1, courseKey, title: 'Fixture course', totalVideos: 2,
  catalogComplete: true, checkedAt: now, finished: true, mode: 'full', results: [result(1), result(2)], ...overrides});

test('course canonicalization supports course cards and lecture links without query tokens', () => {
  assert.equal(STORAGE_PREFIX, 'libraryCheck:');
  const expected = {courseKey, url: `${courseKey}/learn/`};
  for (const suffix of ['', '/', '/learn', '/learn/', '/learn/lecture/12', '/learn/lecture/12/']) {
    assert.deepEqual(normalizeCourse(`${courseKey}${suffix}?token=fixture#overview`), expected);
  }
  assert.deepEqual(normalizeCourse('/course/fixture-course/', 'https://www.udemy.com/home/my-courses/learning/'), expected);
  assert.deepEqual(normalizeCourse({url: `${courseKey}/`, title: 'Fixture\ncourse'}), {...expected, title: 'Fixture course'});
  for (const url of ['http://www.udemy.com/course/a/', 'https://udemy.com.evil.test/course/a/', 'https://udemycdn.com/course/a/',
    'https://name:secret@udemy.com/course/a/', 'https://udemy.com:8443/course/a/', 'https://udemy.com/course/a/foo',
    'https://udemy.com/course/a%2Fb/', 'https://udemy.com/course/a%5Cb/', 'https://udemy.com/course/a%00b/',
    'https://udemy.com/course/a%ZZ/', 'https://www.udemy.com/home/my-courses/learning/']) assert.equal(normalizeCourse(url), null, url);
});

test('record serialization retains only sanitized summary fields and fixed reason codes', () => {
  const unsafe = record({courseKey: `${courseKey}?token=fixture`, title: 'Fixture https://cdn.test/file?secret=fixture',
    cookies: 'secret', manifest: 'secret', results: [{...result(1), title: 'Lecture ?token=fixture', url: 'https://cdn.test/file?secret=fixture'}, result(2)]});
  const safe = sanitizeRecord(unsafe);
  assert.equal(safe.courseKey, courseKey);
  assert.equal(safe.title, 'Fixture [網址已隱藏]');
  assert.equal(safe.results[0].title, 'Lecture [查詢參數已隱藏]');
  assert.deepEqual(Object.keys(safe), ['version', 'courseKey', 'title', 'totalVideos', 'catalogComplete', 'checkedAt', 'finished', 'mode', 'results']);
  assert.deepEqual(Object.keys(safe.results[0]), ['lectureId', 'title', 'status', 'reason']);
  assert.ok(!JSON.stringify(safe).includes('secret'));
  assert.equal(sanitizeRecord(record({title: 'x'.repeat(1000)})).title.length, 240);
  assert.equal(reasonLabel('untrusted https://secret.test/'), reasonLabel('source-unconfirmed'));
});

test('library redirect identities preserve only one positive public course_id', () => {
  const redirectKey = 'https://www.udemy.com/course-dashboard-redirect/?course_id=7190737';
  const expected = {courseKey: redirectKey, url: redirectKey, courseId: '7190737'};
  assert.deepEqual(normalizeCourse(`${redirectKey}&token=secret#overview`), expected);
  assert.deepEqual(normalizeCourse('https://www.udemy.com/course-dashboard-redirect?tracking=secret&course_id=7190737'), expected);
  assert.deepEqual(normalizeCourse('/course-dashboard-redirect/?course_id=7190737', 'https://www.udemy.com/home/my-courses/learning/'), expected);
  const safe = sanitizeRecord(record({courseKey: `${redirectKey}&token=secret#overview`}));
  assert.equal(safe.courseKey, redirectKey);
  assert.ok(!JSON.stringify(safe).includes('secret'));
  for (const address of [
    'https://www.udemy.com/course-dashboard-redirect/?course_id=7190737&course_id=7190737',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=7190737&course_id=9',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=-1',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=0',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=01',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=1.5',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=123456789012345678901',
    'https://www.udemy.com/course-dashboard-redirect/?course_id=',
    'https://www.udemy.com/course-dashboard-redirect/?token=secret',
    'https://www.udemy.com/course-dashboard-redirect/extra?course_id=7190737',
    'https://udemy.com.evil.test/course-dashboard-redirect/?course_id=7190737',
    'https://udemycdn.com/course-dashboard-redirect/?course_id=7190737'
  ]) assert.equal(normalizeCourse(address), null, address);
});

test('malformed records and duplicate or contradictory evidence are rejected', () => {
  for (const overrides of [{version: 2}, {totalVideos: -1}, {totalVideos: 1}, {checkedAt: NaN}, {checkedAt: 0},
    {finished: 'true'}, {mode: 'all'}, {catalogComplete: 'true'}, {totalVideos: null},
    {results: [result(1), result(1)]}, {results: [{...result(1), lectureId: '1?token=secret'}]},
    {results: [{...result(1), status: 'yes'}]}, {results: [{...result(1), reason: 'https://secret.test/'}]},
    {results: [{...result(1), reason: 'network'}]}, {results: [result(1, 'unsupported', 'network')]},
    {results: [result(1, 'unknown', 'hls-supported')]},
    {totalVideos: 2001, results: Array.from({length: 2001}, (_, index) => result(index + 1))}]) {
    assert.equal(sanitizeRecord(record(overrides)), null, JSON.stringify(overrides).slice(0, 120));
  }
  assert.ok(sanitizeRecord(record({totalVideos: null, catalogComplete: false})));
});

test('full course labels require full mode, complete catalog, finished run and exact coverage', () => {
  assert.equal(summarizeRecord(record(), now).label, '可下載');
  assert.equal(summarizeRecord(record({results: [result(1, 'unsupported'), result(2, 'unsupported')]}), now).label, '不可下載');
  assert.equal(summarizeRecord(record({results: [result(1), result(2, 'unsupported')]}), now).label, '部分可下載');
  for (const overrides of [{mode: 'sample'}, {catalogComplete: false}, {finished: false}, {totalVideos: 3}]) {
    const summary = summarizeRecord(record(overrides), now);
    assert.equal(summary.label, '可下載（部分已確認）');
    assert.match(summary.detail, /不代表整門課/);
  }
  assert.match(summarizeRecord(record(), now).detail, /首片段.*不保證全片/);
});

test('unknown and partial failures never become full-course negative results', () => {
  assert.equal(summarizeRecord(record({mode: 'sample', results: [result(1, 'unsupported')]}), now).label, '已查部分不可下載');
  assert.equal(summarizeRecord(record({results: [result(1, 'unsupported'), result(2, 'unknown')]}), now).label, '已查部分不可下載');
  assert.equal(summarizeRecord(record({results: [result(1), result(2, 'unknown')]}), now).label, '可下載（部分已確認）');
  assert.equal(summarizeRecord(record({results: [result(1, 'unknown'), result(2, 'unknown')]}), now).label, '尚未確認');
  assert.equal(summarizeRecord(record({totalVideos: 0, results: []}), now).label, '尚未確認');
  assert.equal(summarizeRecord(null, now).label, '待檢查');
});

test('one-day old or implausibly future summaries need a recheck', () => {
  assert.equal(summarizeRecord(record(), now + 86400000).label, '需重新檢查');
  assert.equal(summarizeRecord(record(), now + 86399999).label, '可下載');
  assert.equal(summarizeRecord(record({checkedAt: now + 300001}), now).label, '需重新檢查');
});

test('fixed run issues and unknown lecture reasons remain visible without arbitrary errors', () => {
  const safe = sanitizeRecord(record({totalVideos: null, catalogComplete: false, finished: false, results: [], issue: 'course-identity-unconfirmed',
    error: 'https://private.invalid/?token=secret'}));
  assert.equal(safe.issue, 'course-identity-unconfirmed');
  assert.ok(!JSON.stringify(safe).includes('private.invalid'));
  assert.match(summarizeRecord(safe, now).detail, /尚未讀取到課程頁的課程 ID/);
  assert.match(summarizeRecord(record({results: [result(1, 'unknown', 'playback-blocked'), result(2, 'unknown', 'page-script-failed')]}), now).detail, /Chrome 未允許.*網站權限/);
  assert.equal(sanitizeRecord(record({issue: 'https://private.invalid/?token=secret'})), null);
  assert.equal(sanitizeRecord(record({issue: 'hls-supported'})), null);
  assert.notEqual(summarizeRecord(record({issue: 'source-page-changed'}), now).label, '可下載');
  assert.equal(diagnosticCode('page-script-failed'), 'page-script-failed');
  assert.equal(diagnosticCode('https://private.invalid/', 'network'), 'network');
  assert.equal(diagnosticCode('hls-supported', 'network'), 'network');
  assert.equal(diagnosticCode('constructor', 'constructor'), 'source-unconfirmed');
  assert.equal(reasonLabel('constructor'), reasonLabel('source-unconfirmed'));
  assert.equal(diagnosticCode('player-background'), 'player-background');
  assert.match(summarizeRecord(record({results: [result(1, 'unknown', 'player-background'), result(2, 'unknown', 'network')]}), now).detail, /Chrome 視窗保持可見/);
});
