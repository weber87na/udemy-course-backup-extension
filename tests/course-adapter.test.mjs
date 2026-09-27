import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/course-adapter.js', import.meta.url), 'utf8');
class ElementFixture {
  constructor(tag, attrs = {}, content = '') {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.content = content;
    this.children = []; this.parentElement = null; this.isConnected = true; this.hidden = false;
    this.style = { display: 'block', visibility: 'visible', opacity: '1' };
    this.clicked = 0;
  }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  get disabled() { return this.hasAttribute('disabled'); }
  get textContent() { return [this.content, ...this.children.map(child => child.textContent)].filter(Boolean).join(' '); }
  get innerText() { return this.textContent; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getClientRects() { return [{ width: 100, height: 20, top: 3000 }]; }
  simpleMatches(selector) {
    if (selector === ':disabled') return this.disabled;
    const tag = /^[a-z][a-z0-9-]*/i.exec(selector)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const attrs = [...selector.matchAll(/\[([\w:-]+)(?:(\^=|=)"([^"]*)")?\]/g)];
    return Boolean(tag || attrs.length) && attrs.every(([, name, operator, value]) => operator === '^=' ? String(this.getAttribute(name) || '').startsWith(value) : operator === '=' ? this.getAttribute(name) === value : this.hasAttribute(name));
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const pieces = part.trim().split(/\s+(?![^[]*\])/);
      if (!this.simpleMatches(pieces.pop())) return false;
      let parent = this.parentElement;
      while (pieces.length) {
        const required = pieces.pop();
        while (parent && !parent.simpleMatches(required)) parent = parent.parentElement;
        if (!parent) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { this.clicked += 1; this.onclick?.(); }
}
const element = (...args) => new ElementFixture(...args);

function fixture({ slug = 'example-course', courseName = 'Example course', sections = [{ title: 'First chapter', items: [{ id: '11', title: '1. Start', kind: 'video' }, { id: '12', title: '2. Source code', kind: 'article' }] }, { title: 'Second chapter', items: [{ id: '13', title: '3. API requests', kind: 'video' }] }] } = {}) {
  const clock = { value: 1000 };
  const body = element('body');
  const sidebar = element('div', { id: 'ct-sidebar-scroll-container' });
  body.append(element('h1', { 'data-purpose': 'course-title' }, courseName), sidebar);
  const allRows = []; const panels = []; const headings = []; const observers = [];
  let currentUrl = new URL(`https://www.udemy.com/course/${slug}/learn/lecture/${sections[0].items[0].id}`);
  const location = { get href() { return currentUrl.href; }, set href(value) { currentUrl = new URL(value); }, get origin() { return currentUrl.origin; }, get pathname() { return currentUrl.pathname; } };
  const titleOnly = value => value.replace(/^\d+\s*[.．)、]\s*/, '');
  const region = element('section', { 'aria-label': `Section 1, Lecture: ${titleOnly(sections[0].items[0].title)}` });
  const videoContainer = element('div', { id: 'shaka-video-container-9000' });
  const video = element('video', { id: 'lecture-9000' });
  video.readyState = 4; video.mediaKeys = null; video.pauseCount = 0;
  video.pause = () => { video.pauseCount += 1; };
  videoContainer.append(video); region.append(videoContainer); body.append(region);
  const resources = [{ name: `${location.origin}/assets/9000/manifest.m3u8?initial=private`, startTime: 10 }];
  sections.forEach((section, sectionIndex) => {
    const container = element('div', { 'data-purpose': 'curriculum-section-container' });
    const panel = element('div', { 'data-purpose': `section-panel-${sectionIndex}` });
    const heading = element('button', { 'aria-expanded': 'false' }, section.title);
    const duration = element('span', { 'data-purpose': 'section-duration' });
    duration.append(element('span', { 'aria-hidden': 'true' }, section.countMissing ? '12 minutes' : `0 / ${section.expected ?? section.items.length} | 12 min`));
    heading.append(duration);
    panel.append(element('div', { 'data-purpose': 'section-heading' }).append(heading));
    const group = element('div', { role: 'group', 'aria-hidden': 'true' }); panel.append(group);
    const items = section.items.map((item, itemIndex) => {
      const row = element('li', { 'aria-current': item.id === sections[0].items[0].id ? 'true' : 'false' });
      const inner = element('div', { 'data-purpose': `curriculum-item-${sectionIndex}-${itemIndex}` });
      const state = element('span', { id: `item-completion-state-${item.id}` });
      const checkbox = element('input', { 'data-purpose': 'progress-toggle-button', 'aria-describedby': state.id });
      const title = element('span', { 'data-purpose': 'item-title' }, item.title);
      const play = element('button', { 'aria-label': `Play ${titleOnly(item.title)}` });
      play.append(element('svg').append(element('use', { 'xlink:href': `#icon-${item.kind}` })));
      inner.append(state, checkbox, title, play); row.append(inner);
      const activate = () => {
        location.href = `${location.origin}/course/${slug}/learn/lecture/${item.id}`;
        allRows.forEach(entry => { entry.row.attrs['aria-current'] = entry.id === item.id ? 'true' : 'false'; });
        video.id = `lecture-${9100 + Number(item.id)}`;
        region.attrs['aria-label'] = `Module ${sectionIndex + 1}, Leçon: ${titleOnly(item.title)}`;
        clock.value += 10;
        resources.push({ name: `${location.origin}/assets/${9100 + Number(item.id)}/manifest.m3u8?new=private`, startTime: clock.value });
      };
      play.onclick = activate; title.onclick = activate;
      const result = { ...item, row, state, checkbox, titleNode: title, play, activate };
      allRows.push(result); return row;
    });
    heading.onclick = () => { heading.attrs['aria-expanded'] = 'true'; group.attrs['aria-hidden'] = 'false'; if (!group.children.length) group.append(...items); };
    container.append(panel); sidebar.append(container); panels.push(panel); headings.push(heading);
  });
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.options = options; this.callback({ getEntries: () => resources }); }
  }
  const listeners = new Map();
  const document = {
    title: `${courseName} | Udemy`, querySelectorAll: selector => body.querySelectorAll(selector), getElementById: id => body.querySelectorAll('[id]').find(node => node.id === id) || null,
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  class FixtureDate extends Date { static now() { return clock.value; } }
  let nextTimer = 0;
  const timers = new Set();
  const context = vm.createContext({ Element: ElementFixture, document, location, URL, Date: FixtureDate, getComputedStyle: node => node.style, performance: { now: () => clock.value, getEntriesByType: type => type === 'resource' ? resources.slice() : [] }, PerformanceObserver: Observer, setTimeout: (callback, duration) => { const id = ++nextTimer; timers.add(id); clock.value += duration; queueMicrotask(() => { if (timers.delete(id)) callback(); }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  return { api: context.UdemyCoursePage, context, location, panels, headings, allRows, video, region, resources, observers, clock, emit(entries) { observers.forEach(observer => observer.callback({ getEntries: () => entries })); }, playback(target = video, type = 'play') { for (const listener of Array.from(listeners.get(type) || [])) listener({ target, type }); }, listenerCount(type = 'play') { return listeners.get(type)?.size || 0; } };
}

test('collect expands real headings in order and checks each section count', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href);
  assert.equal(catalog.complete, true); assert.equal(catalog.total, 3); assert.equal(catalog.sections.length, 2);
  assert.deepEqual(Array.from(catalog.sections, section => section.expectedCount), [2, 1]);
  assert.deepEqual(Array.from(catalog.sections.flatMap(section => section.items), item => [item.lectureId, item.title, item.index, item.kind]), [['11', 'Start', 1, 'video'], ['12', 'Source code', 2, 'article'], ['13', 'API requests', 3, 'video']]);
  assert(f.headings.every(button => button.clicked === 1)); assert(f.allRows.every(row => row.checkbox.clicked === 0));
  assert.equal(catalog.sections[0].title, 'First chapter'); assert(!JSON.stringify(catalog).includes('private'));
});

test('another course with French titles and no number prefixes uses DOM order', async () => {
  const f = fixture({ slug: 'cours-francais', courseName: 'Les bases', sections: [{ title: 'Présentation', items: [{ id: '101', title: 'Bienvenue', kind: 'video' }, { id: '102', title: 'Les données', kind: 'video' }] }] });
  const catalog = await f.api.collect(f.location.href);
  assert.equal(catalog.courseKey, 'https://www.udemy.com/course/cours-francais'); assert.equal(catalog.complete, true);
  assert.deepEqual(Array.from(catalog.sections[0].items, item => [item.title, item.index]), [['Bienvenue', 1], ['Les données', 2]]);
  const item = catalog.sections[0].items[1]; await f.api.activate(item); const captured = f.api.capture(item);
  assert.equal(captured.status, 'ready'); assert.equal(captured.lectureTitle, 'Les données');
});

test('missing or mismatched heading counts never claim a complete course', async () => {
  for (const section of [{ countMissing: true }, { expected: 3 }]) {
    const f = fixture({ sections: [{ title: 'Unknown size', ...section, items: [{ id: '11', title: 'Start', kind: 'video' }] }] });
    const catalog = await f.api.collect(f.location.href);
    assert.equal(catalog.complete, false); assert.equal(catalog.total, 1); assert(catalog.notes.length > 1);
  }
});

test('duplicate lecture IDs and unsupported row structures mark collection incomplete', async () => {
  const f = fixture(); f.allRows[2].state.id = 'item-completion-state-11';
  const catalog = await f.api.collect(f.location.href); assert.equal(catalog.complete, false); assert.equal(catalog.total, 2);
  const g = fixture(); g.allRows[2].state.id = 'unsupported-row';
  assert.equal((await g.api.collect(g.location.href)).complete, false);
});

test('cross-course collection or activation is refused and cancellation stops waits', async () => {
  const f = fixture(); await assert.rejects(f.api.collect('https://www.udemy.com/course/another/learn/lecture/11'), /切換/);
  const pending = f.api.collect(f.location.href); f.api.cancel(); await assert.rejects(pending, /取消/);
  const catalog = await f.api.collect(f.location.href); const item = catalog.sections[0].items[0];
  f.location.href = 'https://www.udemy.com/course/another/learn/lecture/11';
  await assert.rejects(f.api.activate(item), /課程已變更/);
});

test('activate checks title and kind and never clicks completion controls', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const item = catalog.sections[1].items[0];
  await assert.rejects(f.api.activate({ ...item, title: 'Wrong title' }), /標題或類型/);
  await assert.rejects(f.api.activate(catalog.sections[0].items[1]), /不是.*影片/);
  const result = await f.api.activate(item);
  assert.equal(result.alreadyCurrent, false); assert.equal(f.allRows[2].play.clicked, 1);
  assert(f.allRows.every(row => row.checkbox.clicked === 0)); assert.equal(f.api.capture(item).status, 'ready');
  assert.equal(f.video.pauseCount, 1);
});

test('capture waits for changed asset and fresh HLS resources after lecture navigation', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const item = catalog.sections[1].items[0];
  f.allRows[2].play.onclick = () => {
    f.location.href = 'https://www.udemy.com/course/example-course/learn/lecture/13';
    f.allRows.forEach(entry => { entry.row.attrs['aria-current'] = entry.id === '13' ? 'true' : 'false'; });
    f.region.attrs['aria-label'] = 'Section two, Lecture: API requests';
  };
  await f.api.activate(item); assert.match(f.api.capture(item).reason, /新講座/); assert.equal(f.video.pauseCount, 0);
  f.video.id = 'lecture-9200';
  f.resources.push({ name: `${f.location.origin}/assets/9200/manifest.m3u8?old=private`, startTime: 1 });
  assert.match(f.api.capture(item).reason, /HLS/);
  f.emit([{ name: `${f.location.origin}/assets/9200/manifest.m3u8?fresh=private`, startTime: f.clock.value + 1 }]);
  const ready = f.api.capture(item); assert.equal(ready.status, 'ready'); assert.equal(ready.candidates.length, 1);
  assert(ready.candidates[0].url.includes('fresh=')); assert.equal(f.video.pauseCount, 1);
});

test('resource observer captures manifests missing from the performance buffer', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const item = catalog.sections[0].items[0];
  await f.api.activate(item); f.resources.length = 0;
  f.emit([{ name: `${f.location.origin}/assets/9000/hls/720.m3u8?observed=private`, startTime: f.clock.value }]);
  const ready = f.api.capture(item); assert.equal(ready.status, 'ready'); assert(ready.candidates.some(entry => entry.url.includes('observed=')));
  assert.equal(f.observers[0].options.buffered, true);
  const api = f.api; vm.runInContext(source, f.context); assert.equal(f.context.UdemyCoursePage, api); assert.equal(f.observers.length, 1);
});

test('observer keeps a bounded cache and ignores foreign resource destinations', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const item = catalog.sections[0].items[0];
  await f.api.activate(item); f.resources.length = 0;
  f.emit(Array.from({ length: 96 }, (_, index) => ({ name: `${f.location.origin}/assets/${20000 + index}/master.m3u8`, startTime: f.clock.value + index })));
  f.emit([{ name: 'https://example.com/assets/9000/manifest.m3u8', startTime: f.clock.value + 500 }]);
  assert.equal(f.api.capture(item).status, 'pending'); assert.equal(f.video.pauseCount, 0);
});

test('capture without activation requires two stable polls and rejects protected playback', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const item = catalog.sections[0].items[0];
  assert.equal(f.api.capture(item).status, 'pending'); f.clock.value += 201;
  assert.equal(f.api.capture(item).status, 'ready');
  f.video.mediaKeys = {}; assert.throws(() => f.api.capture(item), /DRM/);
});

