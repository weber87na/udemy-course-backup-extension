import {runQueue,safeQueueSnapshot} from './batch-core.mjs';
import {courseIdentity,pageBridge,abortIfNeeded,waitForStream,readSelectedMedia,outputTarget,writeLecture,withBatchLock} from './batch-io.mjs';

const $=id=>document.getElementById(id);
const origins=['https://*.udemy.com/*','https://*.udemycdn.com/*'];
const version=chrome.runtime.getManifest().version;
const labels={queued:'待下載',running:'下載中',completed:'已完成',failed:'失敗',skipped:'已略過'};
let job,identity,bridge,catalog,items=[],folder,controller,busy=false,loading=false,fatalReason='';
const rows=new Map(),sectionChecks=new Map();
let diagnostic={version,events:[]},lastFailureDiagnostic=null;
$('version').textContent=`v${version}`;

function safeError(error) {
  return String(error?.message||'操作失敗，請重試。').replace(/https?:\/\/[^\s）)]+/gi,'[網址已隱藏]').slice(0,800);
}
function errorText(text=''){$('error').hidden=!text;$('error').textContent=text;}
function diagnosticEvent(event){diagnostic.events.push(event);diagnostic.events=diagnostic.events.slice(-12);}
function networkOptions(signal){return {signal,permissionCheck:origin=>chrome.permissions.contains({origins:[origin]}),onDiagnostic:diagnosticEvent};}
function selectedItems(){return items.filter(item=>item.kind==='video'&&item.selected);}
function update() {
  const selected=selectedItems(),finished=selected.filter(item=>['completed','skipped'].includes(item.status)).length;
  $('load').disabled=busy||!job;
  $('source').disabled=!job;
  $('folder').disabled=busy||!catalog?.complete;
  $('quality').disabled=busy;
  $('start').disabled=busy||!folder||!catalog?.complete||!selected.some(item=>!['completed','skipped'].includes(item.status));
  $('stop').disabled=!busy||loading||!controller||controller.signal.aborted;
  $('report').disabled=!items.length;
  for(const id of ['all','none','remaining'])$(id).disabled=busy;
  $('selection').textContent=`已選 ${selected.length} 堂影片`;
  $('overall-progress').max=selected.length||1;$('overall-progress').value=finished;
  const count=status=>selected.filter(item=>item.status===status).length;
  $('overall').textContent=`${selected.length} 堂所選影片 · 完成 ${count('completed')} · 略過 ${count('skipped')} · 失敗 ${count('failed')} · 未完成 ${selected.length-finished-count('failed')}`;
  for(const item of items){
    const row=rows.get(item.key);if(!row)continue;
    row.input.checked=Boolean(item.selected);row.input.disabled=busy||item.kind!=='video';
    row.badge.textContent=item.kind==='video'?(labels[item.status]||'待下載'):(item.kind==='article'?'教材／文章':'非影片或未辨識');
    row.badge.className=`badge ${item.status||''}`;
    row.detail.textContent=item.error||item.note||'';
  }
  for(const [index,input] of sectionChecks){
    const members=items.filter(item=>item.sectionIndex===index&&item.kind==='video');
    input.checked=members.length>0&&members.every(item=>item.selected);input.indeterminate=members.some(item=>item.selected)&&!input.checked;
    input.disabled=busy||!members.length;
  }
}
function renderCatalog() {
  rows.clear();sectionChecks.clear();$('sections').replaceChildren();
  for(const section of catalog.sections){
    const details=document.createElement('details');details.className='course-section';details.open=section.sectionIndex===1;
    const summary=document.createElement('summary');summary.textContent=`${section.title} · ${section.items.length} 項`;
    const label=document.createElement('label');label.className='section-select';
    const select=document.createElement('input');select.type='checkbox';
    select.addEventListener('change',()=>{if(busy)return;for(const item of items)if(item.sectionIndex===section.sectionIndex&&item.kind==='video')item.selected=select.checked;update();});
    label.append(select,document.createTextNode('選取本章影片'));sectionChecks.set(section.sectionIndex,select);
    const list=document.createElement('ul');list.className='lecture-list';
    for(const entry of section.items){
      const item=items.find(item=>item.key===entry.key);
      const row=document.createElement('li');row.className='lecture';
      const input=document.createElement('input');input.type='checkbox';input.id=`lecture-${item.lectureId}`;
      const title=document.createElement('label');title.htmlFor=input.id;title.textContent=item.title;
      const detail=document.createElement('span');detail.className='detail';title.append(detail);
      const badge=document.createElement('span');badge.className='badge';
      input.addEventListener('change',()=>{if(!busy){item.selected=input.checked;update();}});
      row.append(input,title,badge);list.append(row);rows.set(item.key,{input,badge,detail});
    }
    details.append(summary,label,list);$('sections').append(details);
  }
  $('download-card').hidden=false;$('catalog-card').hidden=false;update();
}

