import {STORAGE_PREFIX,normalizeCourse,sanitizeRecord,summarizeRecord,reasonLabel} from './library-core.mjs';
import {createInspector,checkCourse} from './library-scan-io.mjs';
import {withBatchLock,abortIfNeeded} from './batch-io.mjs';
import {LIBRARY_ORIGINS} from './library-background.mjs';

const $=id=>document.getElementById(id),rows=new Map();
let job,busy=false,controller,inspector,ownerTabId;
$('version').textContent=`v${chrome.runtime.getManifest().version}`;
function error(message=''){$('error').textContent=message;$('error').hidden=!message;}
function controls(){$('start').disabled=busy||!job;$('stop').disabled=!busy||controller?.signal.aborted;$('source').disabled=!job;}
function render(record) {
  const row=rows.get(record.courseKey);if(!row)return;
  const summary=summarizeRecord(record);
  row.label.textContent=summary.label;row.label.className=`scan-label ${summary.tone}`;row.detail.textContent=summary.detail;
  row.list.replaceChildren();
  for(const item of record.results){
    const line=document.createElement('div');line.className='scan-lecture';
    const title=document.createElement('span');title.textContent=item.title;
    const status=document.createElement('span');status.textContent=`${{downloadable:'可下載',unsupported:'不可下載',unknown:'尚未確認'}[item.status]} · ${reasonLabel(item.reason)}`;
    line.append(title,status);row.list.append(line);
  }
}
$('source').addEventListener('click',()=>{chrome.tabs.update(job.sourceTabId,{active:true}).catch(()=>error('我的課程分頁已關閉，請重新開啟。'));});
$('stop').addEventListener('click',()=>{controller?.abort();void inspector?.close();$('status').textContent='正在停止，已完成的檢查會保留。';controls();});
window.addEventListener('pagehide',()=>{controller?.abort();void inspector?.close();});
$('start').addEventListener('click',async()=>{
  if(busy||!job)return;
  const permission=chrome.permissions.request({origins:LIBRARY_ORIGINS});
  busy=true;controller=new AbortController();controls();error();
  let done=0;
  try {
    if(!await permission)throw new Error('需要 Udemy 與 Udemy CDN 讀取權限才能檢查。');
    await navigator.locks.request('udemy-library-scan',{ifAvailable:true},async lock=>{
      if(!lock)throw new Error('已有另一個課程檢查執行中，請先停止該工作。');
      for(const course of job.courses){
        abortIfNeeded(controller.signal);
        $('status').textContent=`${done+1} / ${job.courses.length}：${course.title}，正在讀取目錄…`;
        inspector=createInspector(chrome,{signal:controller.signal,openTab:async({url})=>{
          const result=await chrome.runtime.sendMessage({type:'library-open-worker',ownerTabId,url});
          if(!result?.ok||!Number.isInteger(result.tab?.id))throw new Error('無法建立課程檢查分頁。');
          return result.tab;
        }});
        try {
          await checkCourse(course,job.mode,{inspector,signal:controller.signal,withCourseLock:(key,action)=>withBatchLock(navigator.locks,`library-${ownerTabId}`,key,action),onRecord:async record=>{
            const safe=sanitizeRecord(record);if(!safe)throw new Error('檢查資料無效。');
            await chrome.storage.local.set({[STORAGE_PREFIX+safe.courseKey]:safe});render(safe);
            $('status').textContent=`${done+1} / ${job.courses.length}：${course.title}，已檢查 ${safe.results.length} / ${safe.totalVideos??'?'} 堂`;
          }});
        } catch(failure) {
          if(controller.signal.aborted)throw failure;
          const row=rows.get(course.courseKey);row.label.textContent='尚未確認';row.label.className='scan-label neutral';
          row.detail.textContent='無法完成檢查，請確認已登入、課程可開啟，或是否已有其他備份工作。';
        } finally {await inspector.close();inspector=null;}
        done++;$('progress').value=done;
      }
    });
    $('status').textContent='檢查結束，結果已同步到我的課程卡片。';
  } catch(failure){
    if(controller.signal.aborted)$('status').textContent='已停止。已檢查結果保留，未完成課程不會標成整課可下載。';
    else {error(String(failure.message||'無法開始檢查。').replace(/https?:\/\/\S+/g,'[網址已隱藏]'));$('status').textContent='檢查未完成。';}
  } finally {await inspector?.close();inspector=null;busy=false;controls();}
});

(async()=>{
  try {
    const key=new URL(location.href).searchParams.get('job');
    if(!/^library-[0-9a-f-]{36}$/i.test(key||''))throw new Error('請從我的課程卡片重新啟動檢查。');
    const data=(await chrome.storage.session.get(key))[key];
    if(!data||Date.now()-data.createdAt>3600000||!['sample','full'].includes(data.mode)||!Array.isArray(data.courses)||!data.courses.length||data.courses.length>100)throw new Error('檢查工作已過期，請從我的課程頁重新啟動。');
    const courses=data.courses.map(item=>{const course=normalizeCourse(item.courseKey);if(!course)throw new Error('課程網址不符。');return {...course,title:String(item.title||'Udemy 課程').slice(0,200)};});
    if(new Set(courses.map(c=>c.courseKey)).size!==courses.length)throw new Error('課程清單重複。');
    ownerTabId=(await chrome.tabs.getCurrent())?.id;
    if(!Number.isInteger(ownerTabId))throw new Error('請在獨立分頁開啟課程檢查。');
    job={...data,courses};await chrome.storage.session.remove(key);
    $('scope').textContent=`${job.mode==='sample'?'快速抽查':'逐堂檢查'} · ${courses.length} 門課程`;
    $('explanation').textContent=job.mode==='sample'?'每門課檢查第一堂可辨識影片；卡片會標明抽查範圍，其他講座仍未確認。':'依序檢查每門課的所有可辨識影片，只有完整目錄全部檢查後才給整課結論。';
    $('progress').max=courses.length;
    for(const course of courses){
      const wrapper=document.createElement('article');wrapper.className='scan-course';
      const title=document.createElement('h3');title.textContent=course.title;
      const label=document.createElement('span');label.className='scan-label';label.textContent='尚未檢查';
      const detail=document.createElement('p'),details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('div');
      summary.textContent='查看各堂結果';details.append(summary,list);wrapper.append(title,label,detail,details);$('courses').append(wrapper);rows.set(course.courseKey,{label,detail,list});
    }
    controls();
  } catch(failure){error(failure.message);}
})();
