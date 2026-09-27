import {parsePlaylist} from './hls.mjs';

export function checkedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('無效的媒體網址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !/(^|\.)(udemy\.com|udemycdn\.com)$/i.test(url.hostname)) throw new Error('媒體來源不在支援的 Udemy 網域內。');
  return url.href;
}

// Redirects are only enabled inside an extension whose enforced CSP restricts
// every network hop to this exact HTTPS host list. Final-URL checks alone cannot
// prevent a request to an unwanted redirect destination.
export function redirectsAllowed(manifest) {
  const policy=manifest?.content_security_policy?.extension_pages;
  if(typeof policy!=='string') return false;
  const rules=policy.split(';').map(rule=>rule.trim().split(/\s+/)).filter(parts=>parts[0].toLowerCase()==='connect-src');
  const expected=['https://udemy.com','https://*.udemy.com','https://udemycdn.com','https://*.udemycdn.com'];
  return rules.length===1 && rules[0].length===5 && expected.every(source=>rules[0].slice(1).includes(source));
}

function phaseLabel(phase,segmentIndex,totalSegments) {
  return ({master:'主清單',variant:'畫質清單',revalidate:'儲存前重新檢查清單',segment:`影片片段 ${segmentIndex||'?'} / ${totalSegments||'?'}`})[phase]||'媒體';
}

export async function readResource(url, {signal, maxBytes, timeoutMs=45000, fetcher=fetch, permissionCheck, onDiagnostic=()=>{}, phase='media', segmentIndex, totalSegments, withMetadata=false} = {}) {
  checkedUrl(url);
  const host=new URL(url).hostname;
  const context=phaseLabel(phase,segmentIndex,totalSegments)+`（${host}）`;
  let stage='permission',httpStatus=null,permissionGranted=null;
  const report=extra=>onDiagnostic({phase,stage,host,segmentIndex,totalSegments,httpStatus,permissionGranted,...extra});
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort,timeoutMs);
  let reader;
  let completed=false;
  try {
    if(permissionCheck) {
      permissionGranted=await permissionCheck(new URL(url).origin+'/*');
      if(!permissionGranted) {report({code:'HOST_PERMISSION_MISSING'});throw new Error(`${context}缺少網域讀取權限；請重新按「授權並檢查清單」。`);}
    }
    if(controller.signal.aborted) throw new Error('已取消。');
    stage='fetch';
    const redirect=globalThis.location?.protocol==='chrome-extension:' && redirectsAllowed(globalThis.chrome?.runtime?.getManifest?.())?'follow':'error';
    report({code:'REQUEST',redirectMode:redirect});
    const response = await fetcher(url,{credentials:'include',redirect,cache:'no-store',signal:controller.signal});
    httpStatus=response.status;
    const finalUrl=checkedUrl(response.url||url);
    report({code:'RESPONSE',redirected:Boolean(response.redirected),finalHost:new URL(finalUrl).hostname});
    if (/^\/(?:join|login|signin)(?:\/|$)/i.test(new URL(finalUrl).pathname)) throw new Error(`${context}被導向登入頁，請回 Udemy 確認登入與課程存取。`);
    if (!response.ok) {
      if ([401,403].includes(response.status)) throw new Error(`${context}存取已過期或被拒絕（HTTP ${response.status}），請回課程頁重新播放後再檢查。`);
      throw new Error(`${context}請求失敗（HTTP ${response.status}）。請稍後重試。`);
    }
    if (/\btext\/html\b/i.test(response.headers.get('content-type')||'')) throw new Error(`${context}回傳網頁，沒有回傳媒體；可能是登入頁或網站驗證頁，請回 Udemy 查看。`);
    if (!response.body) throw new Error('伺服器沒有回傳媒體內容。');
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) throw new Error('單一檔案超過此工具的大小上限。');
    stage='body';
    reader = response.body.getReader();
    const chunks=[];
    let length=0;
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      length+=value.length;
      if (length>maxBytes) throw new Error('單一檔案超過此工具的大小上限。');
      chunks.push(value);
    }
    if (controller.signal.aborted) throw new Error('請求已取消或逾時。');
    const bytes=new Uint8Array(length);
    let offset=0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    completed=true;
    report({code:'READ_OK',bytes:length,finalHost:new URL(finalUrl).hostname});
    return withMetadata?{bytes,url:finalUrl}:bytes;
  } catch (error) {
    if (controller.signal.aborted) {report({code:signal?.aborted?'CANCELLED':'TIMEOUT'});throw new Error(signal?.aborted?'已取消。':`${context}請求逾時，請檢查網路後重試。`);}
    if (error instanceof TypeError) {
      report({code:stage==='body'?'BODY_READ_FAILED':'NETWORK_FAILED'});
      throw new Error(`${context}${stage==='body'?'回應中途讀取失敗':'未取得可讀取的回應'}。請將下方「錯誤診斷」內容貼回，才能區分網路、瀏覽器限制或轉址問題。`);
    }
    throw error;
  } finally {
    if(!completed) controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
    if (reader) {try{await reader.cancel();}catch{/* already closed */}reader.releaseLock();}
  }
}

export async function loadPlaylist(url, options={}) {
  const resource=await readResource(url,{...options,maxBytes:2*1024*1024,withMetadata:true});
  return parsePlaylist(new TextDecoder('utf-8',{fatal:true}).decode(resource.bytes),resource.url);
}

export function validateTransportStream(bytes) {
  if (bytes.length<188*3 || bytes.length%188!==0) throw new Error('影片片段不是支援的 MPEG-TS 格式，已停止儲存。');
  for(let i=0;i<bytes.length;i+=188) {
    if(bytes[i]!==0x47 || (bytes[i+1]&0x80) || !(bytes[i+3]&0x30)) throw new Error('影片片段格式不符或含錯誤封包，已停止儲存。');
    if(bytes[i+3]&0xc0) throw new Error('影片封包標示加密，已停止儲存；此工具不處理解密。');
  }
}

export async function saveMedia(media, writable, {signal,onProgress=()=>{},fetcher=fetch,permissionCheck,onDiagnostic}={}) {
  let bytes=0;
  try {
    if(media.type!=='media'||!media.segments.length) throw new Error('尚未通過影片清單檢查。');
    for(let i=0;i<media.segments.length;i++) {
      if(signal?.aborted) throw new Error('已取消。');
      const chunk=await readResource(media.segments[i].url,{signal,maxBytes:64*1024*1024,fetcher,permissionCheck,onDiagnostic,phase:'segment',segmentIndex:i+1,totalSegments:media.segments.length});
      validateTransportStream(chunk);
      if(signal?.aborted) throw new Error('已取消。');
      await writable.write(chunk);
      bytes+=chunk.length;
      onProgress({completed:i+1,total:media.segments.length,bytes});
    }
    if(signal?.aborted) throw new Error('已取消。');
    await writable.close();
    return {bytes,segments:media.segments.length};
  } catch(error) {
    try{await writable.abort();}catch{/* original error takes priority */}
    throw error;
  }
}

export function safeFilename(value) {
  const name=String(value||'udemy-lecture').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,120);
  return (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)?`_${name}`:name||'udemy-lecture')+'.ts';
}
