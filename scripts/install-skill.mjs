#!/usr/bin/env node
import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,parse,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const skillName='udemy-course-backup';
const ownedFiles=['SKILL.md','agents/openai.yaml','scripts/run.mjs'];

async function info(path){
  try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function checkPath(path,directory){
  const found=await info(path);
  if(found&&(found.isSymbolicLink()||(directory?!found.isDirectory():!found.isFile())))throw new Error('技能路徑含有符號連結或不相容的檔案，未進行安裝。');
  return found;
}

async function checkAncestors(directory){
  const full=resolve(directory),root=parse(full).root;
  let current=root;
  await checkPath(current,true);
  for(const component of relative(root,full).split(/[\\/]/).filter(Boolean)){
    current=join(current,component);await checkPath(current,true);
  }
}

function within(path,parent){
  const rel=relative(parent,path);
  return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../'));
}

function hasSkillName(markdown){
  const frontmatter=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]||'';
  const names=frontmatter.split(/\r?\n/).filter(line=>/^name\s*:/.test(line));
  return names.length===1&&/^name:\s*(?:udemy-course-backup|"udemy-course-backup"|'udemy-course-backup')\s*$/.test(names[0]);
}

export async function installSkill({dest,force=false,projectDir=repoDir}={}){
  const project=resolve(projectDir),source=join(project,'skills',skillName);
  const codexRoot=process.env.CODEX_HOME?.trim()||join(homedir(),'.codex');
  const target=resolve(dest??join(codexRoot,'skills',skillName));
  if(within(target,source)||within(source,target))throw new Error('安裝目的地不可與技能來源相同或互相包含。');

  // Validate every source and destination component before changing any file.
  await checkAncestors(source);
  await checkAncestors(join(source,'agents'));
  await checkAncestors(join(source,'scripts'));
  await checkAncestors(join(project,'cli'));
  const inputs=new Map();
  for(const file of ownedFiles){
    const entry=join(source,file),found=await checkPath(entry,false);
    if(!found)throw new Error('專案缺少完整 Udemy 技能或 CLI 檔案，未進行安裝。');
    inputs.set(file,await readFile(entry));
  }
  if(!await checkPath(join(project,'cli','index.mjs'),false)||!hasSkillName(inputs.get('SKILL.md').toString('utf8')))throw new Error('專案缺少完整 Udemy 技能或 CLI 檔案，未進行安裝。');
  await checkAncestors(target);
  const existing=await info(target);
  if(existing&&(await readdir(target)).length){
    await checkPath(join(target,'SKILL.md'),false);
    let previous='';
    try{previous=await readFile(join(target,'SKILL.md'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!hasSkillName(previous))throw new Error('目的地已包含其他內容或不同技能，不會覆寫；請用 --dest 指定新的技能資料夾。');
    if(!force)throw new Error('udemy-course-backup 技能已存在；更新此技能請加上 --force。');
  }
  for(const subdir of ['agents','scripts'])await checkPath(join(target,subdir),true);
  for(const file of [...ownedFiles,'local-config.json']){
    const found=await checkPath(join(target,file),false);
    if(found?.nlink>1)throw new Error('技能目的地的受管檔案含有硬連結，為保留其他資料未進行安裝。');
  }

  await mkdir(join(target,'agents'),{recursive:true});
  await mkdir(join(target,'scripts'),{recursive:true});
  for(const [file,contents] of inputs)await writeFile(join(target,file),contents);
  await writeFile(join(target,'local-config.json'),JSON.stringify({projectDir:project},null,2)+'\n','utf8');
  return target;
}

export function parseInstallArgs(args){
  const options={};
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--help'||arg==='-h')return {help:true};
    if(arg==='--force'&&!options.force){options.force=true;continue;}
    if(arg==='--dest'&&!options.dest&&args[index+1]&&!args[index+1].startsWith('--')){options.dest=args[++index];continue;}
    throw new Error('不支援的參數；請執行 node scripts/install-skill.mjs --help。');
  }
  return options;
}

async function main(args){
  const options=parseInstallArgs(args);
  if(options.help){
    console.log('用法：node scripts/install-skill.mjs [--dest SKILL_DIR] [--force]\n預設安裝到 $CODEX_HOME/skills/udemy-course-backup（未設定時使用 ~/.codex）。\n--dest 指定技能資料夾本身；--force 只更新同名技能的受管檔案，保留其他內容。');return;
  }
  const target=await installSkill(options);
  console.log('已安裝 udemy-course-backup 技能：'+target);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
