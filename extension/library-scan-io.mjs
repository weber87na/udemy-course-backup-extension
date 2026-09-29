import {normalizeCourse,sanitizeRecord} from './library-core.mjs';
import {abortIfNeeded,delay,pageBridge} from './batch-io.mjs';
import {probeHls} from './library-probe.mjs';
import {readResource} from './transfer.mjs';

function atCourse(tab,courseKey,lectureId) {
  const course=normalizeCourse(tab?.url);
  if(!course||course.courseKey!==courseKey||tab.discarded||tab.frozen)return false;
  return !lectureId||new URL(tab.url).pathname.replace(/\/$/,'')===new URL(`${courseKey}/learn/lecture/${lectureId}`).pathname;
}

export function createInspector(api,{signal,timeoutMs=30000,now=Date.now,sleep=delay,parseXml=text=>new DOMParser().parseFromString(text,'application/xml'),probe=probeHls,read=readResource,openTab=options=>api.tabs.create(options)}={}) {
  let ownedTabId=null,expected=null,generation=0;
  async function close() {
    generation++;
    const id=ownedTabId;ownedTabId=null;expected=null;
    if(id!==null)try{await api.tabs.remove(id);}catch{/* already closed */}
  }
  async function get() {
    abortIfNeeded(signal);
    if(ownedTabId===null)throw new Error('檢查分頁已關閉。');
    const tab=await api.tabs.get(ownedTabId);
    if(expected&&!atCourse(tab,expected.courseKey,expected.lectureId))throw new Error('檢查分頁已切換或尚未載入，請保持工具建立的分頁不變。');
    return tab;
  }
  async function open(course,lectureId) {
    abortIfNeeded(signal);
    // Each lecture gets a fresh document and performance timeline, preventing
    // a previous lecture's DASH manifest from being mistaken for this one.
    await close();
    abortIfNeeded(signal);
    const requested=normalizeCourse(course.courseKey);
    if(!requested)throw new Error('課程網址無效。');
    const url=lectureId?`${course.courseKey}/learn/lecture/${lectureId}`:requested.url;
    const token=generation;
    const tab=await openTab({url,active:false});
    if(token!==generation||signal?.aborted){await api.tabs.remove(tab.id).catch(()=>{});abortIfNeeded(signal);throw new Error('檢查已停止。');}
    ownedTabId=tab.id;expected=null;
    const end=now()+timeoutMs;
    while(now()<end){
      abortIfNeeded(signal);
      const current=await api.tabs.get(ownedTabId);
      const resolved=normalizeCourse(current.url);
      const allowedRedirect=requested.courseId&&resolved&&!resolved.courseId&&new URL(resolved.courseKey).origin===new URL(requested.url).origin&&/\/learn(?:\/|$)/.test(new URL(current.url).pathname);
      if((requested.courseId?allowedRedirect:atCourse(current,course.courseKey,lectureId))&&current.status==='complete'){
        expected={courseKey:resolved.courseKey,lectureId};
        if(requested.courseId){
          const courseId=await script(()=>{
            const nodes=document.querySelectorAll('[data-module-id="course-taking"][data-module-args]');
            if(nodes.length!==1)return null;
            try{
              const id=JSON.parse(nodes[0].getAttribute('data-module-args')).courseId;
              return (typeof id==='string'||Number.isSafeInteger(id))&&/^[1-9]\d{0,19}$/.test(String(id))?String(id):null;
            }catch{return null;}
          });
          if(courseId!==requested.courseId)throw new Error('課程 ID 與卡片不一致，無法確認這門課的來源。');
        }
        return ownedTabId;
      }
      // The own tab may briefly be about:blank while navigation is pending.
      if(current.status==='complete'&&current.url&&current.url!=='about:blank'&&!atCourse(current,course.courseKey,lectureId))throw new Error('課程需要登入或無法開啟，請先在 Udemy 確認存取。');
      await sleep(300,signal);
    }
    throw new Error('等待課程頁逾時。');
  }
  async function script(func,args=[]) {
    await get();
    const response=await api.scripting.executeScript({target:{tabId:ownedTabId},func,args});
    await get();
    return response?.[0]?.result;
  }
  async function collect(course) {
    const id=await open(course);
    const actualKey=expected.courseKey;
    const bridge=pageBridge(api,id,actualKey);
    const end=now()+timeoutMs;
    while(now()<end){
      const ready=await script(()=>{for(const video of document.querySelectorAll('video'))video.pause();return Boolean(document.getElementById('ct-sidebar-scroll-container')?.querySelector('[data-purpose^="section-panel-"]'));});
      if(ready)break;
      await sleep(400,signal);
    }
    abortIfNeeded(signal);
    await bridge.attach();
    let timer;
    const cancel=()=>{void bridge.call('cancel').catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      const result=await Promise.race([bridge.call('collect',`${actualKey}/learn/`),new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(new Error('目錄檢查逾時。'));},60000);})]);
      abortIfNeeded(signal);await get();
      if(result?.courseKey!==actualKey||!Array.isArray(result.sections))throw new Error('課程目錄不一致。');
      const items=result.sections.flatMap(section=>section.items);
      const seen=new Set();
      for(const item of items){
        if(!item||item.courseKey!==actualKey||!/^\d+$/.test(item.lectureId)||seen.has(item.lectureId))throw new Error('課程目錄不完整。');
        seen.add(item.lectureId);
      }
      if(items.length>2000)throw new Error('課程目錄超過檢查上限。');
      return {...result,items};
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);await bridge.call('cancel').catch(()=>{});await close();}
  }
  async function inspect(course,item) {
    try {
      await open(course,item.lectureId);
      await api.scripting.executeScript({target:{tabId:ownedTabId},files:['library-player.js']});
      const end=now()+timeoutMs;
      while(now()<end){
        abortIfNeeded(signal);
        const capture=await script((item)=>globalThis.UdemyLibraryPlayer.inspect(item,{play:true}),[item]);
        if(capture?.status==='ready'){
          if(capture.lectureId!==item.lectureId||!/^\d+$/.test(capture.assetId)||!Array.isArray(capture.candidates)||!capture.candidates.length||capture.candidates.length>12||!atCourse({url:capture.pageUrl},course.courseKey,item.lectureId))return {status:'unknown',reason:'source-unconfirmed'};
          const options={signal,permissionCheck:origin=>api.permissions.contains({origins:[origin]})};
          if(capture.kind==='hls'){
            if(capture.candidates.some(candidate=>{try{const u=new URL(candidate.url);return u.origin!==new URL(course.courseKey).origin||!u.pathname.startsWith(`/assets/${capture.assetId}/`)||!u.pathname.endsWith('.m3u8');}catch{return true;}}))return {status:'unknown',reason:'source-unconfirmed'};
            return await probe(capture,options);
          }
          if(capture.kind==='dash'&&capture.candidates.length===1){
            let url;
            try{url=new URL(capture.candidates[0].url);}catch{return {status:'unknown',reason:'source-unconfirmed'};}
            if(url.protocol!=='https:'||url.username||url.password||url.port||!/(^|\.)udemycdn\.com$/i.test(url.hostname)||!/\.mpd$/i.test(url.pathname))return {status:'unknown',reason:'source-unconfirmed'};
            const bytes=await read(capture.candidates[0].url,{...options,maxBytes:2*1024*1024,timeoutMs:15000});
            const xml=parseXml(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
            if(xml.documentElement?.localName!=='MPD'||xml.documentElement.namespaceURI!=='urn:mpeg:dash:schema:mpd:2011'||xml.querySelector('parsererror'))return {status:'unknown',reason:'source-unconfirmed'};
            const protection=xml.getElementsByTagNameNS('*','ContentProtection');
            const protectedSource=Array.from(protection).some(element=>Boolean(element.getAttribute('schemeIdUri')));
            return {status:'unsupported',reason:protectedSource?'dash-drm':'dash'};
          }
          return {status:'unknown',reason:'source-unconfirmed'};
        }
        await sleep(500,signal);
      }
      return {status:'unknown',reason:'timeout'};
    } catch(error) {
      abortIfNeeded(signal);
      return {status:'unknown',reason:'source-unconfirmed'};
    } finally {
      if(ownedTabId!==null)await script(()=>globalThis.UdemyLibraryPlayer?.pause()).catch(()=>{});
      await close();
    }
  }
  return {collect,inspect,close};
}

