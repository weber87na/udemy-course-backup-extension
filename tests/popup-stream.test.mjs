import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { supportedPage, summarize, safeReport } from '../extension/core.mjs';

const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '');
const pageUrl = 'https://www.udemy.com/course/example/learn/lecture/11';
const manifest = 'https://www.udemy.com/assets/9000/manifest.m3u8?token=fixture';

function video(overrides = {}) {
  return { id: 'lecture-9000', mediaKeys: null, getClientRects: () => [{}], ...overrides };
}

async function fixture({ videos = [video()], resources = [{ name: manifest, startTime: 10 }] } = {}) {
  const elements = new Map();
  const makeElement = () => ({
    disabled: false, dataset: {}, handlers: {}, children: [], textContent: '',
    addEventListener(type, handler) { this.handlers[type] = handler; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const scan = {
    pageUrl, courseTitle: 'Example', lectureTitle: 'Start', lectureId: '11',
    hasVideo: true, settingsAvailable: true, downloads: [], lectures: [], notes: []
  };
  const page = vm.createContext({
    URL, location: { href: pageUrl },
    document: { querySelectorAll: selector => selector === 'video' ? videos : [] },
    performance: { getEntriesByType: type => type === 'resource' ? resources : [] },
    UdemyDownloadPage: { inspect: () => scan }
  });
  const stored = {};
  const opened = [];
  const captures = [];
  const chrome = {
    scripting: { async executeScript(details) {
      if (details.files) return [];
      page.__args = details.args || [];
      const result = await vm.runInContext(`(${details.func.toString()})(...__args)`, page);
      if (!details.args) captures.push(result);
      return [{ result }];
    } },
    tabs: {
      query: async () => [{ id: 1, url: pageUrl }],
      create: async details => opened.push(details)
    },
    runtime: { getURL: path => `chrome-extension://fixture/${path}` },
    storage: { session: {
      get: async () => ({ ...stored }),
      set: async value => Object.assign(stored, value),
      remove: async keys => keys.forEach(key => delete stored[key])
    } }
  };
  const popup = vm.createContext({
    supportedPage, summarize, safeReport, chrome, URL,
    crypto: { randomUUID: () => 'fixture-job' },
    document: { getElementById: element, querySelectorAll: () => [], createElement: makeElement }
  });
  vm.runInContext(source, popup);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
    if (!element('refresh').disabled) break;
  }
  assert.equal(element('refresh').disabled, false, 'popup initialization completes');
  assert.equal(element('stream').disabled, false, 'stream action is enabled');
  await element('stream').handlers.click();
  return { stored, opened, capture: captures[0], feedback: element('feedback').textContent };
}

test('popup passes matching HLS to the manager even when MediaKeys is connected', async () => {
  const f = await fixture({ videos: [video({ mediaKeys: {} })] });
  assert.equal(f.feedback, '');
  assert.equal(f.capture.assetId, '9000');
  assert.equal(f.capture.candidates[0].url, manifest);
  assert.equal(f.stored['stream-fixture-job'].lectureId, '11');
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].url, 'chrome-extension://fixture/manager.html?job=stream-fixture-job');
});

test('missing HLS with MediaKeys reports uncertainty and creates no job', async () => {
  const f = await fixture({ videos: [video({ mediaKeys: {} })], resources: [] });
  assert.match(f.feedback, /尚未找到.*HLS/);
  assert.match(f.feedback, /播放器已連接媒體保護模組；尚未取得清單，無法確認串流是否加密/);
  assert.equal(f.opened.length, 0);
  assert.deepEqual(f.stored, {});
});

test('missing HLS without MediaKeys reports a missing manifest without implying DRM', async () => {
  const f = await fixture({ resources: [] });
  assert.match(f.feedback, /尚未找到.*HLS/);
  assert.doesNotMatch(f.feedback, /DRM|媒體保護模組/);
  assert.equal(f.opened.length, 0);
});

test('multiple visible videos are still rejected before opening the manager', async () => {
  const f = await fixture({ videos: [video({ mediaKeys: {} }), video({ id: 'lecture-9001' })] });
  assert.match(f.feedback, /保留一個影片播放器/);
  assert.equal(f.opened.length, 0);
  assert.deepEqual(f.stored, {});
});

test('hidden videos do not make the current visible player ambiguous', async () => {
  const f = await fixture({ videos: [video({ mediaKeys: {} }), video({ getClientRects: () => [] })] });
  assert.equal(f.opened.length, 1);
});

test('missing asset identity remains an error despite a matching-looking HLS resource', async () => {
  const f = await fixture({ videos: [video({ id: '', mediaKeys: {} })] });
  assert.match(f.feedback, /無法辨識.*影片 ID/);
  assert.equal(f.opened.length, 0);
});

test('the supported parent container provides the asset identity', async () => {
  const f = await fixture({ videos: [video({ id: '', parentElement: { id: 'shaka-video-container-9000' }, mediaKeys: {} })] });
  assert.equal(f.capture.assetId, '9000');
  assert.equal(f.opened.length, 1);
});

test('foreign assets and origins are ignored while only the current HLS reaches the manager', async () => {
  const foreign = [
    { name: 'https://www.udemy.com/assets/9001/manifest.m3u8', startTime: 999 },
    { name: 'https://www.udemy.com/assets/90000/manifest.m3u8', startTime: 999 },
    { name: 'https://other.udemy.com/assets/9000/manifest.m3u8', startTime: 999 },
    { name: 'https://example.com/assets/9000/manifest.m3u8', startTime: 999 }
  ];
  const f = await fixture({ videos: [video({ mediaKeys: {} })], resources: [...foreign, { name: manifest, startTime: 10 }] });
  assert.deepEqual(Array.from(f.capture.candidates, entry => entry.url), [manifest]);
  const missing = await fixture({ videos: [video({ mediaKeys: {} })], resources: foreign });
  assert.match(missing.feedback, /尚未找到.*HLS/);
  assert.equal(missing.opened.length, 0);
});
