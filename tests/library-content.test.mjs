import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as libraryCore from '../extension/library-core.mjs';

const script = readFileSync(new URL('../extension/library-content.js', import.meta.url), 'utf8');

class ElementFixture {
  constructor(tag, attributes = {}, text = '') {
    this.tagName = tag.toUpperCase(); this.attributes = { ...attributes }; this.content = text;
    this.nodeType = 1; this.children = []; this.parentElement = null; this.listeners = new Map();
  }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return this.content + this.children.map(value => value.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { return Boolean(this.connected || this.parentElement?.isConnected || this.host?.isConnected); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } return this; }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const index = this.children.indexOf(before); if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); }
  after(node) { const parent = this.parentElement; node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  attachShadow() { const root = new ElementFixture('shadow-root'); root.nodeType = 11; root.host = this; this.shadowRoot = root; return root; }
  matches(selector) {
    return selector.split(',').some(piece => {
      piece = piece.trim();
      const tag = /^[a-z][\w-]*/i.exec(piece)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const classes = [...piece.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      if (!classes.every(name => this.className.split(/\s+/).includes(name))) return false;
      const attributes = [...piece.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]*)")?\]/g)];
      return Boolean(tag || classes.length || attributes.length) && attributes.every(([, name, operator, value]) => operator === '=' ? this.getAttribute(name) === value : operator === '*=' ? String(this.getAttribute(name) || '').includes(value) : this.getAttribute(name) !== null);
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const found = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  click() { const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; if (!this.disabled) for (const listener of this.listeners.get('click') || []) listener(event); return event; }
}

const el = (tag, attrs, text) => new ElementFixture(tag, attrs, text);
const prefix = 'libraryCheck:';
const courseKey = slug => `https://www.udemy.com/course/${slug}`;
const storageKey = slug => prefix + courseKey(slug);
const settle = () => new Promise(resolve => setImmediate(resolve));

function makeCard(slug, title = slug, { anchorCard = false } = {}) {
  const link = el('a', { href: `/course/${slug}/learn/lecture/123` });
  link.append(el('h3', { 'data-purpose': 'course-title' }, title));
  const card = anchorCard ? link : el('div', { 'data-purpose': 'course-card' }).append(link);
  if (anchorCard) card.setAttribute('data-purpose', 'course-card');
  return { card, link };
}

function fixture({ saved = {}, get = null, coreOverride = null } = {}) {
  const documentElement = el('html'); documentElement.connected = true;
  const body = el('body'); const main = el('main'); const header = el('header');
  documentElement.append(body); body.append(header, main);
  const document = { documentElement, createElement: tag => el(tag), querySelectorAll: selector => documentElement.querySelectorAll(selector) };
  const window = el('window');
  const location = { href: 'https://www.udemy.com/home/my-courses/learning/?sort=-last_accessed' };
  const sent = []; const removed = []; const listeners = new Set(); const getCalls = [];
  let response = { ok: true };
  const chrome = {
    runtime: { getURL: path => `chrome-extension://test/${path}`, sendMessage: async message => { sent.push(JSON.parse(JSON.stringify(message))); return response; } },
    storage: { local: { get: async keys => { getCalls.push([...keys]); return get ? get(keys) : Object.fromEntries(keys.map(key => [key, saved[key]])); }, remove: async keys => { removed.push([...keys]); for (const key of keys) delete saved[key]; } }, onChanged: { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback) } }
  };
  const timers = new Map(); const intervals = new Map(); let nextTimer = 0; let observer;
  class MutationObserver { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } }
  const core = {
    STORAGE_PREFIX: prefix,
    normalizeCourse(value, base) { try { const url = new URL(value, base); if (url.origin !== 'https://www.udemy.com') return null; if (url.pathname === '/course-dashboard-redirect/' && /^[1-9]\d*$/.test(url.searchParams.get('course_id') || '')) { const key = `${url.origin}${url.pathname}?course_id=${url.searchParams.get('course_id')}`; return { courseKey: key, url: key }; } const match = /^\/course\/([\w-]+)(?:\/|$)/.exec(url.pathname); if (!match) return null; return { courseKey: courseKey(match[1]), url: `${courseKey(match[1])}/learn/` }; } catch { return null; } },
    sanitizeRecord(value) { return value?.label ? { label: String(value.label), detail: String(value.detail || ''), tone: value.tone } : null; },
    summarizeRecord(value) { return value || { label: '尚未檢查', detail: '請先檢查課程。', tone: 'neutral' }; }
  };
  const context = vm.createContext({ module: { exports: {} }, URL });
  vm.runInContext(script, context);
  const ui = context.module.exports.createLibraryUI({ document, location, chrome, MutationObserver, window, core: coreOverride || core, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id), setInterval: callback => { intervals.set(++nextTimer, callback); return nextTimer; }, clearInterval: id => intervals.delete(id) });
  const hosts = kind => document.querySelectorAll(`[data-udemy-backup-library="${kind}"]`);
  return { ui, main, header, body, location, sent, removed, getCalls, timers, intervals, listeners, saved, hosts, add(slug, title, options) { const result = makeCard(slug, title, options); main.append(result.card); return result; }, message(value) { response = value; }, changed(changes, area = 'local') { for (const listener of listeners) listener(changes, area); }, mutate(change) { observer.callback([change]); }, async flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); await Promise.resolve(); await Promise.resolve(); }, interval() { for (const callback of intervals.values()) callback(); }, button(kind, label, index = 0) { return hosts(kind)[index].shadowRoot.querySelectorAll('button').find(button => button.textContent === label); } };
}

