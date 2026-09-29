(() => {
  'use strict';

  function createLibraryUI({ document, location, chrome, MutationObserver, window, core, setTimeout, clearTimeout, setInterval, clearInterval }) {
    const ownAttribute = 'data-udemy-backup-library';
    const cardSelector = '[data-purpose="course-card"], [data-purpose="enrolled-course-card"], [class*="course-card--container"]';
    const rootSelector = '.my-courses__course-card-grid, [data-purpose="my-courses"], [data-purpose="learning-courses"], [class*="my-courses--main"], [class*="my-courses-v3--main"], main, [role="main"]';
    const excludedSelector = 'header, footer, nav, aside, [data-purpose*="recommend"], [class*="recommend"], [data-purpose*="carousel"], [class*="carousel"]';
    const entries = new Map();
    const records = new Map();
    const loaded = new Set();
    const versions = new Map();
    let toolbar = null;
    let observer = null;
    let debounce = null;
    let routeTimer = null;
    let lastUrl = location.href;
    let active = false;
    let sending = false;
    let lastRenderMinute = -1;

    function isLearningPage() {
      try {
        const url = new URL(location.href);
        return url.protocol === 'https:' && (url.hostname === 'udemy.com' || url.hostname.endsWith('.udemy.com')) && /^\/home\/my-courses\/learning\/?$/.test(url.pathname);
      } catch { return false; }
    }

    function node(tag, text, className) {
      const result = document.createElement(tag);
      if (text !== undefined) result.textContent = text;
      if (className) result.className = className;
      return result;
    }

    function shadow(kind) {
      const host = node('div');
      host.setAttribute(ownAttribute, kind);
      const root = host.attachShadow({ mode: 'open' });
      const style = node('link');
      style.setAttribute('rel', 'stylesheet');
      style.setAttribute('href', chrome.runtime.getURL('library-content.css'));
      root.append(style);
      return { host, root };
    }

    function button(text, action) {
      const result = node('button', text);
      result.type = 'button';
      result.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        Promise.resolve(action()).catch(() => feedback('操作失敗，請重新整理頁面後再試。'));
      });
      return result;
    }

    function feedback(value) { if (toolbar) toolbar.feedback.textContent = value; }

    function visibleCourses() {
      const unique = new Map();
      for (const entry of entries.values()) unique.set(entry.course.courseKey, { courseKey: entry.course.courseKey, title: entry.title });
      return [...unique.values()];
    }

    function updateControls() {
      const empty = entries.size === 0;
      if (toolbar) for (const control of toolbar.buttons) control.disabled = sending || empty;
      for (const entry of entries.values()) for (const control of entry.buttons) control.disabled = sending;
    }

    async function scan(courses, mode) {
      if (sending || !courses.length) return;
      sending = true;
      updateControls();
      feedback('正在開啟檢查分頁…');
      try {
        const response = await chrome.runtime.sendMessage({ type: 'library-scan', courses, mode });
        if (response?.ok) feedback('已開啟檢查分頁；完成後會自動更新這裡的課程標示。');
        else if (response?.error === 'need-permission' || response?.code === 'need-permission') feedback('請點 Chrome 的「Udemy 課程下載助手」擴充功能，啟用網站權限後再檢查。');
        else feedback(typeof response?.error === 'string' ? response.error.slice(0, 300) : '無法開啟檢查，請重新整理頁面後再試。');
      } catch { feedback('擴充功能連線已中斷，請重新整理頁面後再試。'); }
      finally { sending = false; updateControls(); }
    }

    async function clearPage() {
      if (sending) return;
      const keys = visibleCourses().map(course => `${core.STORAGE_PREFIX}${course.courseKey}`);
      if (!keys.length) return;
      await chrome.storage.local.remove(keys);
      for (const key of keys) {
        versions.set(key, (versions.get(key) || 0) + 1);
        records.delete(key);
        loaded.add(key);
      }
      renderAll();
      feedback('已清除本頁課程的本機標示。');
    }

    function ensureToolbar(root) {
      if (toolbar?.host.isConnected) return;
      const container = shadow('toolbar');
      const panel = node('section', undefined, 'udemy-backup-library-panel');
      panel.setAttribute('aria-label', '下載能力檢查');
      panel.append(node('h2', '下載能力檢查'));
      const description = node('p', '以本工具支援的影片格式判定。抽查只代表已檢查講座；逐堂檢查完成後才能判定整門課。');
      const actions = node('div', undefined, 'udemy-backup-library-actions');
      const sample = button('抽查本頁課程', () => scan(visibleCourses(), 'sample'));
      const full = button('逐堂檢查本頁', () => scan(visibleCourses(), 'full'));
      const clear = button('清除本頁標示', clearPage);
      actions.append(sample, full, clear);
      const count = node('p', '', 'udemy-backup-library-count');
      const message = node('p', '', 'udemy-backup-library-feedback');
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      panel.append(description, actions, count, message);
      container.root.append(panel);
      // The live library grid has no <main>; its children each occupy a card cell.
      // Place the toolbar before that grid so it never consumes a course column.
      if (root.matches('.my-courses__course-card-grid')) root.parentElement.insertBefore(container.host, root);
      else root.insertBefore(container.host, root.firstChild);
      toolbar = { ...container, count, feedback: message, buttons: [sample, full, clear] };
    }

    function createEntry(card, course, title) {
      const container = shadow('card');
      const panel = node('div', undefined, 'udemy-backup-library-card');
      const status = node('strong', '尚未檢查', 'udemy-backup-library-badge');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const detail = node('p', '', 'udemy-backup-library-detail');
      const actions = node('div', undefined, 'udemy-backup-library-actions');
      const sample = button('抽查', () => scan([{ courseKey: course.courseKey, title }], 'sample'));
      const full = button('逐堂檢查', () => scan([{ courseKey: course.courseKey, title }], 'full'));
      sample.setAttribute('aria-label', `抽查：${title}`);
      full.setAttribute('aria-label', `逐堂檢查：${title}`);
      actions.append(sample, full);
      panel.append(status, detail, actions);
      container.root.append(panel);
      // Course links remain intact, and controls never become nested inside a link.
      const enclosingLink = card.closest('a');
      if (enclosingLink) enclosingLink.after(container.host);
      else card.append(container.host);
      const entry = { ...container, card, course, title, status, detail, panel, buttons: [sample, full] };
      entries.set(card, entry);
      renderEntry(entry);
      return entry;
    }

    function renderEntry(entry) {
      const key = `${core.STORAGE_PREFIX}${entry.course.courseKey}`;
      const summary = core.summarizeRecord(records.get(key) || null);
      entry.status.textContent = summary.label;
      entry.detail.textContent = summary.detail;
      entry.panel.setAttribute('data-tone', ['good', 'bad', 'warning', 'neutral'].includes(summary.tone) ? summary.tone : 'neutral');
    }

    function renderAll() { for (const entry of entries.values()) renderEntry(entry); }

    async function loadRecords(keys) {
      const pending = [...new Set(keys)].filter(key => !loaded.has(key));
      if (!pending.length) return;
      const before = new Map(pending.map(key => [key, versions.get(key) || 0]));
      for (const key of pending) loaded.add(key);
      try {
        const saved = await chrome.storage.local.get(pending);
        for (const key of pending) {
          if ((versions.get(key) || 0) !== before.get(key)) continue;
          records.set(key, core.sanitizeRecord(saved[key]));
        }
        if (active && isLearningPage()) renderAll();
      } catch {
        for (const key of pending) loaded.delete(key);
        feedback('無法讀取本機檢查紀錄，請重新整理頁面後再試。');
      }
    }

    function cleanup() {
      for (const entry of entries.values()) entry.host.remove();
      entries.clear();
      toolbar?.host.remove();
      toolbar = null;
    }

    async function refresh() {
      if (!active) return;
      lastUrl = location.href;
      if (!isLearningPage()) { cleanup(); return; }
      const roots = [...document.querySelectorAll(rootSelector)].filter(root => !root.closest(excludedSelector));
      const found = new Map();
      for (const root of roots) {
        for (const card of root.querySelectorAll(cardSelector)) {
          if (found.has(card) || card.closest(excludedSelector) || card.parentElement?.closest(cardSelector)) continue;
          const anchors = card.matches('a[href]') ? [card, ...card.querySelectorAll('a[href]')] : [...card.querySelectorAll('a[href]')];
          const courses = new Map();
          for (const anchor of anchors) {
            const course = core.normalizeCourse(anchor.getAttribute('href'), location.href);
            if (course) courses.set(course.courseKey, { course, anchor });
          }
          // A list container or recommendation block is not a single course card.
          if (courses.size !== 1) continue;
          const { course, anchor } = courses.values().next().value;
          const heading = card.querySelector('[data-purpose="course-title"], [data-purpose="course-title-url"], [data-purpose="course-card-title"], h2, h3, h4');
          const title = String(heading?.textContent || anchor.getAttribute('title') || anchor.textContent || 'Udemy 課程').replace(/\s+/g, ' ').trim().slice(0, 200);
          found.set(card, { course, title });
        }
      }
      for (const [card, entry] of entries) {
        const next = found.get(card);
        if (!next || next.course.courseKey !== entry.course.courseKey || next.title !== entry.title || !entry.host.isConnected) {
          entry.host.remove(); entries.delete(card);
        }
      }
      const root = roots[0];
      if (!root) { cleanup(); return; }
      ensureToolbar(root);
      for (const [card, value] of found) if (!entries.has(card)) createEntry(card, value.course, value.title);
      toolbar.count.textContent = `本頁找到 ${visibleCourses().length} 門課。檢查清單與首個片段，不儲存影片檔。`;
      updateControls();
      await loadRecords([...entries.values()].map(entry => `${core.STORAGE_PREFIX}${entry.course.courseKey}`));
    }

    function schedule() {
      if (!active) return;
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void refresh(); }, 150);
    }

    function isOwnNode(value) {
      const element = value?.nodeType === 1 ? value : value?.parentElement;
      return Boolean(element?.closest(`[${ownAttribute}]`));
    }

    function storageChanged(changes, area) {
      if (area !== 'local') return;
      let touched = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith(core.STORAGE_PREFIX)) continue;
        versions.set(key, (versions.get(key) || 0) + 1);
        records.set(key, core.sanitizeRecord(change.newValue));
        loaded.add(key);
        touched = true;
      }
      if (touched && active && isLearningPage()) renderAll();
    }

    async function start() {
      if (active) return;
      active = true;
      observer = new MutationObserver(changes => {
        if (changes.some(change => !isOwnNode(change.target) && (change.type !== 'childList' || [...change.addedNodes, ...change.removedNodes].some(value => !isOwnNode(value))))) schedule();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
      chrome.storage.onChanged.addListener(storageChanged);
      window.addEventListener('popstate', schedule);
      window.addEventListener('hashchange', schedule);
      routeTimer = setInterval(() => {
        if (location.href !== lastUrl) schedule();
        const minute = Math.floor(Date.now() / 60000);
        if (minute !== lastRenderMinute) { lastRenderMinute = minute; if (isLearningPage()) renderAll(); }
      }, 1000);
      await refresh();
    }

    function stop() {
      active = false;
      observer?.disconnect();
      if (debounce !== null) clearTimeout(debounce);
      if (routeTimer !== null) clearInterval(routeTimer);
      chrome.storage.onChanged.removeListener(storageChanged);
      window.removeEventListener('popstate', schedule);
      window.removeEventListener('hashchange', schedule);
      cleanup();
    }

    return { start, stop, refresh };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createLibraryUI };
  else if (!globalThis.__udemyBackupLibraryUI) {
    globalThis.__udemyBackupLibraryUI = true;
    import(chrome.runtime.getURL('library-core.mjs')).then(core => createLibraryUI({ document, location, chrome, MutationObserver, window, core, setTimeout, clearTimeout, setInterval, clearInterval }).start()).catch(() => { delete globalThis.__udemyBackupLibraryUI; });
  }
})();
