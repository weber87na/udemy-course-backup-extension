import {normalizeCourse} from './library-core.mjs';

export const LIBRARY_ORIGINS=['https://*.udemy.com/*','https://*.udemycdn.com/*'];
export function isLibraryUrl(value) {
  try { const u=new URL(value); return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)udemy\.com$/i.test(u.hostname)&&/^\/home\/my-courses(?:\/|$)/.test(u.pathname); }
  catch { return false; }
}
export function scanCourses(value,origin) {
  if(!Array.isArray(value)||!value.length||value.length>100)throw new Error('每次請檢查 1 至 100 門目前頁面上的課程。');
  const seen=new Set();
  return value.map(item=>{
    const course=normalizeCourse(item?.courseKey);
    if(!course||new URL(course.courseKey).origin!==origin||seen.has(course.courseKey))throw new Error('課程清單無效，請重新整理我的課程頁。');
    seen.add(course.courseKey);
    return {courseKey:course.courseKey,title:String(item.title||'Udemy 課程').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200)};
  });
}

export async function startLibraryScan(api,message,sender) {
  if(!isLibraryUrl(sender?.url)||!Number.isInteger(sender?.tab?.id)||sender.frameId!==0)throw new Error('請從 Udemy 我的課程頁啟動檢查。');
  if(!['sample','full'].includes(message.mode))throw new Error('檢查模式無效。');
  const courses=scanCourses(message.courses,new URL(sender.url).origin);
  if(!await api.permissions.contains({origins:LIBRARY_ORIGINS}))return {ok:false,error:'need-permission'};
  const job=`library-${crypto.randomUUID()}`;
  await api.storage.session.set({[job]:{courses,mode:message.mode,sourceTabId:sender.tab.id,createdAt:Date.now()}});
  try { await api.tabs.create({url:api.runtime.getURL(`library-scan.html?job=${encodeURIComponent(job)}`)}); }
  catch(error) { await api.storage.session.remove(job);throw error; }
  return {ok:true};
}

export async function openWorkerTab(api,message,sender) {
  const owner=await api.tabs.get(message.ownerTabId);
  const entry=api.runtime.getURL('library-scan.html');
  if(sender.id!==api.runtime.id||typeof sender.url!=='string'||sender.url.split('?')[0]!==entry||owner.url!==sender.url)throw new Error('檢查頁無效。');
  const course=normalizeCourse(message.url);
  if(!course||(!course.courseId&&!new URL(message.url).pathname.includes('/learn')))throw new Error('檢查課程網址無效。');
  if(course.courseId)message={...message,url:course.url};
  const url=new URL(message.url);if(!course.courseId)url.search='';url.hash='';
  const tab=await api.tabs.create({url:url.href,active:false});
  try {
    await api.storage.session.set({[`libraryOwned:${owner.id}`]:tab.id});
    if((await api.tabs.get(owner.id)).url!==sender.url)throw new Error('檢查頁已離開。');
    return {ok:true,tab:{id:tab.id}};
  } catch(error) {await api.tabs.remove(tab.id).catch(()=>{});throw error;}
}

if(!globalThis.document&&globalThis.chrome?.runtime?.onMessage){
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    const action=message?.type==='library-scan'?startLibraryScan:message?.type==='library-open-worker'?openWorkerTab:null;
    if(!action)return false;
    action(chrome,message,sender).then(respond,()=>respond({ok:false,error:'無法開始檢查，請確認網站權限並重新整理我的課程頁。'}));
    return true;
  });
  const cleanup=async id=>{
    const key=`libraryOwned:${id}`,saved=await chrome.storage.session.get(key);
    if(Number.isInteger(saved[key]))await chrome.tabs.remove(saved[key]).catch(()=>{});
    await chrome.storage.session.remove(key);
  };
  chrome.tabs.onRemoved.addListener(id=>{void cleanup(id);});
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url||change.status==='loading')void cleanup(id);});
}