test('library UI scopes course cards to the learning main area and leaves links intact', async () => {
  const f = fixture(); const { card, link } = f.add('owned', '<img src=x onerror=alert(1)>');
  f.header.append(makeCard('header-course').card);
  f.main.append(el('section', { 'data-purpose': 'recommendations' }).append(makeCard('recommended').card));
  f.main.append(el('section', { class: 'course-carousel--container' }).append(makeCard('carousel').card));
  f.main.append(el('div', { 'data-purpose': 'course-card' }).append(el('a', { href: 'https://evil.test/course/not-owned' }, 'external')));
  await f.ui.start();
  assert.equal(f.hosts('card').length, 1); assert.equal(f.hosts('toolbar').length, 1);
  assert.equal(f.hosts('card')[0].parentElement, card); assert.equal(link.getAttribute('href'), '/course/owned/learn/lecture/123');
  assert.match(f.hosts('card')[0].shadowRoot.textContent, /尚未檢查/);
  assert.match(f.hosts('toolbar')[0].shadowRoot.textContent, /本頁找到 1 門課/);
  assert.equal(f.hosts('card')[0].shadowRoot.querySelectorAll('img').length, 0);
  await f.ui.refresh(); assert.equal(f.hosts('card').length, 1); assert.equal(f.getCalls.length, 1);
  f.ui.stop();
});

test('card and toolbar actions send explicit modes and deduplicate course keys', async () => {
  const f = fixture(); f.add('one', 'Course one'); f.add('two', 'Course two'); f.add('one', 'Course one again');
  await f.ui.start();
  const event = f.button('card', '抽查').click(); await settle();
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.deepEqual(f.sent[0], { type: 'library-scan', courses: [{ courseKey: courseKey('one'), title: 'Course one' }], mode: 'sample' });
  f.button('toolbar', '逐堂檢查本頁').click(); await settle();
  assert.equal(f.sent[1].mode, 'full'); assert.equal(f.sent[1].courses.length, 2);
  f.button('card', '逐堂檢查', 1).click(); await settle(); assert.equal(f.sent[2].courses[0].courseKey, courseKey('two'));
  f.ui.stop();
});

