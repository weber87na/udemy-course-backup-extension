import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../extension/page-adapter.js', import.meta.url), 'utf8');

// A minimal rendered-DOM fixture for the adapter's eligibility checks. This is
// not a browser layout engine or proof that Udemy's live DOM is unchanged.
class FixtureElement {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase(); this.attrs = attrs;
    this.innerText = text; this.textContent = text;
    this.children = []; this.parentElement = null; this.isConnected = true;
    this.hidden = false; this.clicked = 0;
    this.style = { display: 'block', visibility: 'visible', opacity: '1' };
    this.rect = { width: 100, height: 20, top: 5000 };
  }
  append(...nodes) {
    for (const node of nodes) { node.parentElement = this; this.children.push(node); }
    return this;
  }
  get disabled() { return this.hasAttribute('disabled'); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getClientRects() { return [this.rect]; }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value === ':disabled') return this.disabled;
      if (value.startsWith('.')) return (this.attrs.class || '').split(' ').includes(value.slice(1));
      const tag = value.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attrs = [...value.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
      return Boolean(tag || attrs.length) && attrs.every(([, name, content]) =>
        content === undefined ? this.hasAttribute(name) : this.getAttribute(name) === content);
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); }
    };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  click() { this.clicked += 1; this.onclick?.(); }
}

const element = (...args) => new FixtureElement(...args);
function fixture() {
  const body = element('body');
  const main = element('main', { 'aria-label': '第 1 堂講座：课程导学' });
  const player = element('div', { 'data-purpose': 'video-player' });
  const video = element('video');
  const settings = element('button', { 'data-purpose': 'settings-button' });
  const menu = element('div', { role: 'menu' });
  const lecture = element('button', { 'data-purpose': 'download-lecture', disabled: '' }, '下載講座');
  const info = element('button', {}, '獲取資訊');
  menu.style.display = 'none';
  lecture.append(info); menu.append(lecture); player.append(video, settings, menu);
  const resources = element('div', { 'data-purpose': 'lecture-resources' });
  const pdf = element('a', { href: '/assets/guide.pdf' }, 'guide.pdf');
  const foreign = element('a', { href: 'https://example.com/evil.zip', download: '' }, 'evil.zip');
  const generic = element('a', { href: '/courses/' }, 'Go');
  const cdn = element('a', { href: 'https://udemycdn.com/assets/code.zip?token=secret' }, 'code.zip');
  const stream = element('a', { href: '/stream/main.m3u8' }, 'stream');
  const explicit = element('a', { href: '/asset/123?token=secret', download: 'notes.txt' }, 'notes.txt');
  const hidden = element('a', { href: '/asset/hidden.pdf' }, 'hidden.pdf');
  hidden.hidden = true;
  resources.append(pdf, foreign, generic, cdn, stream, explicit, hidden);
  const next = element('a', { href: '/course/aspnet-core-api/learn/lecture/2?token=secret' }, 'Second lecture');
  const outside = element('a', { href: 'https://example.com/course/aspnet-core-api/learn/lecture/3' }, 'Foreign');
  body.append(main);
  main.append(element('h1', { 'data-purpose': 'course-title' }, 'ASP.NET Core API'), player, resources, next, outside);
  const location = {
    href: 'https://www.udemy.com/course/aspnet-core-api/learn/lecture/22112428?token=secret#overview',
    origin: 'https://www.udemy.com', pathname: '/course/aspnet-core-api/learn/lecture/22112428',
  };
  const document = {
    title: 'ASP.NET Core API | Udemy',
    querySelectorAll: selector => body.querySelectorAll(selector),
    getElementById: id => body.querySelectorAll('[id]').find(node => node.getAttribute('id') === id),
  };
  const context = vm.createContext({ Element: FixtureElement, document, location, getComputedStyle: node => node.style, URL, setTimeout, Date });
  vm.runInContext(source, context);
  settings.onclick = () => { menu.style.display = 'block'; settings.attrs['aria-expanded'] = 'true'; };
  return { api: context.UdemyDownloadPage, context, body, main, player, menu, settings, lecture, info, pdf, cdn, explicit, location };
}

test('scan exposes only rendered official downloads and canonical course links', () => {
  const { api } = fixture(); const state = api.inspect();
  assert.deepEqual(Array.from(state.downloads, item => item.label), ['guide.pdf', 'code.zip', 'notes.txt']);
  assert.equal(state.settingsAvailable, true); assert.equal(state.hasVideo, true);
  assert.equal(state.lectureId, '22112428'); assert.equal(state.lectureTitle, '第 1 堂講座：课程导学');
  assert.equal(state.lectures.length, 1);
  assert.equal(state.lectures[0].url, 'https://www.udemy.com/course/aspnet-core-api/learn/lecture/2');
  assert(!JSON.stringify(state).includes('secret')); assert(!JSON.stringify(state).includes('udemycdn.com'));
});

