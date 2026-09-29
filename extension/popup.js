import { supportedPage, summarize, safeReport } from './core.mjs';

const $ = id => document.getElementById(id);
let targetTabId;
let scan;
let busy = false;

function feedback(text) { $('feedback').textContent = text; }

function controls() {
  $('refresh').disabled = busy || !targetTabId;
  $('inspect-menu').disabled = busy || !scan?.settingsAvailable;
  $('export').disabled = busy || !scan;
  $('stream').disabled = busy || !scan?.hasVideo;
  $('course-batch').disabled = busy || !scan || scan.loggedOut;
  for (const button of document.querySelectorAll('[data-download-id]')) {
    button.disabled = busy || button.dataset.unavailable === 'true' || button.dataset.sent === 'true';
  }
}

async function run(action) {
  if (busy) return;
  busy = true;
  controls();
  feedback('');
  try { await action(); }
  catch (error) { feedback(error.message || '操作失敗，請重新開啟工具後重試。'); }
  finally { busy = false; controls(); }
}

async function invoke(method, id) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: async (method, id) => {
      try {
        const api = globalThis.UdemyDownloadPage;
        if (!api) throw new Error('頁面已更新，請先按「重新檢查」。');
        if (!['inspect', 'openSettings', 'activate'].includes(method)) throw new Error('不支援的操作。');
        return { ok: true, value: await api[method](id) };
      } catch (error) { return { ok: false, error: error.message }; }
    },
    args: [method, id ?? null]
  });
  if (!result?.ok) throw new Error(result?.error || '無法讀取頁面。請重新整理 Udemy，再開啟工具。');
  return result.value;
}

function render(next) {
  scan = next;
  $('course-title').textContent = next.courseTitle || 'Udemy 課程';
  $('lecture-title').textContent = next.lectureTitle || (next.lectureId ? `講座 ${next.lectureId}` : '尚未選取講座');
  const status = summarize(next);
  $('status-card').className = `status ${status.tone}`;
  $('status-title').textContent = status.title;
  $('status-text').textContent = status.text;
  $('count').textContent = next.downloads.length;
  $('empty').hidden = next.downloads.length > 0;
  $('downloads').replaceChildren();
  for (const item of next.downloads) {
    const row = document.createElement('li');
    const label = document.createElement('div');
    label.className = 'item-label';
    label.textContent = item.label;
    const kind = document.createElement('span');
    kind.className = 'item-kind';
    kind.textContent = item.kind === 'lecture' ? '影片講座' : '教材資源';
    label.append(kind);
    const button = document.createElement('button');
    button.textContent = item.disabled ? '未開放' : '下載';
    button.dataset.downloadId = item.id;
    button.dataset.unavailable = String(item.disabled);
    button.addEventListener('click', () => run(async () => {
      const result = await invoke('activate', item.id);
      if (!result?.ok) throw new Error('頁面未接受下載操作。');
      button.dataset.sent = 'true';
      button.textContent = '已送出';
      feedback('已觸發 Udemy 下載操作。請在 Chrome 下載清單確認是否開始及完成；這裡不會把「已送出」當成「下載完成」。');
      try {
        const saved = await chrome.storage.local.get('requestedDownloads');
        const records = Array.isArray(saved.requestedDownloads) ? saved.requestedDownloads : [];
        records.push({ at: new Date().toISOString(), pageUrl: safeReport(scan).pageUrl, label:item.label, status:'requested' });
        await chrome.storage.local.set({requestedDownloads:records.slice(-100)});
      } catch { feedback('已觸發下載操作，但無法儲存本機紀錄。請查看 Chrome 下載清單。'); }
    }));
    row.append(label, button);
    $('downloads').append(row);
  }
  controls();
}

async function inspect() {
  scan = null;
  $('downloads').replaceChildren();
  controls();
  await chrome.scripting.executeScript({target:{tabId:targetTabId},files:['page-adapter.js']});
  render(await invoke('inspect'));
}