test('stored summaries and storage changes determine badge text without inventing course claims', async () => {
  const f = fixture({ saved: { [storageKey('one')]: { label: '部分可下載', detail: '1 / 4 堂已檢查', tone: 'warning' } } });
  f.add('one'); await f.ui.start();
  const host = f.hosts('card')[0]; assert.match(host.shadowRoot.textContent, /部分可下載1 \/ 4 堂已檢查/);
  f.changed({ [storageKey('one')]: { newValue: { label: '不可下載', detail: '受保護的影片', tone: 'bad' } } }, 'session');
  assert.match(host.shadowRoot.textContent, /部分可下載/);
  f.changed({ unrelated: { newValue: 'secret' }, [storageKey('one')]: { newValue: { label: '可下載', detail: '4 / 4 堂已檢查', tone: 'good' } } });
  assert.match(host.shadowRoot.textContent, /可下載4 \/ 4 堂已檢查/); assert.equal(host.shadowRoot.querySelector('[data-tone]').getAttribute('data-tone'), 'good');
  f.changed({ [storageKey('one')]: { newValue: null } }); assert.match(host.shadowRoot.textContent, /尚未檢查/);
  f.ui.stop();
});

test('clear removes only visible course record keys', async () => {
  const saved = { [storageKey('one')]: { label: '可下載' }, [storageKey('not-visible')]: { label: '可下載' }, requestedDownloads: ['keep'] };
  const f = fixture({ saved }); f.add('one'); await f.ui.start();
  f.button('toolbar', '清除本頁標示').click(); await settle();
  assert.deepEqual(f.removed, [[storageKey('one')]]); assert(saved[storageKey('not-visible')]); assert.deepEqual(saved.requestedDownloads, ['keep']);
  assert.match(f.hosts('card')[0].shadowRoot.textContent, /尚未檢查/); f.ui.stop();
});

test('lazy loading and reused card links refresh badges without duplicate injection', async () => {
  const f = fixture(); const first = f.add('one'); await f.ui.start();
  const second = f.add('two'); f.mutate({ type: 'childList', target: f.main, addedNodes: [second.card], removedNodes: [] }); await f.flush();
  assert.equal(f.hosts('card').length, 2);
  first.link.setAttribute('href', '/course/replaced/learn/');
  f.mutate({ type: 'attributes', target: first.link }); await f.flush();
  assert.equal(f.hosts('card').length, 2);
  f.button('card', '抽查').click(); await Promise.resolve(); assert.equal(f.sent[0].courses[0].courseKey, courseKey('replaced'));
  second.card.remove(); await f.ui.refresh(); assert.equal(f.hosts('card').length, 1);
  f.ui.stop();
});

test('anchor cards receive sibling controls, and nested card wrappers do not duplicate badges', async () => {
  const f = fixture(); const { card } = f.add('linked', 'Linked', { anchorCard: true });
  card.querySelector('h3').append(el('span', { class: 'course-card--container' }));
  await f.ui.start(); assert.equal(f.hosts('card').length, 1); assert.equal(f.hosts('card')[0].parentElement, f.main); assert.equal(card.querySelectorAll('[data-udemy-backup-library]').length, 0);
  f.ui.stop();
});

test('own DOM changes do not loop and SPA navigation removes then restores UI', async () => {
  const f = fixture(); f.add('one'); await f.ui.start();
  f.mutate({ type: 'childList', target: f.main, addedNodes: [f.hosts('toolbar')[0]], removedNodes: [] }); assert.equal(f.timers.size, 0);
  f.location.href = 'https://www.udemy.com/course/one/learn/'; f.interval(); await f.flush(); assert.equal(f.hosts('card').length, 0); assert.equal(f.hosts('toolbar').length, 0);
  f.location.href = 'https://www.udemy.com/home/my-courses/learning/'; f.interval(); await f.flush(); assert.equal(f.hosts('card').length, 1);
  f.ui.stop(); assert.equal(f.intervals.size, 0); assert.equal(f.listeners.size, 0); assert.equal(f.hosts('toolbar').length, 0);
});

