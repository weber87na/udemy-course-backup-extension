import test from 'node:test';
import assert from 'node:assert/strict';
import {courseIdentity,delay,pageBridge,waitForStream,readSelectedMedia,outputTarget,writeLecture,withBatchLock} from '../extension/batch-io.mjs';
import {lectureDownloadPath} from '../extension/batch-core.mjs';

const pageUrl='https://www.udemy.com/course/fixture-course/learn/lecture/123';
const courseKey='https://www.udemy.com/course/fixture-course';
const title='Fixture course';
const item={key:'lecture:123',lectureId:123,sectionIndex:1,sectionTitle:'Section 1',lectureIndex:1,title:'Lecture 1',selected:true,status:'queued'};
const outputPath=()=>lectureDownloadPath(item,{courseTitle:title});
const capture={candidates:[{url:'https://www.udemy.com/assets/555/master.m3u8?token=fixture-only'}]};
const playlist='#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\none.ts\n#EXT-X-ENDLIST\n';
const media={type:'media',duration:4,segments:[{url:'https://udemycdn.com/one.ts',duration:4}]};
const bytes=()=>{const data=new Uint8Array(188*3).fill(0xff);for(let n=0;n<data.length;n+=188)data.set([0x47,0x40,0x11,0x10],n);return data;};
const response=body=>new Response(body,{headers:{'content-type':typeof body==='string'?'application/vnd.apple.mpegurl':'video/mp2t'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

function filesystem({existing,lookupError,readError,closeError}={}) {
  const files=new Map();
  if(existing!==undefined)files.set(outputPath(),new Uint8Array(existing));
  const calls={directories:0,lookups:0,created:0,opened:0,writes:0,closed:0,aborted:0};
  const handle=path=>({
    async getFile(){if(readError)throw readError;return {size:files.get(path).length};},
    async createWritable(){
      calls.opened++;
      const pending=[];
      return {
        async write(data){calls.writes++;pending.push(Uint8Array.from(data));},
        async close(){
          if(closeError)throw closeError;
          calls.closed++;
          const merged=new Uint8Array(pending.reduce((sum,value)=>sum+value.length,0));
          let offset=0;for(const value of pending){merged.set(value,offset);offset+=value.length;}
          files.set(path,merged);
        },
        async abort(){calls.aborted++;}
      };
    }
  });
  const directory=(prefix='')=>({
    async getDirectoryHandle(name){calls.directories++;return directory(prefix+name+'/');},
    async getFileHandle(name,options={}){
      calls.lookups++;
      if(lookupError)throw lookupError;
      const path=prefix+name;
      if(!files.has(path)){
        if(!options.create)throw new DOMException('File absent','NotFoundError');
        calls.created++;files.set(path,new Uint8Array());
      }
      return handle(path);
    }
  });
  return {root:directory(),calls,files};
}

function chromeFixture({tab={id:17,url:pageUrl},getError,scriptError,result={ok:true,value:'fixture'}}={}) {
  const calls=[];
  return {calls,api:{
    tabs:{async get(id){assert.equal(id,17);if(getError)throw getError;return tab;}},
    scripting:{async executeScript(options){calls.push(options);if(scriptError)throw scriptError;return [{result}];}}
  }};
}

function mockLocks() {
  const held=new Set();
  return {held,async request(name,options,callback){
    assert.equal(options.ifAvailable,true);
    if(held.has(name))return callback(null);
    held.add(name);
    try{return await callback({name});}finally{held.delete(name);}
  }};
}

test('course identity ignores query/hash but rejects unsupported pages and origins',()=>{
  assert.deepEqual(courseIdentity(pageUrl+'?fixture=1#overview'),{key:courseKey,slug:'fixture-course',pageUrl});
  for(const url of ['http://www.udemy.com/course/a/learn/lecture/1','https://udemy.com.evil.test/course/a/learn/lecture/1','https://x:y@udemy.com/course/a/learn/lecture/1','https://udemy.com:8443/course/a/learn/lecture/1','https://www.udemy.com/course/a/'])assert.throws(()=>courseIdentity(url));
});

test('selected HLS quality is fetched and parsed before any segment writes',async()=>{
  const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720.m3u8\n';
  const requests=[];
  const result=await readSelectedMedia(capture,'720',{fetcher:async url=>{
    requests.push(url);return response(requests.length===1?master:playlist);
  }});
  assert.equal(result.qualityLabel,'720p');
  assert.equal(result.media.type,'media');
  assert.equal(requests.length,2);
  assert.equal(new URL(requests[1]).pathname,'/assets/555/720.m3u8');
  assert.equal(result.media.segments[0].url,'https://www.udemy.com/assets/555/one.ts');
});

test('encrypted and nested playlists reject without creating files or downloading segments',async()=>{
  const encrypted='#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\none.ts\n#EXT-X-ENDLIST\n';
  const nested='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x480\nnext.m3u8\n';
  for(const [body,message,expectedRequests] of [[encrypted,/加密/,1],[nested,/巢狀/,2]]){
    const fs=filesystem();let requests=0;
    await assert.rejects(async()=>{
      const target=await outputTarget(fs.root,item,title);
      const selected=await readSelectedMedia(capture,'best',{fetcher:async()=>{requests++;return response(body);}});
      await writeLecture(target,selected.media,{});
    },message);
    assert.equal(requests,expectedRequests);
    assert.equal(fs.calls.created,0);assert.equal(fs.calls.opened,0);
    assert.equal(fs.calls.writes,0);assert.equal(fs.calls.closed,0);
  }
});

test('output target skips existing nonempty files without opening a writer',async()=>{
  const fs=filesystem({existing:[1,2,3]});
  const target=await outputTarget(fs.root,item,title);
  assert.equal(target.exists,true);assert.equal(target.path,outputPath());
  assert.equal(fs.calls.created,0);assert.equal(fs.calls.opened,0);
  assert.deepEqual(fs.files.get(outputPath()),new Uint8Array([1,2,3]));
});

test('output target permits an empty retry and defers missing-file creation',async()=>{
  for(const existing of [undefined,[]]){
    const fs=filesystem({existing});
    const target=await outputTarget(fs.root,item,title);
    assert.equal(target.exists,false);
    assert.equal(Boolean(target.handle),existing!==undefined);
    assert.equal(fs.calls.created,0);assert.equal(fs.calls.opened,0);
  }
});

test('file lookup and reading permission failures are not treated as missing files',async()=>{
  for(const options of [{lookupError:new DOMException('Denied','NotAllowedError')},{existing:[1],readError:new DOMException('Denied','NotReadableError')}]){
    const fs=filesystem(options);const expected=options.lookupError||options.readError;
    await assert.rejects(outputTarget(fs.root,item,title),error=>error===expected);
    assert.equal(fs.calls.created,0);assert.equal(fs.calls.opened,0);
  }
});

test('writeLecture commits all bytes before reporting completed, including an empty retry',async()=>{
  for(const existing of [undefined,[]]){
    const fs=filesystem({existing});const target=await outputTarget(fs.root,item,title);
    const result=await writeLecture(target,media,{fetcher:async()=>response(bytes())});
    assert.equal(result.status,'completed');assert.equal(result.bytes,564);assert.equal(result.segments,1);
    assert.equal(fs.calls.closed,1);assert.equal(fs.calls.aborted,0);
    assert.deepEqual(fs.files.get(outputPath()),bytes());
  }
});

test('writeLecture rechecks a file created or filled after the earlier target check',async()=>{
  for(const existing of [undefined,[]]){
    const fs=filesystem({existing});const target=await outputTarget(fs.root,item,title);
    fs.files.set(outputPath(),new Uint8Array([8,9]));let fetches=0;
    const result=await writeLecture(target,media,{fetcher:async()=>{fetches++;return response(bytes());}});
    assert.equal(result.status,'skipped');assert.match(result.reason,/未驗證/);
    assert.equal(fetches,0);assert.equal(fs.calls.opened,0);
    assert.deepEqual(fs.files.get(outputPath()),new Uint8Array([8,9]));
  }
});

test('writeLecture preserves permission errors from its final existence check',async()=>{
  const fs=filesystem();const target=await outputTarget(fs.root,item,title);
  const denied=new DOMException('Denied','NotAllowedError');
  target.directory.getFileHandle=async()=>{throw denied;};
  await assert.rejects(writeLecture(target,media,{}),error=>error===denied);
  assert.equal(fs.calls.created,0);assert.equal(fs.calls.opened,0);assert.equal(fs.calls.writes,0);
});

test('writeLecture preserves writer close failures and never reports completion',async()=>{
  const failure=new DOMException('Disk full','QuotaExceededError');const fs=filesystem({closeError:failure});
  const target=await outputTarget(fs.root,item,title);
  await assert.rejects(writeLecture(target,media,{fetcher:async()=>response(bytes())}),error=>error===failure);
  assert.equal(fs.calls.closed,0);assert.equal(fs.calls.aborted,1);
  assert.equal(fs.files.get(outputPath()).length,0);
});

test('invalid segment bytes abort without writing and leave a retryable empty file',async()=>{
  const fs=filesystem();const target=await outputTarget(fs.root,item,title);
  await assert.rejects(writeLecture(target,media,{fetcher:async()=>response(new Uint8Array(600))}),/格式/);
  assert.equal(fs.calls.writes,0);assert.equal(fs.calls.closed,0);assert.equal(fs.calls.aborted,1);
  assert.equal(fs.files.get(outputPath()).length,0);
});

test('cancelled writes do not create files or open streams',async()=>{
  const fs=filesystem();const target=await outputTarget(fs.root,item,title);const controller=new AbortController();controller.abort();
  await assert.rejects(writeLecture(target,media,{signal:controller.signal}),{name:'AbortError'});
  assert.equal(fs.calls.created,0);assert.equal(fs.calls.opened,0);
});

test('page bridge checks course, closed, frozen and discarded tabs before injection',async()=>{
  for(const [options,message] of [
    [{tab:{id:17,url:'https://www.udemy.com/course/another/learn/lecture/456'}},/其他課程/],
    [{getError:new Error('No tab')},/關閉/],
    [{tab:{id:17,url:pageUrl,frozen:true}},/暫停/],
    [{tab:{id:17,url:pageUrl,discarded:true}},/暫停/]
  ]){
    const fixture=chromeFixture(options);const bridge=pageBridge(fixture.api,17,courseKey);
    await assert.rejects(bridge.attach(),message);await assert.rejects(bridge.call('capture',item),message);
    assert.equal(fixture.calls.length,0);
  }
});

test('page bridge attaches the adapter and forwards only its acknowledged value',async()=>{
  const fixture=chromeFixture({result:{ok:true,value:{complete:true}}});const bridge=pageBridge(fixture.api,17,courseKey);
  await bridge.attach();assert.deepEqual(fixture.calls[0].files,['course-adapter.js']);
  assert.deepEqual(await bridge.call('collect',null),{complete:true});
  assert.deepEqual(fixture.calls[1].args,['collect',null]);
  assert.equal(fixture.calls[1].target.tabId,17);
});

test('page bridge surfaces adapter and injection errors instead of accepting an empty result',async()=>{
  for(const [options,message] of [[{result:{ok:false,error:'Fixture stale page'}},/Fixture stale page/],[{result:null},/沒有回應/],[{scriptError:new Error('Denied')},/無法操作/]]){
    const fixture=chromeFixture(options);
    await assert.rejects(pageBridge(fixture.api,17,courseKey).call('capture',item),message);
  }
});

test('waitForStream returns a ready capture and rejects an expired deadline',async()=>{
  const ready={status:'ready',candidates:capture.candidates};
  assert.equal(await waitForStream({call:async()=>ready},item),ready);
  let calls=0;
  await assert.rejects(waitForStream({call:async()=>{calls++;return {status:'waiting'};}},item,{timeoutMs:0}),/逾時/);
  assert.equal(calls,0);
});

test('waitForStream preserves an inconclusive protection hint on timeout without leaking URLs',async t=>{
  let now=0;
  t.mock.method(Date,'now',()=>now);
  const waiting=[];
  await assert.rejects(waitForStream({call:async()=>({status:'pending',mediaKeysAttached:true,
    reason:'播放器已連接媒體保護模組；尚未取得清單，無法確認是否加密。 https://www.udemy.com/assets/555/a.m3u8?token=private'})},item,
    {timeoutMs:50,onWaiting:reason=>{waiting.push(reason);now=51;}}),error=>{
    assert.match(error.message,/播放器逾時/);
    assert.match(error.message,/無法確認是否加密/);
    assert.ok(!error.message.includes('token=private'));
    return true;
  });
  assert.equal(waiting.length,1);
  assert.ok(!waiting[0].includes('token=private'));
});

test('DASH-only observations explain the unsupported format and export only diagnostic scalars',async t=>{
  let now=0;
  t.mock.method(Date,'now',()=>now);
  const reports=[];
  const sourceDiagnostic={hlsCount:0,dashCount:1,playerReadyState:4,playerPaused:false,mediaKeysAttached:true,
    url:'https://udemycdn.com/a.mpd?token=private',license:'private'};
  await assert.rejects(waitForStream({call:async()=>({status:'pending',reason:'DASH source observed',sourceDiagnostic})},item,
    {timeoutMs:50,onWaiting:()=>{now=51;},onDiagnostic:report=>reports.push(report)}),error=>{
    assert.match(error.message,/不支援 DASH/);assert.doesNotMatch(error.message,/阻擋自動播放/);return true;
  });
  assert.deepEqual(reports,[{hlsCount:0,dashCount:1,playerReadyState:4,playerPaused:false,mediaKeysAttached:true}]);
});

test('malformed or mixed-format observations never become a DASH-only diagnosis',async t=>{
  let now=0;
  t.mock.method(Date,'now',()=>now);
  for(const sourceDiagnostic of [
    {hlsCount:1,dashCount:1,playerReadyState:4,playerPaused:false,mediaKeysAttached:true},
    {hlsCount:0,dashCount:1,playerReadyState:99,playerPaused:false,mediaKeysAttached:true}
  ]){
    now=0;
    await assert.rejects(waitForStream({call:async()=>({status:'pending',sourceDiagnostic})},item,
      {timeoutMs:50,onWaiting:()=>{now=51;}}),error=>!error.message.includes('不支援 DASH'));
  }
});

test('waitForStream cancels before capture and while waiting for player state',async()=>{
  const before=new AbortController();before.abort();let calls=0;
  await assert.rejects(waitForStream({call:async()=>{calls++;}},item,{signal:before.signal}),{name:'AbortError'});
  assert.equal(calls,0);
  const during=new AbortController();const waiting=[];
  await assert.rejects(waitForStream({call:async()=>({status:'waiting',reason:'Loading fixture'})},item,{signal:during.signal,onWaiting:reason=>{waiting.push(reason);during.abort();}}),{name:'AbortError'});
  assert.deepEqual(waiting,['Loading fixture']);
});

test('waitForStream rejects a ready capture when stop arrived during the capture call',async()=>{
  const controller=new AbortController();
  await assert.rejects(waitForStream({call:async()=>{controller.abort();return {status:'ready',candidates:capture.candidates};}},item,{signal:controller.signal}),{name:'AbortError'});
});

test('delay rejects an already aborted signal without waiting',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(delay(10000,controller.signal),{name:'AbortError'});
});

test('batch lock rejects duplicate source tab and duplicate course then releases both',async()=>{
  const locks=mockLocks();const started=deferred();const finish=deferred();
  const first=withBatchLock(locks,17,courseKey,async()=>{started.resolve();return finish.promise;});
  await started.promise;assert.equal(locks.held.size,2);let duplicates=0;
  await assert.rejects(withBatchLock(locks,17,courseKey+'-another',async()=>{duplicates++;}),/另一個/);
  await assert.rejects(withBatchLock(locks,18,courseKey,async()=>{duplicates++;}),/另一個/);
  assert.equal(duplicates,0);assert.equal(locks.held.size,2);
  finish.resolve('done');assert.equal(await first,'done');assert.equal(locks.held.size,0);
  assert.equal(await withBatchLock(locks,17,courseKey,async()=>'retry'),'retry');
});

test('batch locks release on failed actions and require browser lock support',async()=>{
  const locks=mockLocks();const failure=new Error('Fixture action failed');
  await assert.rejects(withBatchLock(locks,17,courseKey,async()=>{throw failure;}),error=>error===failure);
  assert.equal(locks.held.size,0);
  await assert.rejects(withBatchLock(null,17,courseKey,async()=>{}),/鎖定功能/);
});
