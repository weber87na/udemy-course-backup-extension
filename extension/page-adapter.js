(() => {
  'use strict';

  // This isolated-world adapter deliberately inspects rendered controls only.
  // It never reads video sources, application state, cookies, or network traffic.
  const version = 'official-controls-v1';
  if (globalThis.UdemyDownloadPage?.version === version) return;

  const downloadNames = /^(?:download lecture|download video|下載講座|下載講課|下載課時|下載影片|下载讲座|下载讲课|下载课时|下载视频)$/i;
  const settingsNames = /^(?:settings|player settings|video settings|設定|播放器設定|影片設定|设置|播放器设置|视频设置)$/i;
  const resourceNames = /^(?:resources?|downloadable resources?|課程資源|講座資源|資源|資源下載|课程资源|讲座资源|资源|资源下载)(?:\s*[（(]?\d+[）)]?)?$/i;
  const fileExtension = /\.(?:pdf|zip|7z|rar|tar|gz|txt|md|csv|tsv|json|xml|yml|yaml|docx?|xlsx?|pptx?|odt|ods|odp|epub|srt|vtt|png|jpe?g|gif|webp|svg|mp3|m4a|wav|mp4|m4v|webm|mov|cs|js|ts|py|html|css|sql|ipynb|sln|csproj)$/i;
  const playerSelector = '[data-purpose="video-player"], [data-purpose="shaka-video-player"], [data-purpose="video-player-container"], [data-purpose="video-player-wrapper"], [data-purpose="video-controls"], [data-purpose="video-player-controls"], .video-js';
  let generation = 0;
  let candidates = new Map();

  function clean(value, limit = 240) {
    return String(value || '').replace(/(?:https?:\/\/|blob:|data:)[^\s<>]+/gi, '[連結]').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function visible(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    for (let current = node; current instanceof Element; current = current.parentElement) {
      if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    // Elements below the viewport remain eligible; clipping by the viewport is
    // different from a collapsed or hidden menu.
    return Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  }

  function disabled(node) {
    return Boolean(node.disabled || node.matches(':disabled') || node.closest('[aria-disabled="true"], [disabled], [inert]'));
  }

  function labels(node) {
    return [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent].map(value => clean(value)).filter(Boolean);
  }

  function matchingLabel(node, pattern) {
    return labels(node).find(label => pattern.test(label));
  }

  function lessonIdentity() {
    try {
      const url = new URL(location.href);
      const match = url.pathname.match(/^\/course\/([^/]+)\/learn\/lecture\/(\d+)\/?$/);
      if (!match || !/(^|\.)udemy\.com$/i.test(url.hostname) || url.protocol !== 'https:') return null;
      return { key: `${url.origin}/course/${match[1]}/learn/lecture/${match[2]}`, id: match[2], course: match[1] };
    } catch { return null; }
  }

  function publicPageUrl() {
    // Query strings may contain account or expiring download tokens.
    const lesson = lessonIdentity();
    if (lesson) return lesson.key;
    try { const url = new URL(location.href); return `${url.origin}${url.pathname}`; } catch { return ''; }
  }

  function isLoggedOut() {
    if (/\/(?:join\/)?(?:login|signin)(?:\/|$)/i.test(location.pathname)) return true;
    return Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  }

  function textFrom(selectors) {
    for (const selector of selectors) {
      const node = Array.from(document.querySelectorAll(selector)).find(visible);
      if (node) {
        const value = clean(node.getAttribute('aria-label') || node.innerText || node.textContent);
        if (value) return value;
      }
    }
    return '';
  }

  function playerFor(node) {
    const explicit = node.closest(playerSelector);
    if (explicit && (explicit.querySelector('video') || explicit.closest('[data-purpose="video-player"], [data-purpose="shaka-video-player"], [data-purpose="video-player-container"], .video-js')?.querySelector('video'))) return explicit;
    // Precise Udemy controls may be inside a player without a semantic wrapper.
    // Permit their smallest local common ancestor with a video, never the page.
    if (node.getAttribute('data-purpose') === 'settings-button') {
      let ancestor = node.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
        if (['BODY', 'HTML', 'MAIN'].includes(ancestor.tagName) || ancestor.getAttribute('role') === 'main') break;
        if (ancestor.querySelector('video')) return ancestor;
      }
    }
    return null;
  }

  function settingsControls() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).filter(node => {
      if (!visible(node) || disabled(node) || !playerFor(node)) return false;
      if (node.getAttribute('data-purpose') === 'settings-button') return true;
      return Boolean(matchingLabel(node, settingsNames));
    }).filter((node, _index, all) => !all.some(other => other !== node && other.contains(node)));
  }

  function officialLink(node) {
    const raw = node.getAttribute('href');
    if (!raw || raw.trim().startsWith('#')) return null;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:') return null;
      if (url.origin !== location.origin && !/(^|\.)(?:udemy\.com|udemycdn\.com)$/i.test(url.hostname)) return null;
      return url;
    } catch { return null; }
  }

  function inResourceArea(node) {
    let ancestor = node.parentElement;
    for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
      if (['BODY', 'HTML', 'MAIN'].includes(ancestor.tagName) || ancestor.getAttribute('role') === 'main') break;
      const purpose = ancestor.getAttribute('data-purpose') || '';
      if (/^(?:downloadable-resources|lecture-resources|course-resources|resource-list|resources-list|curriculum-item-resources|resource-downloads)$/.test(purpose)) return true;
      if (resourceNames.test(clean(ancestor.getAttribute('aria-label')))) return true;
      const labelledBy = (ancestor.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      if (labelledBy.some(id => {
        const label = document.getElementById(id);
        return label && resourceNames.test(clean(label.innerText || label.textContent));
      })) return true;
    }
    return false;
  }

  function classifyDownload(node) {
    if (!visible(node)) return null;
    const officialLecture = node.getAttribute('data-purpose') === 'download-lecture';
    const lectureLabel = matchingLabel(node, downloadNames);
    if (officialLecture || lectureLabel) {
      // Never turn an unrelated external link into a lecture download merely
      // because it has a matching label.
      if (node.tagName === 'A' && !officialLink(node)) return null;
      return { kind: 'lecture', label: lectureLabel || clean(node.innerText || node.textContent) || '下載講座' };
    }
    if (node.tagName !== 'A') return null;
    const url = officialLink(node);
    if (!url) return null;
    const downloadAttribute = node.hasAttribute('download');
    if (!downloadAttribute && !inResourceArea(node)) return null;
    const linkLabel = clean(node.getAttribute('aria-label') || node.innerText || node.textContent);
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep the encoded path. */ }
    if (!downloadAttribute && !fileExtension.test(path) && !fileExtension.test(linkLabel)) return null;
    // A filename is safe to expose; the destination URL remains in the DOM.
    const filename = clean(node.getAttribute('download'));
    return { kind: 'resource', label: linkLabel || filename || '下載課程資源' };
  }

  function renderedLectures(current) {
    if (!current) return [];
    const result = new Map();
    for (const node of document.querySelectorAll('a[href]')) {
      // This is a list of links already rendered in the DOM, not a course API.
      try {
        const url = new URL(node.getAttribute('href'), location.href);
        if (url.origin !== location.origin) continue;
        const match = url.pathname.match(/^\/course\/([^/]+)\/learn\/lecture\/(\d+)\/?$/);
        if (!match || match[1] !== current.course) continue;
        const canonical = `${url.origin}/course/${match[1]}/learn/lecture/${match[2]}`;
        const title = clean(node.getAttribute('aria-label') || node.innerText || node.textContent);
        if (title && !result.has(canonical)) result.set(canonical, { title, url: canonical });
      } catch { /* Ignore malformed hrefs. */ }
    }
    return Array.from(result.values());
  }

  function inspect() {
    candidates = new Map();
    generation += 1;
    const lesson = lessonIdentity();
    const loggedOut = isLoggedOut();
    const courseTitle = textFrom(['[data-purpose="course-title"]', 'h1[data-purpose="header-title"]', 'h1']) || clean(document.title.replace(/\s*[|–-]\s*Udemy\s*$/i, ''));
    const videoRegion = Array.from(document.querySelectorAll('video')).filter(visible).map(node => node.closest('section[aria-label], [role="region"][aria-label]')).find(Boolean);
    const lectureTitle = textFrom(['[data-purpose="lecture-title"]', '[data-purpose="lecture-heading"]']) || clean(videoRegion?.getAttribute('aria-label')) || textFrom(['main[aria-label]', '[role="main"][aria-label]']);
    const downloads = [];
    const eligibleNodes = lesson && !loggedOut ? Array.from(document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"]')) : [];
    for (const node of eligibleNodes) {
      const classification = classifyDownload(node);
      if (!classification) continue;
      // Udemy may nest an information button inside a disabled download button.
      if (downloads.some(item => candidates.get(item.id).node.contains(node))) continue;
      const id = `download-${generation}-${downloads.length + 1}`;
      const item = { id, ...classification, disabled: disabled(node) };
      candidates.set(id, { node, lessonKey: lesson.key, href: node.getAttribute('href'), ...classification });
      downloads.push(item);
    }
    const settings = lesson && !loggedOut ? settingsControls() : [];
    const notes = [];
    if (loggedOut) notes.push('目前頁面顯示登入表單，請先登入 Udemy 並開啟講座。');
    else if (!lesson) notes.push('請在 Udemy 的課程講座播放頁使用此擴充功能。');
    if (lesson && !loggedOut && downloads.length === 0) notes.push('目前可見頁面沒有可辨識的官方下載項目；可先開啟播放器設定或講座資源。');
    if (downloads.some(item => item.kind === 'lecture' && item.disabled)) notes.push('官方「下載講座」控制項目前停用，無法透過此按鈕下載。');
    if (settings.length > 1) notes.push('頁面出現多個播放器設定按鈕，請手動開啟要使用的播放器設定。');
    notes.push('講座清單只包含頁面 DOM 既有的同課程連結，不代表完整課程目錄。');
    return {
      pageUrl: publicPageUrl(), courseTitle, lectureTitle, lectureId: lesson?.id || '', loggedOut,
      hasVideo: Array.from(document.querySelectorAll('video')).some(visible),
      settingsAvailable: settings.length === 1,
      downloads, lectures: renderedLectures(lesson), notes,
    };
  }

  function activate(id) {
    const candidate = candidates.get(id);
    if (!candidate) throw new Error('下載項目已失效，請重新掃描目前講座。');
    const lesson = lessonIdentity();
    if (!lesson || lesson.key !== candidate.lessonKey || isLoggedOut()) throw new Error('目前講座已變更或尚未登入，請重新掃描。');
    if (!candidate.node.isConnected || !visible(candidate.node)) throw new Error('下載控制項目前不可見，請重新開啟設定或資源後掃描。');
    if (disabled(candidate.node)) throw new Error('Udemy 的下載控制項目前停用，無法下載此項目。');
    if (candidate.node.getAttribute('href') !== candidate.href) throw new Error('下載連結已變更，請重新掃描確認。');
    const current = classifyDownload(candidate.node);
    if (!current || current.kind !== candidate.kind || current.label !== candidate.label) throw new Error('下載控制項已變更，請重新掃描確認。');
    candidate.node.click();
    candidates.delete(id);
    return { ok: true, kind: candidate.kind, label: candidate.label };
  }

  async function openSettings() {
    const lesson = lessonIdentity();
    if (!lesson || isLoggedOut()) throw new Error('請先登入 Udemy，並開啟要下載的講座播放頁。');
    const controls = settingsControls();
    if (controls.length === 0) throw new Error('找不到可見的播放器設定按鈕；請先載入播放器，或手動開啟齒輪設定後重新掃描。');
    if (controls.length !== 1) throw new Error('找到多個播放器設定按鈕，無法確定要操作哪一個；請手動開啟設定後重新掃描。');
    const control = controls[0];
    const player = playerFor(control);
    const menuVisible = () => Boolean(control.getAttribute('aria-expanded') === 'true' ||
      Array.from(document.querySelectorAll('[data-purpose="download-lecture"]')).some(visible) ||
      Array.from(player.querySelectorAll('[role="menu"], [role="menuitem"], [data-purpose="settings-menu"], [data-purpose="video-settings-menu"], [data-purpose="video-settings-popover"]')).some(visible));
    if (menuVisible()) return inspect();
    control.click();
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 120));
      if (lessonIdentity()?.key !== lesson.key) throw new Error('開啟設定時講座已變更，請重新掃描目前頁面。');
      if (menuVisible()) return inspect();
    }
    throw new Error('已點擊播放器設定，但尚未辨識到展開的選單；請手動確認設定已開啟，再重新掃描。');
  }

  globalThis.UdemyDownloadPage = Object.freeze({ version, inspect, openSettings, activate });
})();
