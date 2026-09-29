import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../cli/index.mjs';

const url='https://www.udemy.com/course/test-course/learn/lecture/2';
const courseKey='https://www.udemy.com/course/test-course';
const catalog={complete:true,pageUrl:url,courseKey,courseTitle:'Test course',notes:[],sections:[{sectionIndex:1,title:'Section',expectedCount:3,items:[
  {key:'1',lectureId:'1',kind:'article',title:'Article',index:1},{key:'2',lectureId:'2',kind:'video',title:'Video 1',index:2},{key:'3',lectureId:'3',kind:'video',title:'Video 2',index:3}
]}]};
function fixture(overrides={}){
  const seen={launch:0,close:0,capture:[],download:[],fetchOptions:[],out:'',err:''};
  const session={getCookies:()=>[],close:async()=>{seen.close++;}};
  const deps={stdout:{write:s=>{seen.out+=s;}},stderr:{write:s=>{seen.err+=s;}},launch:async()=>{seen.launch++;return session;},navigate:async()=>{},collect:async()=>structuredClone(catalog),capture:async(_s,item)=>{seen.capture.push(item.lectureId);return {candidates:[{url:'https://www.udemy.com/assets/2/master.m3u8?token=PRIVATE_FIXTURE'}]};},createFetcher:options=>{seen.fetchOptions.push(options);return ()=>{};},download:async args=>{seen.download.push(args.item.lectureId);return {status:'completed',path:`D:/fixture/${args.item.lectureId}.ts`,bytes:188*3,segments:1,qualityLabel:'720p'};},...overrides};
  return {seen,deps};
}
test('scan emits only safe catalog JSON and always closes the owned session',async()=>{
  const {seen,deps}=fixture();assert.equal(await run(['scan',url,'--json'],deps),0);
  const result=JSON.parse(seen.out);assert.equal(result.lectures.length,3);assert.deepEqual(result.lectures.map(x=>x.number),[1,2,3]);assert.equal(seen.close,1);assert.equal(seen.download.length,0);assert.ok(!seen.out.includes('PRIVATE_FIXTURE'));
});
test('download defaults to one current lecture; --all uses video entries in course order',async()=>{
  const first=fixture();assert.equal(await run(['download',url,'--json'],first.deps),0);assert.deepEqual(first.seen.capture,['2']);
  const all=fixture();assert.equal(await run(['download',url,'--all','--json'],all.deps),0);assert.deepEqual(all.seen.download,['2','3']);assert.equal(JSON.parse(all.seen.out).completed.length,2);assert.equal(all.seen.close,1);
  assert.equal(all.seen.fetchOptions[0].authOrigin,'https://www.udemy.com');
});
test('media failures remain per lecture, redact signed URLs, and return failure with partial results',async()=>{
  const {seen,deps}=fixture({download:async({item})=>{if(item.lectureId==='2')throw new Error('Failed https://www.udemy.com/a?token=PRIVATE_FIXTURE');return {status:'completed',path:'D:/fixture/3.ts',bytes:564};}});
  assert.equal(await run(['download',url,'--all','--json'],deps),1);const result=JSON.parse(seen.out);
  assert.equal(result.completed.length,1);assert.equal(result.failed.length,1);assert.equal(result.status,'partial');assert.equal(seen.close,1);assert.ok(!seen.out.includes('PRIVATE_FIXTURE'));assert.ok(!seen.err.includes('PRIVATE_FIXTURE'));
});
test('existing output is skipped, never reported as a verified completion',async()=>{
  const {seen,deps}=fixture({download:async()=>({status:'skipped',path:'D:/fixture/existing.ts',bytes:564})});
  assert.equal(await run(['download',url,'--json'],deps),0);const result=JSON.parse(seen.out);assert.equal(result.completed.length,0);assert.equal(result.skipped.length,1);assert.match(result.skipped[0].reason,/未驗證/);
});
test('cancellation waits for cleanup, retains completed results and stops later lectures',async()=>{
  const controller=new AbortController();const {seen,deps}=fixture({signal:controller.signal,download:async()=>{controller.abort();return {status:'completed',path:'D:/fixture/done.ts',bytes:564};}});
  assert.equal(await run(['download',url,'--all','--json'],deps),130);const result=JSON.parse(seen.out);assert.equal(result.completed.length,1);assert.equal(result.status,'cancelled');assert.equal(seen.capture.length,1);assert.equal(seen.close,1);
});
test('wrong-course results and fatal source loss never proceed to unrelated or subsequent media',async()=>{
  const wrong=fixture({collect:async()=>({...catalog,courseKey:'https://www.udemy.com/course/other'})});assert.equal(await run(['download',url,'--all','--json'],wrong.deps),1);assert.equal(wrong.seen.capture.length,0);assert.equal(wrong.seen.close,1);
  let attempts=0;const lost=fixture({capture:async()=>{attempts++;throw Object.assign(new Error('Source closed'),{fatal:true});}});assert.equal(await run(['download',url,'--all','--json'],lost.deps),1);assert.equal(attempts,1);assert.equal(lost.seen.close,1);
});
test('anonymous direct mode never opens Chrome or requests browser cookies',async()=>{
  const {seen,deps}=fixture();assert.equal(await run(['download','--media','https://udemycdn.com/example.m3u8?token=PRIVATE_FIXTURE','--json'],deps),0);assert.equal(seen.launch,0);assert.deepEqual(seen.fetchOptions,[undefined]);assert.equal(JSON.parse(seen.out).completed.length,1);assert.ok(!seen.out.includes('PRIVATE_FIXTURE'));
});
test('incomplete scan reports nonzero; invalid selections fail without downloading',async()=>{
  const partial=fixture({collect:async()=>({...catalog,complete:false})});assert.equal(await run(['scan',url,'--json'],partial.deps),1);assert.equal(JSON.parse(partial.seen.out).complete,false);
  const invalid=fixture();assert.equal(await run(['download',url,'--lectures','1','--json'],invalid.deps),1);assert.equal(invalid.seen.download.length,0);assert.equal(invalid.seen.close,1);
});
