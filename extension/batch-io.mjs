import {loadPlaylist,saveMedia} from './transfer.mjs';
import {chooseVariant,lectureDownloadPath} from './batch-core.mjs';

export function courseIdentity(value) {
  let url;
  try{url=new URL(value);}catch{throw new Error('課程網址無效，請從 Udemy 播放器重新開啟工具。');}
  const match=/^\/course\/([^/]+)\/learn(?:\/|$)/.exec(url.pathname);
  if(url.protocol!=='https:'||!/(^|\.)udemy\.com$/i.test(url.hostname)||url.username||url.password||url.port||!match) throw new Error('請從 Udemy 課程播放器啟動整門課備份。');
  return {key:`${url.origin}/course/${match[1]}`,slug:match[1],pageUrl:url.origin+url.pathname};
}

export function abortIfNeeded(signal) { if(signal?.aborted) throw new DOMException('已停止。','AbortError'); }
export function delay(ms,signal) {
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new DOMException('已停止。','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
  });
}

export function pageBridge(chromeApi,tabId,courseKey) {
  async function checkTab() {
    let tab;
    try {tab=await chromeApi.tabs.get(tabId);}catch{throw new Error('原課程分頁已關閉。請回課程重新開啟整門課備份。');}
    if(tab.discarded||tab.frozen)throw new Error('課程分頁已被 Chrome 暫停。請按「查看課程分頁」喚醒，再重試。');
    if(courseIdentity(tab.url).key!==courseKey)throw new Error('原分頁已切換到其他課程，整批下載已停止。請回到原課程後重試。');
  }
  return {
    async attach() {
      await checkTab();
      try{await chromeApi.scripting.executeScript({target:{tabId},files:['course-adapter.js']});}
      catch{throw new Error('無法讀取課程頁。請確認網站權限、登入狀態，並重新載入課程後重試。');}
    },
    async call(method,arg) {
      await checkTab();
      let entries;
      try {
        entries=await chromeApi.scripting.executeScript({target:{tabId},func:async(method,arg)=>{
          try{
            if(!['collect','activate','capture','cancel'].includes(method))throw new Error('不支援的目錄操作。');
            if(!globalThis.UdemyCoursePage)throw new Error('課程頁已重新整理，請重新載入目錄。');
            return {ok:true,value:await globalThis.UdemyCoursePage[method](arg)};
          }catch(error){return {ok:false,error:error.message};}
        },args:[method,arg]});
      }catch{throw new Error('無法操作原課程分頁。請查看課程是否需要登入或重新載入。');}
      const result=entries?.[0]?.result;
      if(!result?.ok)throw new Error(result?.error||'課程頁沒有回應，請重新載入目錄。');
      return result.value;
    }
  };
}

export async function waitForStream(bridge,item,{signal,timeoutMs=60000,onWaiting=()=>{}}={}) {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    abortIfNeeded(signal);
    const state=await bridge.call('capture',item);
    abortIfNeeded(signal);
    if(state?.status==='ready'&&state.candidates?.length)return state;
    onWaiting(state?.reason||'等待播放器載入…');
    await delay(700,signal);
  }
  throw new Error('等待播放器逾時。請在課程分頁確認這堂可正常播放；若瀏覽器阻擋自動播放，播放幾秒後暫停，再重試此堂。');
}

export async function readSelectedMedia(capture,quality,options) {
  const candidate=capture.candidates[0];
  let media=await loadPlaylist(candidate.url,{...options,phase:'master'});
  let qualityLabel='播放器串流';
  if(media.type==='master'){
    const variant=chooseVariant(media.variants,quality);
    if(!variant)throw new Error('沒有可用的影片畫質。');
    qualityLabel=variant.label;
    media=await loadPlaylist(variant.url,{...options,phase:'variant'});
  }
  if(media.type!=='media')throw new Error('此課程使用巢狀串流清單，暫不支援。');
  return {media,qualityLabel};
}

// Only a missing or empty file may be written. Existing nonempty files are
// explicitly reported as skipped, not assumed to be complete or valid media.
export async function outputTarget(root,item,courseTitle,{signal}={}) {
  const path=lectureDownloadPath(item,{courseTitle});
  const parts=path.split('/');
  let directory=root;
  for(const part of parts.slice(0,-1)){abortIfNeeded(signal);directory=await directory.getDirectoryHandle(part,{create:true});}
  abortIfNeeded(signal);
  const name=parts.at(-1);
  let handle;
  try{handle=await directory.getFileHandle(name);}
  catch(error){if(error.name!=='NotFoundError')throw error;}
  if(handle&&(await handle.getFile()).size>0)return {exists:true,path};
  return {exists:false,path,handle,directory,name};
}

export async function writeLecture(target,media,options) {
  abortIfNeeded(options.signal);
  // Check again immediately before opening a writable stream, including files
  // created by the user since the earlier existence check.
  let handle=target.handle;
  if(!handle){try{handle=await target.directory.getFileHandle(target.name);}catch(error){if(error.name!=='NotFoundError')throw error;}}
  if(handle&&(await handle.getFile()).size>0)return {status:'skipped',reason:'已有同名檔案（未驗證）',path:target.path};
  if(!handle)handle=await target.directory.getFileHandle(target.name,{create:true});
  abortIfNeeded(options.signal);
  const writable=await handle.createWritable();
  const result=await saveMedia(media,writable,options);
  return {status:'completed',path:target.path,...result};
}

export async function withBatchLock(locks,tabId,courseKey,action) {
  if(!locks?.request)throw new Error('瀏覽器缺少批次鎖定功能，請更新桌面版 Chrome。');
  const claim=(name,next)=>locks.request(name,{ifAvailable:true},lock=>{
    if(!lock)throw new Error('這個課程或分頁已有另一個備份工作執行中，請先停止另一個工作。');
    return next();
  });
  return claim(`udemy-tab-${tabId}`,()=>claim(`udemy-course-${courseKey}`,action));
}
