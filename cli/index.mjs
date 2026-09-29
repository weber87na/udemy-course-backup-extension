#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {HELP,parseOptions,catalogEntries,selectLectures} from './options.mjs';
import {launchSession} from './browser.mjs';
import {navigateCourse,collectCourse,captureLecture} from './course.mjs';
import {createSessionFetch} from './network.mjs';
import {downloadLecture} from './download.mjs';

const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
export const cleanMessage=value=>String(value||'操作未完成。')
  .replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi,'[來源網址已隱藏]')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,800);
const checkAbort=signal=>{if(signal.aborted)throw new DOMException('已取消。','AbortError');};
const itemSummary=item=>({number:item.number,lectureId:item.lectureId,sectionNumber:item.sectionIndex,title:cleanMessage(item.title)});

export function scanSummary(catalog) {
  return {schemaVersion:1,version,courseKey:catalog.courseKey,title:cleanMessage(catalog.courseTitle),complete:Boolean(catalog.complete),
    sections:catalog.sections.map(section=>({number:section.sectionIndex,title:cleanMessage(section.title),count:section.items.length,expectedCount:section.expectedCount})),
    lectures:catalogEntries(catalog).map(item=>({...itemSummary(item),kind:item.kind})),notes:(catalog.notes||[]).map(cleanMessage)};
}

