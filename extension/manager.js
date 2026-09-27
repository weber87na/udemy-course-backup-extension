import {checkedUrl,loadPlaylist,saveMedia,safeFilename} from './transfer.mjs';
const $=id=>document.getElementById(id);
const origins=['https://*.udemy.com/*','https://*.udemycdn.com/*'];
let job,media,mediaUrl,controller,busy=false;
const version=chrome.runtime.getManifest().version;
$('version').textContent=`v${version}`;
let diagnostic={version,events:[]};
function updateDiagnostic(){ $('diagnostic-text').textContent=JSON.stringify(diagnostic,null,2); }
function recordDiagnostic(event){diagnostic.events.push(event);diagnostic.events=diagnostic.events.slice(-12);if(!$('diagnostics').hidden)updateDiagnostic();}
function networkOptions(signal,phase){return {signal,phase,permissionCheck:origin=>chrome.permissions.contains({origins:[origin]}),onDiagnostic:recordDiagnostic};}
function resetDiagnostic(operation){diagnostic={version,operation,online:navigator.onLine,events:[]};$('diagnostics').hidden=true;$('copy-status').textContent='';updateDiagnostic();}
window.addEventListener('securitypolicyviolation',event=>{
  if(event.effectiveDirective!=='connect-src')return;
  let blockedHost='未提供';
  try{const host=new URL(event.blockedURI).hostname;if(/^[a-z0-9.-]{1,253}$/i.test(host))blockedHost=host;}catch{/* Never display the raw URI. */}
  diagnostic.cspBlockedHost=blockedHost;
  diagnostic.cspDirective='connect-src';
  updateDiagnostic();
});
$('copy-diagnostic').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(JSON.stringify(diagnostic,null,2));$('copy-status').textContent='已複製，可貼回對話。';}
  catch{$('copy-status').textContent='無法自動複製，請選取下方文字後複製。';}
});
function state(value){busy=value;$('inspect').disabled=busy||!job;$('verify').disabled=busy||!job||$('quality-row').hidden||!$('quality').value;$('quality').disabled=busy||!job;$('save').disabled=busy||!media;$('cancel').disabled=!busy;}
function clearMedia(){media=null;mediaUrl=null;$('save').disabled=true;$('result').textContent='';}
function clearErrors(){for(const id of ['inspect-error','save-error']){$(id).textContent='';$(id).hidden=true;}}
function failure(operation,error){
  const cancelled=controller?.signal.aborted||error?.name==='AbortError'||error?.message==='已取消。';
  clearMedia();
  const target=$(operation==='save'?'save-error':'inspect-error');
  target.textContent=cancelled?'已取消。請重新檢查影片後再試。':error?.message||'操作失敗，請重新檢查後再試。';
  target.hidden=false;
  $('result').textContent=operation==='save'?'請重新檢查影片後再儲存。':cancelled?'檢查已取消。':'檢查未完成。';
  $('progress').value=0;
  $('progress-text').textContent=operation==='save'?(cancelled?'儲存已取消，尚未完成儲存。':'儲存失敗，尚未完成儲存。'):'尚未開始';
  $('diagnostics').hidden=false;$('diagnostics').open=true;updateDiagnostic();
}
async function execute(operation,action){if(busy)return;state(true);clearErrors();resetDiagnostic(operation);controller=new AbortController();try{await action(controller.signal);}catch(error){failure(operation,error);}finally{state(false);controller=null;}}
async function verify(url,signal){clearMedia();$('result').textContent='正在檢查加密狀態與影片片段…';const result=await loadPlaylist(checkedUrl(url),networkOptions(signal,'variant'));if(result.type!=='media')throw new Error('此畫質仍指向其他清單，格式不在支援範圍內。');media=result;mediaUrl=url;$('result').textContent=`清單未宣告加密 · ${result.segments.length} 個片段 · 約 ${Math.round(result.duration/60)} 分鐘。儲存時會再驗證每個片段格式。`;}
$('inspect').addEventListener('click',()=>{
  // Request permissions before any await, while the click still has user activation.
  if(busy||!job)return;
  const permission=chrome.permissions.request({origins});
  execute('inspect',async signal=>{
    clearMedia();$('quality-row').hidden=true;$('quality').replaceChildren();$('progress').value=0;$('progress-text').textContent='尚未開始';
    $('result').textContent='正在取得媒體讀取權限…';
    if(!await permission)throw new Error('未取得媒體網域讀取權限。你仍可使用官方下載功能。');
    if(Date.now()-job.createdAt>600000)throw new Error('這次檢查已超過 10 分鐘。請從課程頁重新檢查以取得新網址。');
    $('result').textContent='讀取目前講座的串流清單…';
    const url=checkedUrl(job.candidates[0].url);
    const result=await loadPlaylist(url,networkOptions(signal,'master'));
    if(result.type==='master'){
      const variants=[...result.variants].sort((a,b)=>(b.height||0)-(a.height||0)||b.bandwidth-a.bandwidth);
      $('quality').replaceChildren();
      for(const variant of variants){const option=document.createElement('option');option.value=variant.url;option.textContent=variant.label;$('quality').append(option);}
      $('quality-row').hidden=false;
      await verify(variants[0].url,signal);
    }else{media=result;mediaUrl=url;$('result').textContent=`清單未宣告加密 · ${result.segments.length} 個片段 · 約 ${Math.round(result.duration/60)} 分鐘。儲存時會再驗證片段格式。`;}
  });
});
$('quality').addEventListener('change',()=>{if(busy)return;clearMedia();clearErrors();$('progress').value=0;$('progress-text').textContent='尚未開始';$('result').textContent='畫質已變更，請按「檢查此畫質」。';state(false);});
$('verify').addEventListener('click',()=>execute('inspect',signal=>{ $('progress').value=0;$('progress-text').textContent='尚未開始';return verify($('quality').value,signal); }));
$('cancel').addEventListener('click',()=>controller?.abort());
$('save').addEventListener('click',()=>{
  if(busy||!media)return;
  resetDiagnostic('save');
  if(!window.showSaveFilePicker){clearErrors();failure('save',new Error('此瀏覽器不支援直接儲存。請使用桌面版 Chrome。'));state(false);return;}
  // Must start the picker directly from the user gesture.
  let picker;
  try{picker=window.showSaveFilePicker({suggestedName:safeFilename(`${job.lectureId}-${job.lectureTitle||job.courseTitle}`),types:[{description:'MPEG-TS 影片',accept:{'video/mp2t':['.ts']}}]});}
  catch(error){clearErrors();failure('save',error);state(false);return;}
  execute('save',async signal=>{
    $('progress').value=0;$('progress-text').textContent='請選擇儲存位置…';
    const handle=await picker;
    if(signal.aborted)throw new Error('已取消。');
    // Re-read before writing so a changed/expired playlist cannot silently pass.
    $('progress-text').textContent='正在重新檢查影片清單…';
    const fresh=await loadPlaylist(mediaUrl,networkOptions(signal,'revalidate'));
    if(fresh.type!=='media')throw new Error('影片清單已變更，請重新檢查。');
    $('progress').max=fresh.segments.length;$('progress').value=0;
    $('progress-text').textContent='正在準備儲存…';
    const writable=await handle.createWritable();
    const result=await saveMedia(fresh,writable,{...networkOptions(signal,'segment'),onProgress:p=>{$('progress').value=p.completed;$('progress-text').textContent=`${p.completed} / ${p.total} 個片段 · ${(p.bytes/1024/1024).toFixed(1)} MB`;}});
    $('progress-text').textContent=`已完成儲存：${handle.name}（${(result.bytes/1024/1024).toFixed(1)} MB）`;
  });
});
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
(async()=>{
  try{
    const key=new URL(location.href).searchParams.get('job');
    if(!key||!/^stream-[a-f0-9-]{36}$/.test(key))throw new Error('請從 Udemy 課程頁的擴充功能啟動檢查。');
    const saved=await chrome.storage.session.get(key);
    job=saved[key];
    await chrome.storage.session.remove(key);
    if(!job||Date.now()-job.createdAt>600000)throw new Error('檢查工作已失效。請回課程頁重新開啟工具。');
    if(!job.candidates?.length)throw new Error('找不到目前講座的串流清單。');
    for(const entry of job.candidates)checkedUrl(entry.url);
    $('title').textContent=job.lectureTitle||`講座 ${job.lectureId}`;
    $('course').textContent=job.courseTitle;
    $('source').href=checkedUrl(job.pageUrl);
    state(false);
  }catch(error){job=null;$('title').textContent='尚未取得講座資訊';clearErrors();failure('inspect',error);state(false);}
})();
