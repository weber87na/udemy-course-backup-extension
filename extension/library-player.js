(() => {
  'use strict';
  const version = 'library-player-v1';
  if (globalThis.UdemyLibraryPlayer?.version === version) return;

  const LIMIT = 96;
  const resources = new Map();
  const manifests = new Map();
  let sawHls = false;
  let manifestOverflow = false;
  let lockedItem = null;
  let stable = null;
  let played = false;
  let invalidated = false;

  function text(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  function courseAt(value) {
    try {
      const url = new URL(value);
      const match = /^\/course\/([^/]+)\/learn\/lecture\/(\d+)\/?$/.exec(url.pathname);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)udemy\.com$/i.test(url.hostname) || !match) return null;
      return { courseKey: `${url.origin}/course/${match[1]}`, lectureId: match[2], pageUrl: `${url.origin}${url.pathname}`, origin: url.origin };
    } catch { return null; }
  }
  const initial = courseAt(location.href);
  let navigation = null;
  try {
    const entries = performance.getEntriesByType('navigation');
    if (entries.length) navigation = courseAt(entries[0].name) || false;
  } catch { /* Some environments do not expose navigation timing. */ }

  function sameLecture(left, right) {
    return Boolean(left && right && left.courseKey === right.courseKey && left.lectureId === right.lectureId);
  }
  function visible(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    for (let current = node; current instanceof Element; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  }
  function retain(entry) {
    try {
      const url = new URL(entry.name);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !Number.isFinite(entry.startTime) || entry.startTime < 0) return;
      if (/\.m3u8$/i.test(url.pathname)) {
        // Any HLS observation prevents attributing an otherwise unbound DASH URL.
        sawHls = true;
        const assetId = /^\/assets\/(\d+)\//.exec(url.pathname)?.[1];
        if (!initial || url.origin !== initial.origin || !assetId) return;
        const value = { url: url.href, assetId, isMaster: !url.pathname.includes('/hls/'), at: entry.startTime };
        if (resources.get(value.url)?.at > value.at) return;
        resources.delete(value.url);
        resources.set(value.url, value);
        while (resources.size > LIMIT) resources.delete(resources.keys().next().value);
      } else if (/\.mpd$/i.test(url.pathname)) {
        // Count foreign manifests too: a CDN URL cannot be assumed to belong to
        // this player when another manifest has been loaded by this document.
        if (!manifests.has(url.href) && manifests.size >= LIMIT) { manifestOverflow = true; return; }
        if (manifests.get(url.href)?.at > entry.startTime) return;
        manifests.set(url.href, { url: url.href, at: entry.startTime, isMaster: true, allowed: /(^|\.)udemycdn\.com$/i.test(url.hostname) });
      }
    } catch { /* Ignore malformed resource records. */ }
  }
  function collectResources() {
    try { performance.getEntriesByType('resource').forEach(retain); } catch { /* Observer records may still be available. */ }
  }
  collectResources();
  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver(list => list.getEntries().forEach(retain));
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch { /* Resource timing remains available as a fallback. */ }

  function pending(reason) { stable = null; return { status: 'pending', reason }; }
  function bind(item) {
    const current = courseAt(location.href);
    if (invalidated || !sameLecture(initial, current) || (navigation !== null && !sameLecture(initial, navigation))) {
      invalidated = true;
      throw new Error('檢查分頁不是這堂講座的完整重新載入，請重新開啟檢查分頁。');
    }
    if (!item || typeof item.lectureId !== 'string' || !/^\d+$/.test(item.lectureId) || !text(item.title) || !sameLecture(current, item)) throw new Error('講座資料與檢查分頁不一致。');
    if (lockedItem && (!sameLecture(lockedItem, item) || lockedItem.title !== text(item.title))) throw new Error('這個檢查分頁已綁定其他講座，請完整重新載入。');
    lockedItem ||= { courseKey: item.courseKey, lectureId: item.lectureId, title: text(item.title) };
    const sidebar = document.getElementById('ct-sidebar-scroll-container');
    if (!visible(sidebar)) return { pending: '等待可見的課程內容側欄。' };
    const rows = Array.from(sidebar.querySelectorAll('li[aria-current="true"]')).filter(visible);
    if (rows.length !== 1) return { pending: '等待課程目錄確認唯一的目前講座。' };
    const markers = Array.from(rows[0].querySelectorAll('[id^="item-completion-state-"]'));
    if (markers.length !== 1 || markers[0].id !== `item-completion-state-${item.lectureId}`) return { pending: '等待課程目錄顯示對應講座。' };
    const videos = Array.from(document.querySelectorAll('video')).filter(visible);
    if (videos.length !== 1) return { pending: '等待唯一可辨識的影片播放器。' };
    const video = videos[0];
    const videoAsset = /^lecture-(\d+)$/.exec(video.id || '')?.[1];
    const parentAsset = /^shaka-video-container-(\d+)$/.exec(video.parentElement?.id || '')?.[1];
    if (videoAsset && parentAsset && videoAsset !== parentAsset) return { pending: '等待播放器影片識別一致。' };
    const assetId = videoAsset || parentAsset;
    if (!assetId) return { pending: '等待播放器影片識別。' };
    const region = video.closest('section[aria-label], [role="region"][aria-label]');
    const title = text(region?.getAttribute('aria-label'));
    if (!region || !title.endsWith(text(item.title))) return { pending: '等待播放器顯示對應的講座標題。' };
    return { current, video, assetId, title, row: rows[0] };
  }

  function inspect(item, { play = false } = {}) {
    const binding = bind(item);
    if (binding.pending) return pending(binding.pending);
    const { current, video, assetId, title, row } = binding;
    const signature = `${current.courseKey}|${current.lectureId}|${assetId}|${title}`;
    if (!stable || stable.signature !== signature || stable.video !== video || stable.row !== row) {
      stable = { signature, video, row, at: performance.now() };
      return { status: 'pending', reason: '正在確認講座與播放器一致。' };
    }
    if (performance.now() - stable.at < 200) return { status: 'pending', reason: '等待再次確認講座與播放器一致。' };
    if (play === true && !played) {
      played = true;
      try {
        video.muted = true;
        const result = video.play();
        if (result?.catch) result.catch(() => {});
      } catch { /* A blocked autoplay remains an unknown source, not DRM. */ }
    }
    collectResources();
    const hls = Array.from(resources.values()).filter(entry => entry.assetId === assetId)
      .sort((a, b) => Number(b.isMaster) - Number(a.isMaster) || b.at - a.at).slice(0, 12)
      .map(({ assetId: _assetId, ...entry }) => entry);
    let kind = 'hls';
    let candidates = hls;
    if (!hls.length) {
      if (sawHls) return { status: 'pending', reason: '已載入 HLS，但尚未確認清單屬於這堂影片。' };
      if (manifestOverflow || manifests.size > 1) return { status: 'pending', reason: '頁面載入多個 DASH 清單，無法確認影片來源。' };
      const manifest = Array.from(manifests.values())[0];
      if (!manifest?.allowed) return { status: 'pending', reason: '尚未取得可確認的 HLS 或 DASH 來源。' };
      if (video.readyState < 2) return { status: 'pending', reason: '等待播放器載入影片，以確認 DASH 來源。' };
      const { allowed: _allowed, ...candidate } = manifest;
      kind = 'dash';
      candidates = [candidate];
    }
    // Pausing happens only after the item, row, player, and source were checked.
    try { video.pause(); } catch { /* Inspection results remain valid if pause fails. */ }
    return { status: 'ready', kind, lectureId: current.lectureId, assetId, pageUrl: current.pageUrl, candidates };
  }
  function pause() {
    if (!lockedItem) return { ok: false };
    try {
      const binding = bind(lockedItem);
      if (binding.pending || !stable || binding.video !== stable.video) return { ok: false };
      const signature = `${binding.current.courseKey}|${binding.current.lectureId}|${binding.assetId}|${binding.title}`;
      if (signature !== stable.signature || binding.row !== stable.row) return { ok: false };
      binding.video.pause();
      return { ok: true };
    } catch { return { ok: false }; }
  }
  globalThis.UdemyLibraryPlayer = Object.freeze({ version, inspect, pause });
})();