export async function run(argv,{stdout=process.stdout,stderr=process.stderr,signal:externalSignal,
  launch=launchSession,navigate=navigateCourse,collect=collectCourse,capture=captureLecture,
  createFetcher=createSessionFetch,download=downloadLecture}={}) {
  const options=parseOptions(argv);
  if(options.command==='help'){stdout.write(HELP);return 0;}
  if(options.command==='version'){stdout.write(`${version}\n`);return 0;}
  const controller=new AbortController(),signal=controller.signal;
  const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  externalSignal?.addEventListener('abort',stop,{once:true});if(externalSignal?.aborted)stop();
  const log=text=>stderr.write(`${cleanMessage(text)}\n`);
  let session,output,exitCode=0;
  const report={schemaVersion:1,version,status:'running',completed:[],skipped:[],failed:[]};
  try{
    checkAbort(signal);
    let selected,catalog,fetcher;
    if(options.direct){
      const url=new URL(options.url);
      const identity=createHash('sha256').update(url.origin+url.pathname).digest('hex').slice(0,16);
      selected=[{key:identity,lectureId:identity,number:1,index:1,lectureIndex:1,sectionIndex:1,sectionTitle:'直接 HLS',title:options.title||'課程影片',kind:'video'}];
      catalog={courseTitle:'Udemy 直接備份',courseKey:'direct'};
      fetcher=createFetcher();
    }else{
      log('連接已登入的 Chrome。首次請手動開啟 chrome://inspect/#remote-debugging；連線提示出現時按「允許」。');
      session=await launch({url:options.url,browser:options.browser,signal,timeoutMs:options.waitLoginMs,log});
      checkAbort(signal);
      await navigate(session,options.url,{signal,timeoutMs:options.waitLoginMs});
      catalog=await collect(session,options.url,{signal,timeoutMs:options.waitLoginMs});
      if(catalog.courseKey!==options.course.courseKey)throw new Error('讀取的課程與指定課程不符，已停止。');
      const summary=scanSummary(catalog);
      if(options.command==='scan'){
        output=summary;
        exitCode=summary.complete?0:1;
        if(!options.json){
          stdout.write(`${summary.title}\n`);
          for(const section of summary.sections){
            stdout.write(`章節 ${section.number}：${section.title}（${section.count} 項）\n`);
            for(const item of summary.lectures.filter(item=>item.sectionNumber===section.number))stdout.write(`  ${item.number}. [${item.kind==='video'?'影片':item.kind==='article'?'教材':'未辨識'}] ${item.title}\n`);
          }
          if(!summary.complete)log('目錄尚未完整；請確認來源課程頁後重試。');
        }
      }else{
        selected=selectLectures(catalog,options);
        report.course={title:summary.title,key:summary.courseKey};
        report.selected=selected.map(itemSummary);
        log(`課程：${summary.title}；目錄 ${summary.sections.length} 章、${summary.lectures.length} 項，本次選取 ${selected.length} 堂影片。`);
        for(const section of summary.sections){
          log(`章節 ${section.number}：${section.title}`);
          for(const item of summary.lectures.filter(item=>item.sectionNumber===section.number))log(`  ${item.number}. [${item.kind}] ${item.title}`);
        }
        fetcher=createFetcher({getCookies:session.getCookies,authOrigin:options.course.origin});
      }
    }
    if(selected){
      for(const item of selected){
        checkAbort(signal);
        const summary=itemSummary(item);
        log(`開始：${item.number}. ${item.title}`);
        try{
          const source=options.direct?{candidates:[{url:options.url,isMaster:true}],lectureId:item.lectureId}:await capture(session,item,{signal,timeoutMs:options.waitLoginMs});
          checkAbort(signal);
          let last=0;
          const result=await download({capture:source,item,courseTitle:catalog.courseTitle,courseKey:catalog.courseKey,
            outputDir:options.outputDir,fetcher,signal,quality:options.quality,maxHeight:options.maxHeight,
            onProgress:progress=>{
              const now=Date.now();
              if(now-last<1000&&progress.completed!==progress.total)return;
              last=now;log(`${progress.completed} / ${progress.total} 片段 · 暫存 ${(progress.bytes/1048576).toFixed(1)} MB`);
            }});
          const safeResult={...summary,path:result.path,bytes:result.bytes,segments:result.segments,qualityLabel:result.qualityLabel?cleanMessage(result.qualityLabel):undefined};
          if(result.status==='completed'){
            report.completed.push(safeResult);log(`已完成：${result.path}（${(result.bytes/1048576).toFixed(1)} MB）`);
          }else if(result.status==='skipped'){
            report.skipped.push({...safeResult,reason:'已有非空檔案，未驗證內容。'});log(`略過既有檔案（未驗證）：${result.path}`);
          }else throw new Error('下載未回報完成或略過，未將該堂標為成功。');
        }catch(error){
          checkAbort(signal);
          if(error?.name==='AbortError')throw error;
          report.failed.push({...summary,reason:cleanMessage(error.message)});log(`未完成：${item.title}；${error.message}`);
          if(error?.fatal||error?.code==='COURSE_SESSION_LOST')throw error;
        }
      }
      checkAbort(signal);
      report.status=report.failed.length?'partial':'finished';exitCode=report.failed.length?1:0;output=report;
    }
  }catch(error){
    const cancelled=signal.aborted||error?.name==='AbortError';
    exitCode=cancelled?130:1;
    report.status=cancelled?'cancelled':'failed';report.error=cleanMessage(cancelled?'已取消；未完成的影片不會標示成功。':error.message);
    output=report;log(report.error);
  }finally{
    try{await session?.close();}catch{log('課程分頁的連線清理未完成，請確認本次建立的分頁已關閉。');}
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);externalSignal?.removeEventListener('abort',stop);
  }
  if(options.json)stdout.write(`${JSON.stringify(output,null,2)}\n`);
  else if(options.command==='download')stdout.write(`${report.completed.length} 堂完成，${report.skipped.length} 堂略過，${report.failed.length} 堂失敗${report.status==='cancelled'?'（已取消）':''}。\n`);
  return exitCode;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const finish=code=>{process.exitCode=code;setTimeout(()=>process.exit(code),1000).unref();};
  run(process.argv.slice(2)).then(finish).catch(error=>{process.stderr.write(`${cleanMessage(error.message)}\n`);finish(error.name==='AbortError'?130:1);});
}
