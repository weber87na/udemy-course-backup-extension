import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {checkedUrl} from '../extension/transfer.mjs';

export const HELP=`Udemy 課程備份 CLI

用法：
  udemy-course-backup scan URL [--json]
  udemy-course-backup download URL --out DIR [--all | --chapters 1,3 | --lectures 1,3]
  udemy-course-backup download --media URL --out DIR [--title NAME]

選項：
  --out DIR            輸出資料夾，預設 ./downloads
  --all                下載目前這一門課的所有影片
  --chapters 1,3       下載 scan 列出的章節內所有影片
  --lectures 1,3       下載 scan 列出的全課講座編號（含非影片項目編號）
  --quality best|worst HLS 畫質，預設 best
  --max-height N       畫質清單僅選擇不超過 N 的已知高度，無符合版本則停止
  --browser existing   沿用正常開啟、已登入的 Chrome（預設）
  --wait-login SEC     等待 Chrome 授權與課程載入，預設 600 秒
  --json              stdout 只輸出 JSON；進度送到 stderr
  --media URL          直接下載 Udemy／Udemy CDN 的未加密 HLS，不開瀏覽器
  --title NAME         直接 HLS 的檔名
  --help, -h          顯示說明
  --version           顯示版本

未指定選取範圍時只下載目前講座，不會自動下載整門課或整個帳號。
章節與講座編號從 1 開始，依 scan 的列表為準。
預設連接已登入的 Chrome 144+，不需要安裝擴充功能。
首次請手動開啟 chrome://inspect/#remote-debugging 並啟用遠端偵錯；
CLI 連線時在 Chrome 原生提示按「允許」。只建立及關閉本次的課程分頁。
目前只支援 existing 模式，不會另外啟動瀏覽器或複製 Chrome profile。
只支援未加密、影音合併的 MPEG-TS HLS；不支援 DRM、解密或字幕下載。
Ctrl+C 取消；完成前使用 .part，成功才發布 .ts，既有非空檔會略過（未驗證）。
退出碼：0 完成／略過，1 有失敗，130 取消。
`;

