import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {supportedPage, summarize, safeReport} from '../extension/core.mjs';

const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8').replace(/^import[^\r\n]+;\r?\n/gm, '');
const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const libraryUrl = 'https://www.udemy.com/home/my-courses/learning/';
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}

class Element {
  constructor() {this.children = []; this.listeners = new Map(); this.parentElement = null; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {};}
  append(...children) {for (const child of children) {this.children.push(child); child.parentElement = this;}}
  replaceChildren(...children) {this.children = []; this.append(...children);}
  addEventListener(type, handler) {this.listeners.set(type, handler);}
}
function parseElements() {
  const elements = new Map(), stack = [];
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const [, closing, tag, attributes] = match;
    if (closing) {stack.pop(); continue;}
    const node = new Element();
    node.hidden = /\bhidden(?:\s|=|$)/.test(attributes); node.disabled = /\bdisabled(?:\s|=|$)/.test(attributes);
    stack.at(-1)?.append(node);
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    if (id) elements.set(id, node);
    if (!['meta', 'link', 'br', 'img', 'input', 'hr', 'source'].includes(tag.toLowerCase())) stack.push(node);
  }
  return elements;
}

async function fixture({pageUrl = libraryUrl, permission} = {}) {
  const elements = parseElements(), $ = id => elements.get(id);
  const scripts = [], registrations = [], permissionCalls = [], opened = [], registered = new Map();
  let gesture = false;
  const chrome = {
    permissions: {request(options) {permissionCalls.push({gesture, options: structuredClone(options)}); return permission ?? Promise.resolve(true);}},
    tabs: {query: async () => [{id: 7, url: pageUrl}], create: async options => {opened.push(structuredClone(options)); return {id: 8};}},
    scripting: {
      getRegisteredContentScripts: async ({ids}) => ids.flatMap(id => registered.has(id) ? [registered.get(id)] : []),
      registerContentScripts: async values => {for (const value of values) {const copy = structuredClone(value); registrations.push(copy); registered.set(copy.id, copy);}},
      executeScript: async options => {scripts.push(structuredClone(options)); return [];}
    }
  };
  const context = vm.createContext({chrome, URL, supportedPage, summarize, safeReport,
    document: {getElementById: $, querySelectorAll: () => [], createElement: () => new Element()}});
  vm.runInContext(source, context, {filename: 'popup.js'});
  async function settle() {
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(setImmediate);
      if (!vm.runInContext('busy', context)) return;
    }
    throw new Error('Popup did not settle');
  }
  function click() {
    if ($('library-enable').disabled) return;
    gesture = true;
    try {return $('library-enable').listeners.get('click')();} finally {gesture = false;}
  }
  function isVisible(id) {
    for (let node = $(id); node; node = node.parentElement) if (node.hidden) return false;
    return true;
  }
  await settle();
  return {$, scripts, registrations, permissionCalls, opened, click, settle, isVisible};
}

test('library popup skips lecture injection, requests permission in the gesture, and registers cards only once', async () => {
  const permission = deferred(), f = await fixture({permission: permission.promise});
  assert.equal(f.$('lecture-tools').hidden, true); assert.equal(f.scripts.length, 0);
  assert.equal(f.isVisible('library-enable'), true); assert.equal(f.isVisible('library-feedback'), true);
  f.click();
  assert.deepEqual(f.permissionCalls, [{gesture: true, options: {origins: ['https://*.udemy.com/*', 'https://*.udemycdn.com/*']}}]);
  assert.equal(f.$('library-enable').disabled, true);
  f.click(); assert.equal(f.permissionCalls.length, 1);
  await new Promise(setImmediate); assert.equal(f.registrations.length, 0); assert.equal(f.scripts.length, 0);
  permission.resolve(true); await f.settle();
  assert.equal(f.registrations.length, 1);
  assert.deepEqual(f.registrations[0], {id: 'udemy-library-labels', matches: ['https://*.udemy.com/home/*'], js: ['library-content.js'], runAt: 'document_idle', persistAcrossSessions: true});
  assert.deepEqual(f.scripts, [{target: {tabId: 7}, files: ['library-content.js']}]);
  assert.equal(f.opened.length, 0); assert.match(f.$('library-feedback').textContent, /已啟用/);
  f.click(); await f.settle();
  assert.equal(f.registrations.length, 1); assert.equal(f.scripts.length, 2);
  assert.ok(f.permissionCalls.every(call => call.gesture));
});

test('enabling from another website opens the Udemy library instead of injecting into that tab', async () => {
  const f = await fixture({pageUrl: 'https://example.invalid/other-page'});
  f.click(); await f.settle();
  assert.deepEqual(f.opened, [{url: libraryUrl}]);
  assert.equal(f.scripts.length, 0); assert.equal(f.registrations.length, 1);
  assert.equal(f.permissionCalls[0].gesture, true); assert.match(f.$('library-feedback').textContent, /已啟用/);
});

test('denied card permissions stay visible outside hidden lecture tools and perform no registration or injection', async () => {
  const f = await fixture({permission: Promise.resolve(false)});
  f.click(); await f.settle();
  assert.equal(f.isVisible('feedback'), false);
  assert.equal(f.isVisible('library-feedback'), true); assert.match(f.$('library-feedback').textContent, /需要網站權限/);
  assert.equal(f.registrations.length, 0); assert.equal(f.scripts.length, 0); assert.equal(f.opened.length, 0);
  assert.equal(f.$('library-enable').disabled, false);
});
