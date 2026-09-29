#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const skillDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');

async function projectPath(){
  if(process.env.UDEMY_BACKUP_HOME?.trim())return resolve(process.env.UDEMY_BACKUP_HOME);
  try{
    const config=JSON.parse(await readFile(resolve(skillDir,'local-config.json'),'utf8'));
    if(typeof config.projectDir!=='string'||!config.projectDir.trim()||!isAbsolute(config.projectDir))throw new Error('Invalid project directory');
    return resolve(config.projectDir);
  }catch(error){
    if(error.code!=='ENOENT')throw new Error('Udemy 技能設定無效，請從專案重新執行 scripts/install-skill.mjs --force。');
  }
  return resolve(skillDir,'..','..');
}

async function main(){
  const entry=resolve(await projectPath(),'cli','index.mjs');
  if(!await stat(entry).then(info=>info.isFile(),()=>false))throw new Error('找不到 Udemy 備份 CLI；請重新安裝技能，或將 UDEMY_BACKUP_HOME 設為專案資料夾。');
  const child=spawn(process.execPath,[entry,...process.argv.slice(2)],{
    cwd:process.cwd(),stdio:'inherit',shell:false,windowsHide:true
  });
  let cancelled=false,settled=false;
  const handlers=new Map();
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']){
    const handler=()=>{
      cancelled=true;
      if(child.exitCode===null&&child.signalCode===null){try{child.kill(signal);}catch{/* Child completion decides the final status. */}}
    };
    handlers.set(signal,handler);process.on(signal,handler);
  }
  const clean=()=>{for(const [signal,handler] of handlers)process.off(signal,handler);};
  child.once('error',()=>{
    if(settled)return;settled=true;clean();
    console.error('無法啟動 Udemy 備份 CLI，請確認 Node.js 與專案路徑。');process.exitCode=1;
  });
  child.once('close',(code,signal)=>{
    if(settled)return;settled=true;clean();
    process.exitCode=cancelled?130:code??(['SIGINT','SIGTERM','SIGHUP'].includes(signal)?130:1);
  });
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