export function parseCourseUrl(value) {
  let url;
  try{url=new URL(value);}catch{throw new Error('請提供完整的 HTTPS Udemy 課程網址。');}
  const match=/^\/course\/([^/]+)(?:\/learn(?:\/lecture\/([1-9]\d*))?)?\/?$/.exec(url.pathname);
  if(url.protocol!=='https:'||!/(^|\.)udemy\.com$/i.test(url.hostname)||url.username||url.password||url.port||!match)throw new Error('只接受 HTTPS Udemy 課程首頁或講座網址，不接受其他網站或瀏覽器內部頁面。');
  const [,slug,lectureId]=match;
  let decoded;
  try{decoded=decodeURIComponent(slug);}catch{throw new Error('課程網址的編碼無效。');}
  if(!decoded||['.','..'].includes(decoded)||/[\\/?#\u0000-\u0020\u007f]/.test(decoded))throw new Error('課程網址包含不支援的路徑。');
  return {url:`${url.origin}/course/${slug}/learn/${lectureId?`lecture/${lectureId}`:''}`,courseKey:`${url.origin}/course/${slug}`,origin:url.origin,slug,lectureId:lectureId||null};
}

function numbers(value,flag) {
  if(!/^[1-9]\d*(,[1-9]\d*)*$/.test(value))throw new Error(`${flag} 請使用正整數編號，例如 1,3。`);
  const result=[...new Set(value.split(',').map(Number))];
  if(result.some(number=>!Number.isSafeInteger(number)))throw new Error('編號超過支援範圍。');
  return result;
}

export function parseOptions(argv,cwd=process.cwd()) {
  let values,positionals;
  try{({values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean'},out:{type:'string'},all:{type:'boolean'},
    chapters:{type:'string'},lectures:{type:'string'},quality:{type:'string'},'max-height':{type:'string'},
    browser:{type:'string'},'wait-login':{type:'string'},json:{type:'boolean'},media:{type:'string'},title:{type:'string'}
  }}));}catch{throw new Error('命令或選項無效，請執行 --help 查看用法。');}
  if(values.help||!argv.length)return {command:'help'};
  if(values.version)return {command:'version'};
  const [command,input,...extra]=positionals;
  if(!['scan','download'].includes(command)||extra.length)throw new Error('請使用 scan 或 download，並提供一個網址。');
  const selectors=[Boolean(values.all),values.chapters!==undefined,values.lectures!==undefined];
  if(selectors.filter(Boolean).length>1)throw new Error('--all、--chapters、--lectures 只能擇一使用。');
  if(values.media!==undefined&&(command!=='download'||input||selectors.some(Boolean)||values.browser||values['wait-login']))throw new Error('--media 不可搭配課程網址、章節選取或瀏覽器選項。');
  if(values.title!==undefined&&!values.media)throw new Error('--title 只用於 --media 直接 HLS 下載。');
  if(command==='scan'&&[values.out,values.quality,values['max-height'],values.title].some(v=>v!==undefined)||command==='scan'&&selectors.some(Boolean))throw new Error('scan 不接受下載選取、畫質或輸出位置選項。');
  const quality=values.quality||'best',browser=values.browser||'existing';
  if(!['best','worst'].includes(quality))throw new Error('--quality 必須是 best 或 worst。');
  if(browser!=='existing')throw new Error('目前只支援 --browser existing，請使用正常開啟、已登入的 Chrome。');
  const wait=values['wait-login']??'600';
  if(!/^\d+$/.test(wait)||Number(wait)<1||Number(wait)>3600)throw new Error('--wait-login 必須為 1 至 3600 秒。');
  let maxHeight;
  if(values['max-height']!==undefined){
    const value=values['max-height'];maxHeight=Number(value);
    if(!/^\d+$/.test(value)||maxHeight<1||maxHeight>16384)throw new Error('--max-height 必須為 1 至 16384。');
  }
  if(values.out!==undefined&&!values.out.trim())throw new Error('--out 不可為空白。');
  if(values.title!==undefined&&!values.title.trim())throw new Error('--title 不可為空白。');
  let url,course;
  if(values.media!==undefined){
    url=checkedUrl(values.media);
    if(new URL(url).hash)throw new Error('媒體網址不可包含片段識別。');
  }else{course=parseCourseUrl(input);url=course.url;}
  return {command,url,course,direct:values.media!==undefined,outputDir:resolve(cwd,values.out||'downloads'),
    all:Boolean(values.all),chapters:values.chapters===undefined?undefined:numbers(values.chapters,'--chapters'),
    lectures:values.lectures===undefined?undefined:numbers(values.lectures,'--lectures'),
    quality,maxHeight,browser,waitLoginMs:Number(wait)*1000,json:Boolean(values.json),title:values.title};
}

export function catalogEntries(catalog) {
  return catalog.sections.flatMap(section=>section.items.map(item=>({...item,sectionIndex:section.sectionIndex,sectionTitle:section.title})))
    .map((item,index)=>({...item,number:index+1}));
}

export function selectLectures(catalog,options) {
  if(!catalog.complete)throw new Error('課程目錄尚未完整，請先在 Chrome 確認所有章節可展開，再重試。');
  const entries=catalogEntries(catalog);
  let selected;
  if(options.all)selected=entries.filter(item=>item.kind==='video');
  else if(options.chapters){
    if(options.chapters.some(n=>!catalog.sections.some(section=>section.sectionIndex===n)))throw new Error('章節編號超出目錄範圍，請查看 scan 的列表。');
    selected=entries.filter(item=>options.chapters.includes(item.sectionIndex)&&item.kind==='video');
  }else if(options.lectures){
    if(options.lectures.some(n=>n>entries.length))throw new Error('講座編號超出目錄範圍，請查看 scan 的列表。');
    selected=entries.filter(item=>options.lectures.includes(item.number));
    if(selected.some(item=>item.kind!=='video'))throw new Error('選取的講座包含教材、測驗或未辨識項目；此 CLI 只下載影片。');
  }else{
    const currentId=options.course?.lectureId||parseCourseUrl(catalog.pageUrl).lectureId;
    selected=entries.filter(item=>item.lectureId===currentId&&item.kind==='video');
    if(!selected.length)throw new Error('目前頁面不是可辨識的影片講座；請提供講座網址或使用 --chapters、--lectures、--all 選取。');
  }
  if(!selected.length)throw new Error('所選範圍沒有可下載的影片。');
  return selected;
}