function snapshot(){return {version,course:job?.courseTitle,courseKey:identity?.key,at:new Date().toISOString(),items:safeQueueSnapshot(items)};}
let persistChain=Promise.resolve();
function persist(){
  const report=snapshot();
  persistChain=persistChain.then(async()=>{
    const saved=await chrome.storage.local.get('batchReports');
    const reports=Array.isArray(saved.batchReports)?saved.batchReports:[];
    await chrome.storage.local.set({batchReports:[report,...reports.filter(old=>old.courseKey!==report.courseKey)].slice(0,5)});
  }).catch(()=>{$('catalog-status').textContent='進度仍顯示在本頁，但無法儲存本機紀錄；可按「匯出進度紀錄」。';});
}

$('load').addEventListener('click',()=>{
  if(busy||!job)return;
  const permission=chrome.permissions.request({origins});
  busy=true;loading=true;errorText();update();
  if(catalog)catalog.complete=false;
  $('catalog-status').textContent='正在展開章節並讀取目錄，請稍候…';
  withBatchLock(navigator.locks,job.tabId,identity.key,async()=>{
    if(!await permission)throw new Error('需要 Udemy 與 Udemy CDN 讀取權限才能載入並備份。');
    await bridge.attach();
    const result=await bridge.call('collect',job.pageUrl);
    if(result.courseKey!==identity.key||!Array.isArray(result.sections))throw new Error('課程目錄不符，請回課程重新開啟工具。');
    const previous=new Map(items.map(item=>[item.key,item]));
    catalog=result;
    items=result.sections.flatMap(section=>section.items.map(entry=>{
      const old=previous.get(entry.key);
      return {...entry,selected:entry.kind==='video'&&(old?.selected??true),status:old?.status==='running'?'queued':old?.status||'queued',error:old?.error,note:old?.note};
    }));
    job.courseTitle=result.courseTitle||job.courseTitle;$('course').textContent=job.courseTitle;
    renderCatalog();
    const videos=items.filter(item=>item.kind==='video').length;
    $('catalog-status').textContent=`已讀取 ${catalog.sections.length} 個章節、${items.length} 個項目（${videos} 堂影片）。${catalog.complete?'目錄數量核對完成。':'目錄尚未完整，請回課程確認所有章節可展開，再重新載入；目前不會開始下載。'} ${(catalog.notes||[]).join(' ')}`;
    persist();
  }).catch(error=>{errorText(safeError(error));$('catalog-status').textContent='目錄載入未完成。';}).finally(()=>{busy=false;loading=false;update();});
});

$('folder').addEventListener('click',()=>{
  if(busy)return;errorText();
  if(typeof window.showDirectoryPicker!=='function'){errorText('請使用支援資料夾儲存的桌面版 Chrome。');return;}
  let picker;
  try{picker=window.showDirectoryPicker({id:'udemy-course-backup',mode:'readwrite'});}
  catch(error){if(error.name!=='AbortError')errorText(safeError(error));return;}
  busy=true;update();
  picker.then(handle=>{
    const changed=folder&&folder!==handle;
    folder=handle;
    // A different folder is a new output target; never silently omit completed
    // items from a previous target. Existence checks still prevent overwrites.
    if(changed)for(const item of items){if(['completed','skipped'].includes(item.status)){item.status='queued';item.note='';}}
    $('folder-name').textContent=`儲存到：${folder.name} ／ ${job.courseTitle} ／ 各章節`;
  }).catch(error=>{if(error.name!=='AbortError')errorText(safeError(error));}).finally(()=>{busy=false;update();});
});

async function processItem(item,{signal}) {
  diagnostic={version,lectureId:item.lectureId,events:[]};
  item.error='';item.note='';
  $('lecture-progress').value=0;$('current').textContent=`${item.title}：準備儲存…`;
  const title=`${job.courseTitle} [${identity.slug}]`;
  const target=await outputTarget(folder,item,title,{signal});
  if(target.exists){item.note='已有同名檔案（未驗證）';return {status:'skipped'};}
  try{
    await bridge.call('activate',item);
  }catch(error){if(!signal.aborted)fatalReason=safeError(error);throw error;}
  if(signal.aborted){await bridge.call('cancel').catch(()=>{});abortIfNeeded(signal);}
  let capture;
  try{
    capture=await waitForStream(bridge,item,{signal,onWaiting:reason=>{$('current').textContent=`${item.title}：${reason}`;}});
  }catch(error){
    // Page-level loss must stop the queue; media-specific failures can be
    // recorded while subsequent lectures continue.
    if(/分頁|其他課程|重新載入目錄|手動|頁面已|播放器逾時/.test(error.message||''))fatalReason=safeError(error);
    throw error;
  }
  abortIfNeeded(signal);
  $('current').textContent=`${item.title}：檢查影片格式與畫質…`;
  const {media,qualityLabel}=await readSelectedMedia(capture,$('quality').value,networkOptions(signal));
  abortIfNeeded(signal);
  $('lecture-progress').max=media.segments.length;
  item.note=qualityLabel;update();
  const result=await writeLecture(target,media,{...networkOptions(signal),onProgress:progress=>{
    $('lecture-progress').value=progress.completed;
    $('current').textContent=`${item.title} · ${qualityLabel} · ${progress.completed} / ${progress.total} 片段 · ${(progress.bytes/1048576).toFixed(1)} MB`;
  }});
  item.note=result.status==='skipped'?result.reason:`${qualityLabel} · ${(result.bytes/1048576).toFixed(1)} MB`;
  return result;
}

