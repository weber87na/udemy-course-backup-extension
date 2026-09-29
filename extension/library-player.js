(() => {
  'use strict';
  const version = 'library-player-v2';
  if (globalThis.UdemyLibraryPlayer?.version === version) return;

  const LIMIT = 96;
  const resources = new Map();
  const manifests = new Map();
  let sawHls = false;
  let manifestOverflow = false;
  let lockedItem = null;
  let stable = null;
  let playAttempts = 0;
  let lastPlayAt = -Infinity;
  let playback = null;
  let playbackBlocked = false;
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

  function pending(reason, reasonCode, reset = false) {
    if (reset) stable = null;
    return { status: 'pending', reason, reasonCode };
  }
  function fail(reason, code) { throw Object.assign(new Error(reason), { code }); }
  function bind(item) {
    const current = courseAt(location.href);
    if (invalidated || !sameLecture(initial, current) || (navigation !== null && !sameLecture(initial, navigation))) {
      invalidated = true;
      fail('檢查分頁不是這堂講座的完整重新載入，請重新開啟檢查分頁。', 'source-page-changed');
    }
    if (!item || typeof item.lectureId !== 'string' || !/^\d+$/.test(item.lectureId) || !text(item.title) || !sameLecture(current, item)) fail('講座資料與檢查分頁不一致。', 'lecture-unconfirmed');
    if (lockedItem && (!sameLecture(lockedItem, item) || lockedItem.title !== text(item.title))) fail('這個檢查分頁已綁定其他講座，請完整重新載入。', 'lecture-unconfirmed');
    lockedItem ||= { courseKey: item.courseKey, lectureId: item.lectureId, title: text(item.title) };
    const sidebar = document.getElementById('ct-sidebar-scroll-container');
    if (!visible(sidebar)) return { pending: '等待可見的課程內容側欄。', reasonCode: 'lecture-unconfirmed' };
    const rows = Array.from(sidebar.querySelectorAll('li[aria-current="true"]')).filter(visible);
    if (rows.length !== 1) return { pending: '等待課程目錄確認唯一的目前講座。', reasonCode: 'lecture-unconfirmed' };
    const markers = Array.from(rows[0].querySelectorAll('[id^="item-completion-state-"]'));
    if (markers.length !== 1 || markers[0].id !== `item-completion-state-${item.lectureId}`) return { pending: '等待課程目錄顯示對應講座。', reasonCode: 'lecture-unconfirmed' };
    const videos = Array.from(document.querySelectorAll('video')).filter(visible);
    if (videos.length !== 1) return { pending: '等待唯一可辨識的影片播放器。', reasonCode: 'player-unavailable' };
    const video = videos[0];
    const videoAsset = /^lecture-(\d+)$/.exec(video.id || '')?.[1];
    const parentAsset = /^shaka-video-container-(\d+)$/.exec(video.parentElement?.id || '')?.[1];
    if (videoAsset && parentAsset && videoAsset !== parentAsset) return { pending: '等待播放器影片識別一致。', reasonCode: 'asset-unconfirmed' };
    const assetId = videoAsset || parentAsset;
    if (!assetId) return { pending: '等待播放器影片識別。', reasonCode: 'asset-unconfirmed' };
    const region = video.closest('section[aria-label], [role="region"][aria-label]');
    const title = text(region?.getAttribute('aria-label'));
    if (!region || !title.endsWith(text(item.title))) return { pending: '等待播放器顯示對應的講座標題。', reasonCode: 'player-title-unconfirmed' };
    return { current, video, assetId, title, row: rows[0] };
  }

  function tryPlayback(video) {
    const at = performance.now();
    if (playbackBlocked || playAttempts >= 3 || at - lastPlayAt < 1000) return;
    if (playback?.video === video && playback.state !== 'retryable') return;
    const attempt = { video, state: 'pending' };
    playback = attempt;
    playAttempts += 1;
    lastPlayAt = at;
    const failed = error => {
      if (playback !== attempt) return;
      playbackBlocked = error?.name === 'NotAllowedError';
      attempt.state = playbackBlocked ? 'blocked' : 'retryable';
    };
    try {
      video.muted = true;
      const result = video.play();
      if (result?.then) result.then(() => {
        if (playback === attempt) attempt.state = 'started';
      }, failed);
      else attempt.state = 'started';
    } catch (error) { failed(error); }
  }

  function waitingForSource(video, fallbackReason, fallbackCode = 'source-unconfirmed') {
    if (playbackBlocked) return pending('瀏覽器拒絕自動播放，請在課程頁啟動播放後重試檢查。', 'playback-blocked');
    if (playAttempts >= 3 && (playback?.state === 'retryable' || playback?.video !== video)) return pending('已嘗試啟動播放器三次，仍無法載入影片來源。', 'player-unavailable');
    if (playback?.video === video) {
      if (playback.state === 'retryable' || playback.state === 'pending') {
        const result = pending(playback.state === 'retryable'
          ? '播放器尚未成功啟動，稍後會在本堂重新嘗試。'
          : '播放器正在啟動，等待影片來源載入。', 'player-loading');
        // The caller may activate only its own inspection tab. A hidden page
        // alone is insufficient: a stable, bound player must be awaiting play.
        if (document.visibilityState === 'hidden') result.needsForeground = true;
        return result;
      }
    }
    return pending(fallbackReason, fallbackCode);
  }

  function inspect(item, { play = false } = {}) {
    const binding = bind(item);
    if (binding.pending) return pending(binding.pending, binding.reasonCode, true);
    const { current, video, assetId, title, row } = binding;
    const signature = `${current.courseKey}|${current.lectureId}|${assetId}|${title}`;
    if (!stable || stable.signature !== signature || stable.video !== video || stable.row !== row) {
      stable = { signature, video, row, at: performance.now() };
      return pending('正在確認講座與播放器一致。', 'player-loading');
    }
    if (performance.now() - stable.at < 200) return pending('等待再次確認講座與播放器一致。', 'player-loading');
    if (play === true) tryPlayback(video);
    collectResources();
    const hls = Array.from(resources.values()).filter(entry => entry.assetId === assetId)
      .sort((a, b) => Number(b.isMaster) - Number(a.isMaster) || b.at - a.at).slice(0, 12)
      .map(({ assetId: _assetId, ...entry }) => entry);
    let kind = 'hls';
    let candidates = hls;
    if (!hls.length) {
      if (sawHls) return pending('已載入 HLS，但尚未確認清單屬於這堂影片。', 'source-unconfirmed');
      if (manifestOverflow || manifests.size > 1) return pending('頁面載入多個 DASH 清單，無法確認影片來源。', 'source-ambiguous');
      const manifest = Array.from(manifests.values())[0];
      if (!manifest?.allowed) return waitingForSource(video, '尚未取得可確認的 HLS 或 DASH 來源。');
      if (video.readyState < 2) return waitingForSource(video, '等待播放器載入影片，以確認 DASH 來源。', 'player-loading');
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