$('refresh').addEventListener('click', () => run(inspect));
$('course-batch').addEventListener('click',()=>run(async()=>{
  const key=`course-${crypto.randomUUID()}`;
  const pageUrl=safeReport(scan).pageUrl;
  const existing=await chrome.storage.session.get(null);
  const expired=Object.keys(existing).filter(k=>/^(stream|course)-/.test(k)&&Date.now()-(existing[k]?.createdAt||0)>600000);
  if(expired.length)await chrome.storage.session.remove(expired);
  await chrome.storage.session.set({[key]:{tabId:targetTabId,pageUrl,courseTitle:scan.courseTitle,createdAt:Date.now()}});
  await chrome.tabs.create({url:chrome.runtime.getURL(`batch.html?job=${encodeURIComponent(key)}`)});
}));
$('stream').addEventListener('click', () => run(async () => {
  const [{result}] = await chrome.scripting.executeScript({
    target:{tabId:targetTabId},
    func: () => {
      const page = new URL(location.href);
      if (page.protocol !== 'https:' || !/(^|\.)udemy\.com$/.test(page.hostname) || !/^\/course\/[^/]+\/learn\/lecture\/\d+\/?$/.test(page.pathname)) return {error:'請先開啟 Udemy 講座。'};
      const videos = Array.from(document.querySelectorAll('video')).filter(v => v.getClientRects().length);
      if (videos.length !== 1) return {error:'無法確認目前播放器。請保留一個影片播放器，再重試。'};
      const video = videos[0];
      // A connected MediaKeys object does not establish that this lecture's stream is encrypted.
      // The manager checks the selected playlist and each segment before saving.
      const assetId = /^lecture-(\d+)$/.exec(video.id)?.[1] || /^shaka-video-container-(\d+)$/.exec(video.parentElement?.id || '')?.[1];
      if (!assetId) return {error:'無法辨識目前講座的影片 ID，為避免下載錯課已停止。'};
      const candidates = new Map();
      for (const entry of performance.getEntriesByType('resource')) {
        try {
          const url = new URL(entry.name);
          if (url.origin === page.origin && url.pathname.startsWith(`/assets/${assetId}/`) && /\.m3u8$/i.test(url.pathname)) candidates.set(url.href,{url:url.href,at:entry.startTime,isMaster:!url.pathname.includes('/hls/')});
        } catch { /* Ignore non-URL resource entries. */ }
      }
      const found = Array.from(candidates.values()).sort((a,b)=>Number(b.isMaster)-Number(a.isMaster)||b.at-a.at);
      if (!found.length) return {error:'尚未找到這堂講座的 HLS 清單。請重新整理課程、播放幾秒後暫停，再重新檢查。' + (video.mediaKeys ? ' 播放器已連接媒體保護模組；尚未取得清單，無法確認串流是否加密。' : '')};
      return {assetId,pageUrl:page.origin+page.pathname,candidates:found.slice(0,12),createdAt:Date.now()};
    }
  });
  if (result?.error) throw new Error(result.error);
  if (!result?.candidates?.length) throw new Error('無法取得目前講座的串流資訊。');
  if (result.pageUrl !== safeReport(scan).pageUrl) throw new Error('講座已經切換。請按「重新檢查」，再啟動串流備份。');
  const key = `stream-${crypto.randomUUID()}`;
  const existing = await chrome.storage.session.get(null);
  const expired = Object.keys(existing).filter(k=>k.startsWith('stream-') && Date.now()-(existing[k]?.createdAt || 0)>600000);
  if (expired.length) await chrome.storage.session.remove(expired);
  await chrome.storage.session.set({[key]:{...result,courseTitle:scan.courseTitle,lectureTitle:scan.lectureTitle,lectureId:scan.lectureId}});
  await chrome.tabs.create({url:chrome.runtime.getURL(`manager.html?job=${encodeURIComponent(key)}`)});
}));
$('inspect-menu').addEventListener('click', () => run(async () => render(await invoke('openSettings'))));
$('export').addEventListener('click', () => run(async () => {
  const data = JSON.stringify(safeReport(scan), null, 2);
  const url = URL.createObjectURL(new Blob([data], {type:'application/json;charset=utf-8'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `udemy-check-${scan.lectureId || 'course'}-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  feedback('已匯出本次檢查；不包含影片、Cookie 或串流網址。');
}));

run(async () => {
  if (!globalThis.chrome?.scripting) throw new Error('請在 Chrome 載入擴充功能，再從 Udemy 課程頁點擊工具圖示。');
  const [active] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!active?.id || !supportedPage(active.url)) {
    $('course-title').textContent = '請先開啟 Udemy 課程';
    $('status-title').textContent = '目前分頁不是課程播放器';
    $('status-text').textContent = '在已登入的 Udemy 中進入一堂課，再點開此工具。';
    return;
  }
  targetTabId = active.id;
  await inspect();
});
