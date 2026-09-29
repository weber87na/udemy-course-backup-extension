import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/library-player.js', import.meta.url), 'utf8');
class ElementFixture {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.children = [];
    this.parentElement = null; this.isConnected = true; this.hidden = false;
    this.style = { display: 'block', visibility: 'visible', opacity: '1' };
  }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getClientRects() { return [{ width: 100, height: 20 }]; }
  matches(selector) {
    return selector.split(',').some(part => {
      const tag = /^[a-z][a-z0-9-]*/i.exec(part.trim())?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attrs = [...part.matchAll(/\[([\w:-]+)(?:(\^=|=)"([^"]*)")?\]/g)];
      return Boolean(tag || attrs.length) && attrs.every(([, name, operator, value]) => operator === '^=' ? String(this.getAttribute(name) || '').startsWith(value) : operator === '=' ? this.getAttribute(name) === value : this.hasAttribute(name));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
}
const element = (...args) => new ElementFixture(...args);
const pageUrl = 'https://www.udemy.com/course/example/learn/lecture/11';
const item = { courseKey: 'https://www.udemy.com/course/example', lectureId: '11', title: 'Introduction' };
const hls = (asset = '9000', suffix = '') => ({ name: `https://www.udemy.com/assets/${asset}/manifest${suffix}.m3u8?private=token`, startTime: 10 });
const dash = (name = 'video') => ({ name: `https://dash-enc-c.udemycdn.com/${name}.mpd?private=token`, startTime: 20 });

function fixture({ entries = [hls()], navigationUrl = pageUrl, initialUrl = pageUrl, mediaKeys = null, rejectPlay = false } = {}) {
  const clock = { value: 1000 };
  const body = element('body');
  const sidebar = element('div', { id: 'ct-sidebar-scroll-container' });
  const row = element('li', { 'aria-current': 'true' });
  const marker = element('span', { id: 'item-completion-state-11' });
  row.append(marker); sidebar.append(row); body.append(sidebar);
  const region = element('section', { 'aria-label': 'Lecture 1: Introduction' });
  const container = element('div', { id: 'shaka-video-container-9000' });
  const video = element('video', { id: 'lecture-9000' });
  Object.assign(video, { readyState: 4, mediaKeys, paused: true, playCount: 0, pauseCount: 0, muted: false });
  video.play = () => { video.playCount += 1; return rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(); };
  video.pause = () => { video.pauseCount += 1; };
  container.append(video); region.append(container); body.append(region);
  const location = { href: initialUrl };
  const observers = [];
  const context = vm.createContext({
    URL, Element: ElementFixture, location, getComputedStyle: node => node.style,
    document: { getElementById: id => body.querySelectorAll(`[id="${id}"]`)[0] || null, querySelectorAll: selector => body.querySelectorAll(selector) },
    performance: { now: () => clock.value, getEntriesByType: type => type === 'navigation' ? (navigationUrl === null ? [] : [{ name: navigationUrl }]) : entries },
    PerformanceObserver: class { constructor(callback) { observers.push(callback); } observe() {} }
  });
  vm.runInContext(source, context);
  const api = context.UdemyLibraryPlayer;
  const inspect = (value = item, options) => JSON.parse(JSON.stringify(api.inspect(value, options)));
  const ready = (value = item, options) => { inspect(value, options); clock.value += 200; return inspect(value, options); };
  const observe = entry => observers.forEach(callback => callback({ getEntries: () => [entry] }));
  return { api, context, inspect, ready, observe, clock, entries, location, body, sidebar, row, marker, region, container, video };
}

test('requires stable binding twice and returns only matching HLS, never inferring encryption from MediaKeys', () => {
  const f = fixture({ entries: [hls('8000'), hls()], mediaKeys: {} });
  assert.equal(f.inspect().status, 'pending');
  f.clock.value += 199;
  assert.equal(f.inspect().status, 'pending');
  assert.equal(f.video.pauseCount, 0);
  f.clock.value += 1;
  const result = f.inspect();
  assert.equal(result.status, 'ready'); assert.equal(result.kind, 'hls');
  assert.equal(result.lectureId, '11'); assert.equal(result.assetId, '9000');
  assert.deepEqual(result.candidates, [{ url: hls().name, at: 10, isMaster: true }]);
  assert.equal(f.video.pauseCount, 1);
  assert.equal('encrypted' in result, false); assert.equal('mediaKeysAttached' in result, false);
});

test('accepts a unique CDN DASH manifest only with stable matching player and loaded media', () => {
  const f = fixture({ entries: [dash()], mediaKeys: {} });
  f.video.readyState = 1;
  assert.equal(f.ready().status, 'pending');
  f.video.readyState = 2;
  const result = f.inspect();
  assert.equal(result.kind, 'dash'); assert.equal(result.candidates[0].url, dash().name);
  assert.equal(result.candidates.length, 1);
});

test('HLS always takes priority over DASH and returns at most twelve matching sources', () => {
  const f = fixture({ entries: [dash(), ...Array.from({ length: 15 }, (_, index) => hls('9000', `-${index}`))] });
  const result = f.ready();
  assert.equal(result.kind, 'hls'); assert.equal(result.candidates.length, 12);
  assert.ok(result.candidates.every(candidate => candidate.url.includes('/assets/9000/')));
});

test('a foreign asset HLS or a foreign-domain HLS prevents unbound DASH attribution', () => {
  for (const entry of [hls('8000'), { name: 'https://elsewhere.example/video.m3u8', startTime: 1 }]) {
    const f = fixture({ entries: [dash(), entry] });
    const result = f.ready();
    assert.equal(result.status, 'pending'); assert.match(result.reason, /HLS/);
    assert.equal(f.video.pauseCount, 0);
  }
});

test('multiple DASH manifests, including foreign domains, remain ambiguous', () => {
  for (const extra of [dash('other'), { name: 'https://elsewhere.example/other.mpd', startTime: 30 }]) {
    const f = fixture({ entries: [dash(), extra] });
    assert.match(f.ready().reason, /多個 DASH/);
  }
});

test('rejects invalid source domains, credentials, ports, protocols, and non-asset HLS paths', () => {
  for (const name of [
    'https://udemycdn.com.attacker.test/video.mpd', 'https://eviludemycdn.com/video.mpd',
    'http://dash.udemycdn.com/video.mpd', 'https://u:p@dash.udemycdn.com/video.mpd',
    'https://dash.udemycdn.com:8443/video.mpd', 'https://www.udemy.com/video.mpd',
    'https://cdn.udemycdn.com/assets/9000/video.m3u8', 'https://www.udemy.com/other/9000/video.m3u8',
    'https://user:pass@www.udemy.com/assets/9000/video.m3u8'
  ]) {
    const f = fixture({ entries: [{ name, startTime: 1 }] });
    const result = f.ready();
    assert.equal(result.status, 'pending', name); assert.equal('candidates' in result, false);
  }
});

test('refuses mismatched course, lecture, title, navigation history, and SPA changes', () => {
  for (const bad of [{ ...item, courseKey: 'https://www.udemy.com/course/other' }, { ...item, lectureId: '12' }, { ...item, lectureId: 11 }]) {
    assert.throws(() => fixture().inspect(bad), /不一致/);
  }
  for (const navigationUrl of [pageUrl.replace('/11', '/12'), 'https://www.udemy.com/course/example/learn/']) {
    assert.throws(() => fixture({ navigationUrl }).inspect(), /完整重新載入/);
  }
  const f = fixture(); f.ready();
  assert.throws(() => f.inspect({ ...item, title: 'Other title' }), /綁定/);
  f.location.href = pageUrl.replace('/11', '/12');
  assert.throws(() => f.inspect(), /完整重新載入/);
  f.location.href = pageUrl;
  assert.throws(() => f.inspect(), /完整重新載入/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.api.pause())), { ok: false });
});

test('requires a visible unique current row, correct lecture marker, and matching player title', () => {
  const changes = [
    f => { f.sidebar.hidden = true; },
    f => { f.row.attrs['aria-current'] = 'false'; },
    f => { f.marker.id = 'item-completion-state-12'; },
    f => { f.sidebar.append(element('li', { 'aria-current': 'true' })); },
    f => { f.region.attrs['aria-label'] = 'Lecture: Different'; },
    f => { f.video.hidden = true; },
    f => { f.region.append(element('video', { id: 'lecture-9001' })); },
    f => { f.container.id = 'shaka-video-container-9001'; }
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal(f.ready(item, { play: true }).status, 'pending');
    assert.equal(f.video.playCount, 0); assert.equal(f.video.pauseCount, 0);
  }
});

test('normalizes region title and can use only the parent asset ID', () => {
  const f = fixture(); f.video.id = ''; f.region.attrs['aria-label'] = 'Lecture:  Intro\u200bduction ';
  assert.equal(f.ready().status, 'pending');
  f.region.attrs['aria-label'] = 'Lecture:  Introduction  ';
  assert.equal(f.ready().assetId, '9000');
});

test('restarts stabilization when the player or row changes', () => {
  const f = fixture(); f.inspect(); f.clock.value += 200;
  f.region.attrs['aria-label'] = 'New region: Introduction';
  assert.equal(f.inspect().status, 'pending');
  f.clock.value += 200;
  assert.equal(f.inspect().status, 'ready');
  f.row.hidden = true;
  assert.equal(f.inspect().status, 'pending');
  f.row.hidden = false;
  assert.equal(f.inspect().status, 'pending');
});

test('attempts muted autoplay once only after binding, and catches rejection without classifying DRM', async () => {
  const f = fixture({ entries: [], rejectPlay: true, mediaKeys: {} });
  f.inspect(item, { play: true }); assert.equal(f.video.playCount, 0);
  f.clock.value += 200;
  const result = f.inspect(item, { play: true });
  await Promise.resolve();
  assert.equal(result.status, 'pending'); assert.doesNotMatch(result.reason, /DRM|加密/);
  assert.equal(f.video.playCount, 1); assert.equal(f.video.muted, true);
  f.inspect(item, { play: true }); assert.equal(f.video.playCount, 1);
});

test('does not play by default, and catches a synchronous play exception', () => {
  const f = fixture({ entries: [] });
  f.ready(); assert.equal(f.video.playCount, 0);
  f.video.play = () => { throw new Error('NotAllowedError'); };
  assert.equal(f.inspect(item, { play: true }).status, 'pending');
});

test('observer retains sources after resource timing entries are cleared and reinjection preserves state', () => {
  const f = fixture({ entries: [] });
  f.observe(dash());
  vm.runInContext(source, f.context);
  assert.equal(f.ready().kind, 'dash');
});

test('bounded observed manifests cannot evict ambiguity, and earlier HLS observation remains sticky', () => {
  const f = fixture({ entries: [] });
  for (let index = 0; index < 120; index += 1) f.observe(dash(`video-${index}`));
  assert.match(f.ready().reason, /多個 DASH/);
  const g = fixture({ entries: [hls('8000')] });
  g.entries.length = 0;
  g.observe(dash());
  assert.match(g.ready().reason, /HLS/);
});

test('pause only touches the validated player while the lecture and row still match', () => {
  const f = fixture();
  assert.equal(f.api.pause().ok, false);
  f.ready(); const before = f.video.pauseCount;
  assert.equal(f.api.pause().ok, true); assert.equal(f.video.pauseCount, before + 1);
  f.marker.id = 'item-completion-state-12';
  assert.equal(f.api.pause().ok, false); assert.equal(f.video.pauseCount, before + 1);
  f.marker.id = 'item-completion-state-11';
  f.video.id = 'lecture-9001'; f.container.id = 'shaka-video-container-9001';
  assert.equal(f.api.pause().ok, false); assert.equal(f.video.pauseCount, before + 1);
});