$('start').addEventListener('click',async()=>{
  if(busy||!folder||!catalog?.complete)return;
  errorText();busy=true;controller=new AbortController();fatalReason='';lastFailureDiagnostic=null;$('diagnostics').hidden=true;update();
  let cancelTask=Promise.resolve();
  controller.signal.addEventListener('abort',()=>{cancelTask=bridge.call('cancel').catch(()=>{});},{once:true});
  try{
    if(await folder.queryPermission({mode:'readwrite'})!=='granted')throw new Error('資料夾寫入權限已失效，請重新按「選擇儲存資料夾」。');
    await withBatchLock(navigator.locks,job.tabId,identity.key,()=>runQueue(items.filter(item=>item.kind==='video'),{signal:controller.signal,processItem,onUpdate:({item})=>{
      if(item?.status==='failed'){
        item.error=safeError({message:item.error});
        lastFailureDiagnostic={...diagnostic,events:[...diagnostic.events]};
        $('diagnostic-text').textContent=JSON.stringify(lastFailureDiagnostic,null,2);$('diagnostics').hidden=false;
        if(fatalReason)controller.abort();
      }
      update();persist();
    }}));
    const failed=selectedItems().filter(item=>item.status==='failed').length;
    $('current').textContent=fatalReason?'來源分頁需要處理，整批已停止。':controller.signal.aborted?'已停止。未完成的單堂可從頭重試。':failed?`本次處理結束，${failed} 堂失敗。按「選取未完成」後可重試。`:'本次所選項目已處理完畢；完成及略過數量請看上方。';
    if(fatalReason)errorText(fatalReason);
  }catch(error){errorText(safeError(error));$('current').textContent='批次未完成。';}
  finally{await cancelTask;busy=false;controller=null;update();persist();}
});
$('stop').addEventListener('click',()=>{controller?.abort();$('current').textContent='正在停止並關閉檔案寫入…';update();});
for(const [id,predicate] of [['all',()=>true],['none',()=>false],['remaining',item=>!['completed','skipped'].includes(item.status)]])$(id).addEventListener('click',()=>{if(busy)return;for(const item of items)item.selected=item.kind==='video'&&predicate(item);update();});
$('source').addEventListener('click',async()=>{try{await chrome.tabs.update(job.tabId,{active:true});}catch{errorText('原課程分頁已關閉。請從課程重新開啟工具。');}});
$('report').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot(),null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`udemy-course-progress-${Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
});
$('copy-diagnostic').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(JSON.stringify(lastFailureDiagnostic||diagnostic,null,2));$('copy-diagnostic').textContent='已複製';}catch{errorText('無法自動複製，請選取診斷文字後複製。');}});
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='connect-src'){try{diagnostic.cspBlockedHost=new URL(event.blockedURI).hostname;}catch{/* no raw URI */}}});
function sourceUnavailable(message){if(busy&&controller){fatalReason=message;controller.abort();errorText(message);update();}}
chrome.tabs.onRemoved?.addListener(tabId=>{if(tabId===job?.tabId)sourceUnavailable('原課程分頁已關閉，整批下載已停止。');});
chrome.tabs.onReplaced?.addListener((_addedTabId,removedTabId)=>{if(removedTabId===job?.tabId)sourceUnavailable('Chrome 已替換原課程分頁，請從課程重新開啟工具。');});
chrome.tabs.onUpdated?.addListener((tabId,change)=>{
  if(tabId!==job?.tabId)return;
  if(change.discarded||change.frozen)sourceUnavailable('原課程分頁已被 Chrome 暫停，請喚醒後重試。');
  if(change.url){try{if(courseIdentity(change.url).key!==identity?.key)sourceUnavailable('原分頁已離開這門課程，整批下載已停止。');}catch{sourceUnavailable('原分頁已離開課程播放器，整批下載已停止。');}}
});

(async()=>{
  try{
    const key=new URL(location.href).searchParams.get('job');
    if(!/^course-[a-f0-9-]{36}$/.test(key||''))throw new Error('請從課程頁的擴充功能按「載入整門課目錄」。');
    const saved=await chrome.storage.session.get(key);job=saved[key];await chrome.storage.session.remove(key);
    if(!job||!Number.isInteger(job.tabId)||Date.now()-job.createdAt>600000)throw new Error('工作已失效，請從課程頁重新開啟。');
    identity=courseIdentity(job.pageUrl);bridge=pageBridge(chrome,job.tabId,identity.key);
    $('course').textContent=job.courseTitle||identity.slug;
  }catch(error){job=null;$('course').textContent='尚未取得課程資訊';errorText(safeError(error));}
  update();
})();