test('metadata loading is not required once matching DOM identity and HLS are available', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const item = catalog.sections[0].items[0];
  f.video.readyState = 0; await f.api.activate(item);
  assert.equal(f.api.capture(item).status, 'ready'); assert.equal(f.video.pauseCount, 1);
});

test('manual navigation stops capture and the next activation without overriding the user', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href);
  const first = catalog.sections[0].items[0]; const next = catalog.sections[1].items[0];
  await f.api.activate(first); assert.equal(f.api.capture(first).status, 'ready');
  f.location.href = 'https://www.udemy.com/course/example-course/learn/lecture/99';
  assert.throws(() => f.api.capture(first), /手動切換/);
  await assert.rejects(f.api.activate(next), /手動切換/); assert.equal(f.allRows[2].play.clicked, 0);
  await f.api.collect(f.location.href); await f.api.activate(next);
  assert.equal(f.api.capture(next).status, 'ready');
});

test('capture tolerates a pending transition only from the recorded previous lecture', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const next = catalog.sections[1].items[0];
  f.allRows[2].play.onclick = () => {};
  await f.api.activate(next); assert.equal(f.api.capture(next).status, 'pending');
  f.location.href = 'https://www.udemy.com/course/example-course/learn/lecture/12';
  assert.throws(() => f.api.capture(next), /手動切換/);
});

