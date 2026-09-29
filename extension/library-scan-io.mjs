import {normalizeCourse,sanitizeRecord,diagnosticCode,reasonLabel} from './library-core.mjs';
import {abortIfNeeded,delay,pageBridge} from './batch-io.mjs';
import {probeHls} from './library-probe.mjs';
import {readResource} from './transfer.mjs';

function diagnosticError(code) {
  const error=new Error(reasonLabel(code));
  error.code=diagnosticCode(code);
  return error;
}

function typedError(error,fallback) {
  if(error?.name==='AbortError')return error;
  return diagnosticError(diagnosticCode(error?.code,fallback));
}

function atCourse(tab,courseKey,lectureId) {
  const course=normalizeCourse(tab?.url);
  if(!course||course.courseKey!==courseKey||tab.discarded||tab.frozen)return false;
  return !lectureId||new URL(tab.url).pathname.replace(/\/$/,'')===new URL(`${courseKey}/learn/lecture/${lectureId}`).pathname;
}

export function createInspector(api,{signal,timeoutMs=30000,now=Date.now,sleep=delay,parseXml=text=>new DOMParser().parseFromString(text,'application/xml'),probe=probeHls,read=readResource,openTab=options=>api.tabs.create(options)}={}) {
  let ownedTabId=null,expected=null,generation=0,foreground=null,closing=Promise.resolve();
  function requireOwned(id,token) {
    abortIfNeeded(signal);
    if(id===null||ownedTabId!==id||generation!==token)throw diagnosticError('source-page-changed');
  }
  function restoreForeground(entry=foreground) {
    if(!entry)return Promise.resolve();
    if(entry.restoring)return entry.restoring;
    entry.restoring=(async()=>{
      // A cancellation can arrive while activation is in flight. Restore only
      // after that request settles, so a late activation cannot steal focus.
      await entry.activation.catch(()=>{});
      if(!entry.requested)return;
      try {
        const worker=await api.tabs.get(entry.id);
        if(!worker.active||worker.windowId!==entry.windowId)return;
        const previous=await api.tabs.get(entry.previousId);
        if(previous.windowId!==entry.windowId)return;
        const active=await api.tabs.query({active:true,windowId:entry.windowId});
        if(active.length!==1||active[0].id!==entry.id)return;
        await api.tabs.update(entry.previousId,{active:true});
      } catch {/* Closing a tab or a user switch must not trigger more focus changes. */}
    })();
    return entry.restoring;
  }
  async function close() {
    generation++;
    const id=ownedTabId,entry=foreground,prior=closing;
    ownedTabId=null;expected=null;foreground=null;
    const task=(async()=>{
      await prior;
      await restoreForeground(entry);
      if(id!==null)try{await api.tabs.remove(id);}catch{/* already closed */}
    })();
    closing=task.catch(()=>{});
    await task;
  }
  async function get() {
    const id=ownedTabId,token=generation;
    requireOwned(id,token);
    let tab;
    try{tab=await api.tabs.get(id);}catch(error){throw typedError(error,'source-page-changed');}
    requireOwned(id,token);
    if(expected&&!atCourse(tab,expected.courseKey,expected.lectureId))throw diagnosticError('source-page-changed');
    return tab;
  }
  async function activateForeground() {
    const id=ownedTabId,token=generation;
    const worker=await get();
    requireOwned(id,token);
    if(worker.active||!Number.isInteger(worker.windowId))return;
    let active;
    try{active=await api.tabs.query({active:true,windowId:worker.windowId});}
    catch(error){throw typedError(error,'player-loading');}
    requireOwned(id,token);
    const checked=await get();
    requireOwned(id,token);
    if(checked.windowId!==worker.windowId||checked.active)return;
    if(active.length!==1||!Number.isInteger(active[0].id)||active[0].id===id||active[0].windowId!==worker.windowId)return;
    const latestActive=await api.tabs.query({active:true,windowId:worker.windowId});
    requireOwned(id,token);
    if(latestActive.length!==1||latestActive[0].id!==active[0].id)return;
    const entry={id,windowId:worker.windowId,previousId:active[0].id,activation:null,restoring:null,requested:false};
    foreground=entry;
    entry.activation=Promise.resolve().then(()=>{
      requireOwned(id,token);
      entry.requested=true;
      return api.tabs.update(id,{active:true});
    });
    try {
      await entry.activation;
      requireOwned(id,token);
      await get();
      requireOwned(id,token);
    } catch(error) {
      await restoreForeground(entry);
      throw typedError(error,'player-loading');
    }
  }
  async function open(course,lectureId) {
    abortIfNeeded(signal);
    // Each lecture gets a fresh document and performance timeline, preventing
    // a previous lecture's DASH manifest from being mistaken for this one.
    await close();
    abortIfNeeded(signal);
    const requested=normalizeCourse(course.courseKey);
    if(!requested)throw diagnosticError('course-unavailable');
    const url=lectureId?`${course.courseKey}/learn/lecture/${lectureId}`:requested.url;
    const token=generation;
    let tab;
    try{tab=await openTab({url,active:false});}catch(error){throw typedError(error,'worker-open-failed');}
    if(!Number.isInteger(tab?.id))throw diagnosticError('worker-open-failed');
    if(token!==generation||signal?.aborted){await api.tabs.remove(tab.id).catch(()=>{});abortIfNeeded(signal);throw diagnosticError('cancelled');}
    ownedTabId=tab.id;expected=null;
    const end=now()+timeoutMs;
    while(now()<end){
      abortIfNeeded(signal);
      let current;
      try{current=await api.tabs.get(ownedTabId);}catch(error){throw typedError(error,'source-page-changed');}
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
          if(courseId===null||courseId===undefined)throw diagnosticError('course-identity-unconfirmed');
          if(courseId!==requested.courseId)throw diagnosticError('course-identity-mismatch');
        }
        return ownedTabId;
      }
      // The own tab may briefly be about:blank while navigation is pending.
      if(current.status==='complete'&&current.url&&current.url!=='about:blank'&&!atCourse(current,course.courseKey,lectureId))throw diagnosticError('course-unavailable');
      await sleep(300,signal);
    }
    throw diagnosticError('course-load-timeout');
  }
  async function script(func,args=[]) {
    await get();
    let response;
    try{response=await api.scripting.executeScript({target:{tabId:ownedTabId},func,args});}
    catch(error){throw typedError(error,'page-script-failed');}
    await get();
    if(!response?.length||!Object.hasOwn(response[0],'result'))throw diagnosticError('page-script-failed');
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
    try{await bridge.attach();}catch(error){throw typedError(error,'page-script-failed');}
    let timer;
    const cancel=()=>{void bridge.call('cancel').catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      const result=await Promise.race([bridge.call('collect',`${actualKey}/learn/`),new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(diagnosticError('catalog-timeout'));},60000);})]);
      abortIfNeeded(signal);await get();
      if(result?.courseKey!==actualKey||!Array.isArray(result.sections))throw diagnosticError('catalog-invalid');
      const items=result.sections.flatMap(section=>section.items);
      const seen=new Set();
      for(const item of items){
        if(!item||item.courseKey!==actualKey||!/^\d+$/.test(item.lectureId)||seen.has(item.lectureId))throw diagnosticError('catalog-invalid');
        seen.add(item.lectureId);
      }
      if(items.length>2000)throw diagnosticError('catalog-invalid');
      return {...result,items};
    } catch(error) {throw typedError(error,'catalog-unavailable');
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);await bridge.call('cancel').catch(()=>{});await close();}
  }
  async function inspect(course,item) {
    let phase='worker-open-failed';
    try {
      await open(course,item.lectureId);
      phase='page-script-failed';
      await api.scripting.executeScript({target:{tabId:ownedTabId},files:['library-player.js']});
      const end=now()+timeoutMs;
      let pendingCode='timeout',foregroundSince=null,foregroundAttempted=false,lastNeedsForeground=false;
      while(now()<end){
        abortIfNeeded(signal);
        phase='page-script-failed';
        const capture=await script((item)=>{
          try{return globalThis.UdemyLibraryPlayer.inspect(item,{play:true});}
          catch(error){return {status:'error',code:typeof error?.code==='string'?error.code:null};}
        },[item]);
        if(capture?.status==='error')throw diagnosticError(diagnosticCode(capture.code,'source-unconfirmed'));
        phase='source-unconfirmed';
        if(capture?.status==='pending')pendingCode=diagnosticCode(capture.reasonCode,'timeout');
        lastNeedsForeground=capture?.status==='pending'&&capture.reasonCode==='player-loading'&&capture.needsForeground===true;
        if(lastNeedsForeground){
          foregroundSince??=now();
          if(!foregroundAttempted&&now()-foregroundSince>=1500){
            foregroundAttempted=true;
            await activateForeground();
          }
        }else foregroundSince=null;
        if(capture?.status==='ready'){
          if(capture.lectureId!==item.lectureId||!/^\d+$/.test(capture.assetId)||!Array.isArray(capture.candidates)||!capture.candidates.length||capture.candidates.length>12||!atCourse({url:capture.pageUrl},course.courseKey,item.lectureId))return {status:'unknown',reason:'source-unconfirmed'};
          await restoreForeground();
          await get();
          const options={signal,permissionCheck:origin=>api.permissions.contains({origins:[origin]})};
          if(capture.kind==='hls'){
            if(capture.candidates.some(candidate=>{try{const u=new URL(candidate.url);return u.origin!==new URL(course.courseKey).origin||!u.pathname.startsWith(`/assets/${capture.assetId}/`)||!u.pathname.endsWith('.m3u8');}catch{return true;}}))return {status:'unknown',reason:'source-unconfirmed'};
            phase='network';
            return await probe(capture,options);
          }
          if(capture.kind==='dash'&&capture.candidates.length===1){
            let url;
            try{url=new URL(capture.candidates[0].url);}catch{return {status:'unknown',reason:'source-unconfirmed'};}
            if(url.protocol!=='https:'||url.username||url.password||url.port||!/(^|\.)udemycdn\.com$/i.test(url.hostname)||!/\.mpd$/i.test(url.pathname))return {status:'unknown',reason:'source-unconfirmed'};
            phase='network';
            const bytes=await read(capture.candidates[0].url,{...options,maxBytes:2*1024*1024,timeoutMs:15000});
            phase='dash-invalid';
            const xml=parseXml(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
            if(xml.documentElement?.localName!=='MPD'||xml.documentElement.namespaceURI!=='urn:mpeg:dash:schema:mpd:2011'||xml.querySelector('parsererror'))return {status:'unknown',reason:'dash-invalid'};
            const protection=xml.getElementsByTagNameNS('*','ContentProtection');
            const protectedSource=Array.from(protection).some(element=>Boolean(element.getAttribute('schemeIdUri')));
            return {status:'unsupported',reason:protectedSource?'dash-drm':'dash'};
          }
          return {status:'unknown',reason:'source-unconfirmed'};
        }
        await sleep(500,signal);
      }
      return {status:'unknown',reason:foregroundAttempted&&lastNeedsForeground?'player-background':pendingCode};
    } catch(error) {
      abortIfNeeded(signal);
      return {status:'unknown',reason:diagnosticCode(error?.code,phase)};
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
  let phase='catalog-unavailable';
  try {
    abortIfNeeded(signal);
    const catalog=await inspector.collect(course);
    const videos=catalog.items.filter(item=>item.kind==='video');
    record.title=catalog.courseTitle||record.title;record.totalVideos=videos.length;
    record.catalogComplete=catalog.complete===true&&!catalog.items.some(item=>item.kind==='unknown');
    await save();
    const resolved=normalizeCourse(catalog.courseKey);
    if(!resolved||resolved.courseId)throw diagnosticError('course-identity-unconfirmed');
    phase='lock-unavailable';
    await withCourseLock(resolved.courseKey,async()=>{
      phase='source-unconfirmed';
      for(const item of (mode==='sample'?videos.slice(0,1):videos)){
        abortIfNeeded(signal);
        const result=await inspector.inspect(resolved,item);
        abortIfNeeded(signal);
        record.results.push({lectureId:item.lectureId,title:item.title,...result});await save();
      }
    });
    record.finished=true;await save();
  } catch(error) {
    record.issue=signal?.aborted?'cancelled':diagnosticCode(error?.code,phase);
    await save();
    if(signal?.aborted)throw new DOMException('已停止。','AbortError');
    throw typedError(error,phase);
  } finally {await inspector.close();}
  return sanitizeRecord(record);
}