export async function checkCourse(course,mode,{inspector,signal,onRecord=async()=>{},now=Date.now,withCourseLock=(_key,action)=>action()}={}) {
  const record={version:1,courseKey:course.courseKey,title:course.title,totalVideos:null,catalogComplete:false,checkedAt:now(),finished:false,mode,results:[]};
  const save=async()=>{record.checkedAt=now();const safe=sanitizeRecord(record);if(!safe)throw new Error('檢查紀錄格式無效。');await onRecord(safe);};
  try {
    abortIfNeeded(signal);
    const catalog=await inspector.collect(course);
    const videos=catalog.items.filter(item=>item.kind==='video');
    record.title=catalog.courseTitle||record.title;record.totalVideos=videos.length;
    record.catalogComplete=catalog.complete===true&&!catalog.items.some(item=>item.kind==='unknown');
    await save();
    const resolved=normalizeCourse(catalog.courseKey);
    if(!resolved||resolved.courseId)throw new Error('尚未確認課程播放頁。');
    await withCourseLock(resolved.courseKey,async()=>{
      for(const item of (mode==='sample'?videos.slice(0,1):videos)){
        abortIfNeeded(signal);
        const result=await inspector.inspect(resolved,item);
        abortIfNeeded(signal);
        record.results.push({lectureId:item.lectureId,title:item.title,...result});await save();
      }
    });
    record.finished=true;await save();
  } catch(error) {
    await save();
    if(signal?.aborted)throw new DOMException('已停止。','AbortError');
    throw error;
  } finally {await inspector.close();}
  return sanitizeRecord(record);
}