test('navigation during chapter expansion stops activation before its play click', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const next = catalog.sections[1].items[0];
  f.headings[1].attrs['aria-expanded'] = 'false';
  const expand = f.headings[1].onclick;
  f.headings[1].onclick = () => { expand(); f.location.href = 'https://www.udemy.com/course/example-course/learn/lecture/99'; };
  await assert.rejects(f.api.activate(next), /手動切換/); assert.equal(f.allRows[2].play.clicked, 0);
});

test('cancel during activation expansion prevents the delayed play click', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const next = catalog.sections[1].items[0];
  f.headings[1].attrs['aria-expanded'] = 'false';
  const pending = f.api.activate(next); f.api.cancel();
  await assert.rejects(pending, /取消/); assert.equal(f.allRows[2].play.clicked, 0);
});

test('cancel pauses only the captured expected lecture and does not arm persistent listeners', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const first = catalog.sections[0].items[0];
  await f.api.activate(first); assert.equal(f.api.capture(first).status, 'ready');
  const paused = f.video.pauseCount; assert.equal(f.api.cancel().ok, true);
  assert.equal(f.video.pauseCount, paused + 1); assert.equal(f.listenerCount(), 0);
  f.location.href = 'https://www.udemy.com/course/example-course/learn/lecture/99';
  f.api.cancel(); assert.equal(f.video.pauseCount, paused + 1);
});