test('new storage events win over a slow initial read', async () => {
  let resolveGet;
  const f = fixture({ get: () => new Promise(resolve => { resolveGet = resolve; }) }); f.add('one');
  const starting = f.ui.start();
  f.changed({ [storageKey('one')]: { newValue: { label: '可下載', detail: '最新紀錄', tone: 'good' } } });
  resolveGet({ [storageKey('one')]: { label: '尚未檢查', detail: '舊紀錄', tone: 'neutral' } }); await starting;
  assert.match(f.hosts('card')[0].shadowRoot.textContent, /最新紀錄/); assert.doesNotMatch(f.hosts('card')[0].shadowRoot.textContent, /舊紀錄/); f.ui.stop();
});

test('permission failures give the extension activation action and restore controls', async () => {
  const f = fixture(); f.add('one'); f.message({ ok: false, error: 'need-permission' }); await f.ui.start();
  const button = f.button('toolbar', '抽查本頁課程'); button.click(); await settle();
  assert.match(f.hosts('toolbar')[0].shadowRoot.textContent, /啟用網站權限後再檢查/); assert.equal(button.disabled, false); f.ui.stop();
});

test('real summary module keeps sampled protected lectures distinct from a whole-course result', async () => {
  const record = { version: 1, courseKey: courseKey('one'), title: 'One', checkedAt: Date.now(), totalVideos: 2, catalogComplete: true, mode: 'sample', finished: true, results: [{ lectureId: '1', title: 'First', status: 'unsupported', reason: 'dash-drm' }] };
  const f = fixture({ saved: { [storageKey('one')]: record }, coreOverride: libraryCore }); f.add('one'); await f.ui.start();
  const text = f.hosts('card')[0].shadowRoot.textContent;
  assert.match(text, /已查部分不可下載/); assert.match(text, /已檢查 1 \/ 2 堂影片/); assert.match(text, /不能據此判定整門課/);
  f.changed({ [storageKey('one')]: { newValue: { ...record, mode: 'full', results: [...record.results, { lectureId: '2', title: 'Second', status: 'unsupported', reason: 'dash-drm' }] } } });
  assert.equal(f.hosts('card')[0].shadowRoot.querySelector('strong').textContent, '不可下載');
  f.ui.stop();
});

test('live Udemy learning grid with numeric redirect links receives badges and an external toolbar', async () => {
  const f = fixture(); f.main.remove();
  const grid = el('div', { class: 'my-courses__course-card-grid' }); f.body.append(grid);
  const card = el('div', { class: 'enrolled-course-card--container--WJYo9' });
  const inner = el('div', { 'data-purpose': 'container', class: 'course-card-module--container--3oS-F course-card-module--medium--T3r3-' });
  const heading = el('h3', { 'data-purpose': 'course-title-url' });
  const link = el('a', { href: '/course-dashboard-redirect/?course_id=7190737&tracking=private' }, 'Live course title');
  heading.append(link); inner.append(heading); card.append(inner); grid.append(card);
  await f.ui.start();
  assert.equal(f.hosts('card').length, 1); assert.equal(f.hosts('card')[0].parentElement, card);
  assert.equal(f.hosts('toolbar')[0].parentElement, f.body);
  assert.equal(f.body.children.indexOf(f.hosts('toolbar')[0]) + 1, f.body.children.indexOf(grid));
  assert.equal(grid.children.length, 1); assert.equal(link.getAttribute('href'), '/course-dashboard-redirect/?course_id=7190737&tracking=private');
  f.button('card', '抽查').click(); await settle();
  assert.deepEqual(f.sent[0].courses, [{ courseKey: 'https://www.udemy.com/course-dashboard-redirect/?course_id=7190737', title: 'Live course title' }]);
  await f.ui.refresh(); assert.equal(f.hosts('toolbar').length, 1); assert.equal(f.hosts('card').length, 1); f.ui.stop();
});
