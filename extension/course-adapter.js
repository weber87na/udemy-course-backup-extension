(() => {
  'use strict';
  const version = 'course-dom-v1';
  if (globalThis.UdemyCoursePage?.version === version) return;
  const MAX_OBSERVED = 96;
  const observed = new Map();
  let operation = 0;
  let catalogCourse = null;
  let activation = null;
  let fallback = null;
  let pendingPauseCleanup = null;

  function clearPendingPause() {
    if (pendingPauseCleanup) pendingPauseCleanup();
  }

  function text(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  function visible(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    for (let current = node; current instanceof Element; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  }
  function disabled(node) { return Boolean(node.disabled || node.matches(':disabled') || node.closest('[disabled], [aria-disabled="true"], [inert]')); }
  function courseAt(value = location.href) {
    let url;
    try { url = new URL(value); } catch { throw new Error('課程網址無效，請重新開啟 Udemy 課程。'); }
    const match = url.pathname.match(/^\/course\/([^/]+)\/learn(?:\/|$)/);
    if (url.protocol !== 'https:' || !/(^|\.)udemy\.com$/i.test(url.hostname) || url.username || url.password || !match) throw new Error('請在 HTTPS Udemy 課程播放頁使用課程目錄工具。');
    return { courseKey: `${url.origin}/course/${match[1]}`, pageUrl: `${url.origin}${url.pathname}`, origin: url.origin, lectureId: /\/lecture\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] || '' };
  }
  function requireCourse(key) {
    const current = courseAt();
    if (!key || current.courseKey !== key) throw new Error('目前課程已變更，請重新建立這門課的目錄。');
    return current;
  }
  function sidebar() {
    const node = document.getElementById('ct-sidebar-scroll-container');
    if (!node || !visible(node)) throw new Error('找不到可見的課程目錄，請先開啟 Udemy 的課程內容側欄。');
    return node;
  }
  function panels() {
    return Array.from(sidebar().querySelectorAll('[data-purpose^="section-panel-"]')).filter(node => /^section-panel-\d+$/.test(node.getAttribute('data-purpose')) && visible(node));
  }
  function panelNumber(node) { return Number(node.getAttribute('data-purpose').slice('section-panel-'.length)); }
  function findPanel(index) {
    const matches = panels().filter(node => panelNumber(node) === index);
    if (matches.length !== 1) throw new Error(`第 ${index + 1} 章的目錄結構已變更，請重新掃描課程。`);
    return matches[0];
  }
  function heading(panel) {
    const matches = Array.from(panel.querySelectorAll('[data-purpose="section-heading"] button[aria-expanded]')).filter(visible);
    if (matches.length !== 1) throw new Error(`無法確認第 ${panelNumber(panel) + 1} 章的展開按鈕。`);
    return matches[0];
  }
  function sectionInfo(panel) {
    const button = heading(panel);
    const duration = panel.querySelector('[data-purpose="section-duration"]');
    const countText = text(duration?.innerText || duration?.textContent);
    const count = /\d+\s*\/\s*(\d+)/.exec(countText);
    let title = text(button.innerText || button.textContent || button.getAttribute('aria-label'));
    if (duration) {
      const parts = [duration.innerText, duration.textContent, ...Array.from(duration.querySelectorAll('span')).map(node => node.textContent)].map(text).filter(Boolean).sort((a, b) => b.length - a.length);
      for (const part of parts) title = text(title.replace(part, ''));
    }
    const expectedCount = count && Number.isSafeInteger(Number(count[1])) ? Number(count[1]) : null;
    return { sectionIndex: panelNumber(panel) + 1, title: title || `章節 ${panelNumber(panel) + 1}`, expectedCount };
  }
  function rows(panel) { return Array.from(panel.querySelectorAll('li[aria-current]')).filter(visible); }
  function iconKind(row) {
    const icons = Array.from(row.querySelectorAll('svg use')).map(node => node.getAttribute('href') || node.getAttribute('xlink:href') || '');
    if (icons.some(value => /#icon-video$/.test(value))) return 'video';
    if (icons.some(value => /#icon-article$/.test(value))) return 'article';
    return 'unknown';
  }
  function rowInfo(row, sectionIndex, position) {
    const marker = row.querySelector('[data-purpose^="curriculum-item-"]');
    const markerMatch = /^curriculum-item-(\d+)-(\d+)$/.exec(marker?.getAttribute('data-purpose') || '');
    if (!markerMatch || Number(markerMatch[1]) !== sectionIndex - 1) return null;
    const state = row.querySelector('span[id^="item-completion-state-"]');
    const lectureId = /^item-completion-state-(\d+)$/.exec(state?.id || state?.getAttribute('id') || '')?.[1];
    const titleNode = row.querySelector('[data-purpose="item-title"]');
    const rawTitle = text(titleNode?.innerText || titleNode?.textContent);
    if (!lectureId || !rawTitle) return null;
    const prefix = /^(\d+)\s*[.．)、]\s*(.+)$/.exec(rawTitle);
    const title = prefix ? text(prefix[2]) : rawTitle;
    const number = prefix ? Number(prefix[1]) : position;
    return { key: lectureId, lectureId, title, index: Number.isSafeInteger(number) && number > 0 ? number : position, lectureIndex: Number.isSafeInteger(number) && number > 0 ? number : position, sectionIndex, kind: iconKind(row) };
  }
  function checkOperation(token, courseKey) {
    if (token !== operation) throw new Error('課程目錄操作已取消。');
    requireCourse(courseKey);
  }
  async function expand(index, expectedCount, token, courseKey) {
    checkOperation(token, courseKey);
    let panel = findPanel(index);
    const button = heading(panel);
    if (button.getAttribute('aria-expanded') !== 'true') {
      if (disabled(button)) throw new Error(`第 ${index + 1} 章的展開按鈕目前不可用。`);
      button.click();
    }
    const deadline = Date.now() + 4000;
    let lastSignature = null;
    while (Date.now() < deadline) {
      checkOperation(token, courseKey);
      panel = findPanel(index);
      const currentRows = rows(panel);
      const expanded = heading(panel).getAttribute('aria-expanded') === 'true';
      const signature = currentRows.map(row => text(row.querySelector('[data-purpose="item-title"]')?.textContent)).join('\n');
      const countMatches = expectedCount === null ? currentRows.length > 0 : currentRows.length === expectedCount;
      if (expanded && countMatches && signature === lastSignature) return panel;
      lastSignature = signature;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return findPanel(index);
  }
  function courseTitle() {
    const node = Array.from(document.querySelectorAll('[data-purpose="course-title"], h1')).find(visible);
    return text(node?.innerText || node?.textContent || document.title.replace(/\s*[|–-]\s*Udemy\s*$/i, ''));
  }

  async function collect(expectedPageUrl) {
    clearPendingPause();
    const current = courseAt();
    if (courseAt(expectedPageUrl).courseKey !== current.courseKey) throw new Error('課程已切換，請從目前課程重新開啟批次工具。');
    const token = ++operation;
    catalogCourse = current.courseKey;
    activation = null;
    fallback = null;
    const initial = panels();
    if (!initial.length) throw new Error('找不到可辨識的章節標題，這個課程目錄版型尚未支援。');
    const indices = initial.map(panelNumber);
    if (new Set(indices).size !== indices.length || indices.some((index, offset) => index !== offset)) throw new Error('課程目錄缺少章節或章節順序不完整，請展開課程內容側欄後重新掃描。');
    const notes = [];
    const sections = [];
    const seen = new Set();
    let complete = true;
    let position = 0;
    for (const index of indices) {
      checkOperation(token, current.courseKey);
      const info = sectionInfo(findPanel(index));
      const panel = await expand(index, info.expectedCount, token, current.courseKey);
      const renderedRows = rows(panel);
      const items = [];
      for (const row of renderedRows) {
        position += 1;
        const item = rowInfo(row, info.sectionIndex, position);
        if (!item || seen.has(item.lectureId)) { complete = false; notes.push(`第 ${info.sectionIndex} 章有無法辨識或重複的講座列。`); continue; }
        seen.add(item.lectureId);
        items.push({ ...item, sectionTitle: info.title, courseKey: current.courseKey });
      }
      if (info.expectedCount === null) { complete = false; notes.push(`第 ${info.sectionIndex} 章未提供可辨識的總堂數，無法確認目錄完整。`); }
      else if (items.length !== info.expectedCount) { complete = false; notes.push(`第 ${info.sectionIndex} 章應有 ${info.expectedCount} 堂，目前辨識 ${items.length} 堂。`); }
      if (heading(panel).getAttribute('aria-expanded') !== 'true') { complete = false; notes.push(`第 ${info.sectionIndex} 章尚未完成展開。`); }
      sections.push({ ...info, items });
    }
    checkOperation(token, current.courseKey);
    const finalIndices = panels().map(panelNumber);
    if (JSON.stringify(finalIndices) !== JSON.stringify(indices)) { complete = false; notes.push('掃描時章節清單發生變更，請重新掃描。'); }
    for (const section of sections) {
      const panel = findPanel(section.sectionIndex - 1);
      if (rows(panel).length !== section.items.length) { complete = false; notes.push(`第 ${section.sectionIndex} 章的顯示內容在掃描期間變更。`); }
    }
    notes.push('目錄只依目前課程側欄實際展開的章節與講座列建立；完整性依各章節顯示的總堂數核對。');
    return { courseTitle: courseTitle(), pageUrl: courseAt().pageUrl, courseKey: current.courseKey, sections, complete, total: sections.reduce((sum, section) => sum + section.items.length, 0), notes: Array.from(new Set(notes)) };
  }

  function validateItem(item) {
    if (!item || !/^\d+$/.test(item.lectureId || '') || item.key !== item.lectureId || !Number.isSafeInteger(item.sectionIndex) || item.sectionIndex < 1 || !text(item.title)) throw new Error('講座資料不完整，請重新建立課程目錄。');
    const key = item.courseKey || catalogCourse;
    const current = requireCourse(key);
    return { current, courseKey: key };
  }
  function locateItem(item) {
    const panel = findPanel(item.sectionIndex - 1);
    const matches = rows(panel).map(row => ({ row, info: rowInfo(row, item.sectionIndex, item.index) })).filter(entry => entry.info?.lectureId === item.lectureId);
    if (matches.length !== 1) throw new Error('找不到唯一對應的講座列，請重新掃描課程目錄。');
    const match = matches[0];
    if (match.info.title !== text(item.title) || match.info.kind !== item.kind) throw new Error('講座標題或類型已變更，請重新掃描課程目錄。');
    return match;
  }
  function currentVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter(visible);
    if (videos.length !== 1) return null;
    const video = videos[0];
    const assetId = /^lecture-(\d+)$/.exec(video.id || '')?.[1] || /^shaka-video-container-(\d+)$/.exec(video.parentElement?.id || '')?.[1];
    return assetId ? { video, assetId } : null;
  }
  async function activate(item) {
    clearPendingPause();
    const { current, courseKey } = validateItem(item);
    if (activation && activation.courseKey === courseKey && current.lectureId !== activation.lectureId) throw new Error('偵測到手動切換講座，已停止批次操作；請重新掃描後再開始。');
    const token = ++operation;
    const info = sectionInfo(findPanel(item.sectionIndex - 1));
    await expand(item.sectionIndex - 1, info.expectedCount, token, courseKey);
    checkOperation(token, courseKey);
    if (courseAt().lectureId !== current.lectureId) throw new Error('偵測到手動切換講座，已停止批次操作；請重新掃描後再開始。');
    const match = locateItem(item);
    if (item.kind !== 'video') throw new Error('此目錄項目不是可辨識的影片講座，已停止切換。');
    const alreadyCurrent = courseAt().lectureId === item.lectureId && match.row.getAttribute('aria-current') === 'true';
    const before = currentVideo();
    activation = { lectureId: item.lectureId, title: item.title, courseKey, priorLectureId: current.lectureId, priorAssetId: before?.assetId || null, at: performance.now(), changed: !alreadyCurrent };
    fallback = null;
    if (!alreadyCurrent) {
      const playButtons = Array.from(match.row.querySelectorAll('button')).filter(button => visible(button) && !disabled(button) && !button.querySelector('input[data-purpose="progress-toggle-button"]') && Array.from(button.querySelectorAll('svg use')).some(node => /#icon-video$/.test(node.getAttribute('href') || node.getAttribute('xlink:href') || '')));
      if (playButtons.length > 1) throw new Error('講座有多個播放按鈕，無法安全判定要操作的控制項。');
      const target = playButtons[0] || match.row.querySelector('[data-purpose="item-title"]');
      if (!target || !visible(target) || disabled(target)) throw new Error('講座的播放控制項目前不可用。');
      target.click();
    }
    return { ok: true, lectureId: item.lectureId, alreadyCurrent };
  }

  function resourceEntry(entry) {
    try {
      const url = new URL(entry.name);
      const assetId = /^\/assets\/(\d+)\//.exec(url.pathname)?.[1];
      if (url.origin !== location.origin || url.protocol !== 'https:' || !/(^|\.)udemy\.com$/i.test(url.hostname) || !assetId || !/\.m3u8$/i.test(url.pathname)) return null;
      return { url: url.href, at: Number(entry.startTime) || 0, isMaster: !url.pathname.includes('/hls/'), assetId };
    } catch { return null; }
  }
  function retainResource(entry) {
    const value = resourceEntry(entry);
    if (!value) return;
    observed.delete(value.url);
    observed.set(value.url, value);
    while (observed.size > MAX_OBSERVED) observed.delete(observed.keys().next().value);
  }
  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver(list => list.getEntries().forEach(retainResource));
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch { /* Existing performance entries remain available as a fallback. */ }

  function capture(item) {
    const { current, courseKey } = validateItem(item);
    const record = activation?.lectureId === item.lectureId && activation.courseKey === courseKey ? activation : null;
    if (current.lectureId !== item.lectureId) {
      if (record && (record.ready || current.lectureId !== record.priorLectureId)) throw new Error('偵測到手動切換講座，已停止批次操作；請重新掃描後再開始。');
      return { status: 'pending', reason: '等待講座網址切換。' };
    }
    let match;
    try { match = locateItem(item); } catch { return { status: 'pending', reason: '等待課程目錄載入對應講座。' }; }
    if (match.row.getAttribute('aria-current') !== 'true') return { status: 'pending', reason: '等待課程目錄確認目前講座。' };
    const player = currentVideo();
    if (!player) return { status: 'pending', reason: '等待唯一可辨識的影片播放器。' };
    const region = player.video.closest('section[aria-label], [role="region"][aria-label]');
    if (!region || !text(region.getAttribute('aria-label')).endsWith(text(item.title))) return { status: 'pending', reason: '等待播放器顯示對應的講座標題。' };
    if (record?.changed && record.priorAssetId && record.priorAssetId === player.assetId) return { status: 'pending', reason: '等待播放器切換到新講座的影片。' };
    if (!record) {
      const signature = `${courseKey}|${item.lectureId}|${player.assetId}|${text(region.getAttribute('aria-label'))}`;
      if (fallback?.signature !== signature) { fallback = { signature, at: performance.now() }; return { status: 'pending', reason: '正在確認重新載入後的講座與播放器一致。' }; }
      if (performance.now() - fallback.at < 200) return { status: 'pending', reason: '等待再次確認講座與播放器一致。' };
    }
    const candidates = new Map(observed);
    for (const entry of performance.getEntriesByType('resource')) {
      const value = resourceEntry(entry);
      if (value && (!candidates.has(value.url) || candidates.get(value.url).at < value.at)) candidates.set(value.url, value);
    }
    const threshold = record?.changed ? record.at : 0;
    const found = Array.from(candidates.values()).filter(entry => entry.assetId === player.assetId && entry.at >= threshold).sort((a, b) => Number(b.isMaster) - Number(a.isMaster) || b.at - a.at).slice(0, 12).map(({ assetId: _assetId, ...entry }) => entry);
    if (!found.length) {
      // A MediaKeys object can remain attached across lectures or be created
      // before an unencrypted source is selected. It is not evidence that
      // this lecture's stream is encrypted; playlist and segment validation
      // make that decision after the matching resource is available.
      const mediaKeysAttached = Boolean(player.video.mediaKeys);
      return { status: 'pending', mediaKeysAttached, reason: mediaKeysAttached
        ? '播放器已連接媒體保護模組，但尚未取得這堂講座的 HLS 清單，無法判定串流是否加密。'
        : '等待這堂講座的 HLS 清單載入。' };
    }
    player.video.pause();
    if (record) record.ready = true;
    else activation = { lectureId: item.lectureId, title: item.title, courseKey, priorLectureId: item.lectureId, priorAssetId: player.assetId, at: performance.now(), changed: false, ready: true };
    return { status: 'ready', assetId: player.assetId, pageUrl: current.pageUrl, candidates: found, createdAt: Date.now(), courseTitle: courseTitle(), lectureTitle: item.title, lectureId: item.lectureId };
  }

  function pauseExpected(record, eventTarget) {
    try {
      const current = courseAt();
      if (current.courseKey !== record.courseKey || current.lectureId !== record.lectureId) return false;
      const player = currentVideo();
      if (!player || (eventTarget && eventTarget !== player.video) || (record.changed && record.priorAssetId === player.assetId)) return false;
      const region = player.video.closest('section[aria-label], [role="region"][aria-label]');
      if (!region || !text(region.getAttribute('aria-label')).endsWith(text(record.title))) return false;
      player.video.pause();
      return true;
    } catch { return false; }
  }

  function cancel() {
    operation += 1;
    clearPendingPause();
    const record = activation;
    if (!record) return { ok: true };
    pauseExpected(record);
    // A play click can have started a SPA transition before cancellation arrived.
    // Observe that one expected target briefly, without blocking later playback.
    if (record.changed && !record.ready) {
      let current;
      try { current = courseAt(); } catch { return { ok: true }; }
      if (current.courseKey !== record.courseKey || ![record.priorLectureId, record.lectureId].includes(current.lectureId)) return { ok: true };
      let timer;
      const cleanup = () => {
        document.removeEventListener('play', onPlayback, true);
        document.removeEventListener('playing', onPlayback, true);
        clearTimeout(timer);
        if (pendingPauseCleanup === cleanup) pendingPauseCleanup = null;
      };
      const onPlayback = event => { if (pauseExpected(record, event.target)) cleanup(); };
      pendingPauseCleanup = cleanup;
      document.addEventListener('play', onPlayback, true);
      document.addEventListener('playing', onPlayback, true);
      timer = setTimeout(cleanup, 5000);
    }
    return { ok: true };
  }

  globalThis.UdemyCoursePage = Object.freeze({ version, collect, activate, capture, cancel });
})();