test('cancel catches one late play only when target lecture and changed asset match', async () => {
  const f = fixture(); const catalog = await f.api.collect(f.location.href); const next = catalog.sections[1].items[0];
  f.allRows[2].play.onclick = () => {
    f.location.href = 'https://www.udemy.com/course/example-course/learn/lecture/13';
    f.allRows.forEach(entry => { entry.row.attrs['aria-current'] = entry.id === '13' ? 'true' : 'false'; });
  };
  await f.api.activate(next); f.api.cancel(); assert.equal(f.listenerCount(), 1);
  f.playback(); assert.equal(f.video.pauseCount, 0); // The old asset is not this lecture.
  f.video.id = 'lecture-9313'; f.region.attrs['aria-label'] = 'Leçon: API requests';
  f.playback(element('video')); assert.equal(f.video.pauseCount, 0);
  f.playback(); assert.equal(f.video.pauseCount, 1); assert.equal(f.listenerCount(), 0); assert.equal(f.listenerCount('playing'), 0);
  f.playback(); assert.equal(f.video.pauseCount, 1);
});

test('late-play cancellation expires after five seconds and new collection clears it', async () => {
  for (const startCollection of [false, true]) {
    const f = fixture(); const catalog = await f.api.collect(f.location.href); const next = catalog.sections[1].items[0];
    f.allRows[2].play.onclick = () => {};
    await f.api.activate(next); f.api.cancel(); assert.equal(f.listenerCount(), 1);
    if (startCollection) {
      const pending = f.api.collect(f.location.href); assert.equal(f.listenerCount(), 0); await pending;
    } else {
      await Promise.resolve(); assert.equal(f.listenerCount(), 0);
    }
    f.allRows[2].activate(); f.playback(); assert.equal(f.video.pauseCount, 0);
  }
});