test('settings reveal the disabled official button without activating its information child', async () => {
  const f = fixture(); const state = await f.api.openSettings();
  assert.equal(f.settings.clicked, 1);
  const item = state.downloads.find(candidate => candidate.kind === 'lecture');
  assert(item.disabled); assert.throws(() => f.api.activate(item.id), /停用/);
  assert.equal(f.lecture.clicked, 0); assert.equal(f.info.clicked, 0);
  await f.api.openSettings(); assert.equal(f.settings.clicked, 1);
});

test('enabled controls invoke the official click once and consume their ID', async () => {
  const f = fixture(); await f.api.openSettings(); delete f.lecture.attrs.disabled;
  const item = f.api.inspect().downloads.find(candidate => candidate.kind === 'lecture');
  assert.equal(f.api.activate(item.id).ok, true); assert.equal(f.lecture.clicked, 1);
  assert.throws(() => f.api.activate(item.id), /失效/);
});

test('repeated injection retains the same adapter and every scan expires earlier IDs', () => {
  const f = fixture(); vm.runInContext(source, f.context); assert.equal(f.api, f.context.UdemyDownloadPage);
  const item = f.api.inspect().downloads[0]; f.api.inspect();
  assert.throws(() => f.api.activate(item.id), /失效/);
});

test('Shaka player section supplies the observed lecture title', () => {
  const f = fixture(); f.player.attrs['data-purpose'] = 'shaka-video-player';
  const section = element('section', { 'aria-label': '第 2 章節，第 3 堂講座：API' });
  f.main.children = f.main.children.filter(node => node !== f.player);
  section.append(f.player); f.main.append(section);
  const state = f.api.inspect(); assert.equal(state.lectureTitle, '第 2 章節，第 3 堂講座：API');
  assert.equal(state.settingsAvailable, true);
});

test('activation rejects navigation to a different lecture', () => {
  const f = fixture(); const item = f.api.inspect().downloads[0];
  f.location.href = 'https://www.udemy.com/course/aspnet-core-api/learn/lecture/9';
  assert.throws(() => f.api.activate(item.id), /變更/); assert.equal(f.pdf.clicked, 0);
});

test('activation rechecks visibility, connection, disabled state and href', () => {
  for (const [mutate, expected] of [
    [node => { node.hidden = true; }, /不可見/],
    [node => { node.isConnected = false; }, /不可見/],
    [node => { node.attrs['aria-disabled'] = 'true'; }, /停用/],
    [node => { node.attrs.href = '/assets/other.pdf'; }, /連結已變更/],
  ]) {
    const f = fixture(); const item = f.api.inspect().downloads.find(candidate => candidate.label === 'guide.pdf');
    mutate(f.pdf); assert.throws(() => f.api.activate(item.id), expected); assert.equal(f.pdf.clicked, 0);
  }
});

test('offscreen elements remain eligible while collapsed ancestors exclude children', () => {
  const f = fixture(); assert(f.api.inspect().downloads.some(item => item.label === 'guide.pdf'));
  f.pdf.parentElement.style.display = 'none'; assert.equal(f.api.inspect().downloads.length, 0);
});

test('ambiguous or page-wide settings controls are never clicked', async () => {
  const f = fixture(); f.player.append(element('button', { 'data-purpose': 'settings-button' }));
  assert.equal(f.api.inspect().settingsAvailable, false);
  await assert.rejects(f.api.openSettings(), /多個/); assert.equal(f.settings.clicked, 0);
  const g = fixture(); g.settings.attrs['data-purpose'] = 'unrelated';
  g.main.append(element('button', { 'data-purpose': 'settings-button' }));
  assert.equal(g.api.inspect().settingsAvailable, false); await assert.rejects(g.api.openSettings(), /找不到/);
});

test('login forms disable actions and URL-like labels are redacted', () => {
  const f = fixture(); f.explicit.innerText = f.explicit.textContent = 'https://udemycdn.com/file.pdf?token=secret';
  assert(!JSON.stringify(f.api.inspect()).includes('secret'));
  f.main.append(element('input', { type: 'password' })); const state = f.api.inspect();
  assert.equal(state.loggedOut, true); assert.equal(state.downloads.length, 0); assert.equal(state.settingsAvailable, false);
});
