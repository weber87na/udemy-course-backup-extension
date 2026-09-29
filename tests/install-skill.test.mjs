import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,link,lstat,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installSkill,parseInstallArgs} from '../scripts/install-skill.mjs';

const exec=promisify(execFile);
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const name='udemy-course-backup';
const owned=['SKILL.md','agents/openai.yaml','scripts/run.mjs'];
const wrapperEnv=override=>({...process.env,UDEMY_BACKUP_HOME:override||''});

async function fixture(t){
  const tempRoot=resolve(tmpdir());
  const base=await mkdtemp(join(tempRoot,'udemy-skill-test-'));
  t.after(async()=>{
    assert.equal(resolve(base),base);
    assert.equal(dirname(base),tempRoot);
    assert.ok(basename(base).startsWith('udemy-skill-test-'));
    await rm(base,{recursive:true,force:true});
  });
  const projectDir=join(base,'project with spaces');
  const source=join(projectDir,'skills',name);
  await mkdir(join(source,'agents'),{recursive:true});
  await mkdir(join(source,'scripts'),{recursive:true});
  await mkdir(join(projectDir,'cli'),{recursive:true});
  for(const file of owned)await copyFile(join(repo,'skills',name,file),join(source,file));
  await writeFile(join(projectDir,'cli','index.mjs'),'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  return {base,projectDir,source,dest:join(base,'installed skill')};
}

async function assertAbsent(path){await assert.rejects(lstat(path),{code:'ENOENT'});}

test('installer copies an exact allowlist, writes local project config and never copies source extras',async t=>{
  const {projectDir,source,dest}=await fixture(t);
  await writeFile(join(source,'private-notes.txt'),'must remain in source');
  assert.equal(await installSkill({projectDir,dest}),dest);
  assert.deepEqual((await readdir(dest)).sort(),['SKILL.md','agents','local-config.json','scripts']);
  assert.deepEqual(await readdir(join(dest,'agents')),['openai.yaml']);
  assert.deepEqual(await readdir(join(dest,'scripts')),['run.mjs']);
  assert.deepEqual(JSON.parse(await readFile(join(dest,'local-config.json'),'utf8')),{projectDir});
  for(const file of owned)assert.deepEqual(await readFile(join(dest,file)),await readFile(join(source,file)));
  await assertAbsent(join(dest,'private-notes.txt'));
});

test('installed wrapper preserves caller cwd, JSON stdout and literal Unicode/shell-like arguments',async t=>{
  const {base,projectDir,dest}=await fixture(t);
  await installSkill({projectDir,dest});
  const cwd=join(base,'caller directory');await mkdir(cwd);
  const args=['scan','https://www.udemy.com/course/fixture/learn/lecture/1?one=1&two=2','--json','--out','./backup','quote"value','$(keep-literal)','`literal`','中文 空格'];
  const {stdout,stderr}=await exec(process.execPath,[join(dest,'scripts','run.mjs'),...args],{cwd,env:wrapperEnv()});
  assert.deepEqual(JSON.parse(stdout),{args,cwd});
  assert.equal(stderr,'');
});

test('repository wrapper finds its own CLI without a generated local config',async t=>{
  const {projectDir,source}=await fixture(t);
  const {stdout}=await exec(process.execPath,[join(source,'scripts','run.mjs'),'--help'],{cwd:projectDir,env:wrapperEnv()});
  assert.deepEqual(JSON.parse(stdout),{args:['--help'],cwd:projectDir});
});

test('wrapper honors the explicit Udemy project override before local config and preserves child exit statuses',async t=>{
  const {base,projectDir,dest}=await fixture(t);await installSkill({projectDir,dest});
  await writeFile(join(dest,'local-config.json'),'{not valid fixture config}');
  const override=join(base,'override project');await mkdir(join(override,'cli'),{recursive:true});
  for(const code of [1,7,130]){
    await writeFile(join(override,'cli','index.mjs'),`process.stderr.write('fixture child error');process.exitCode=${code};`);
    await assert.rejects(exec(process.execPath,[join(dest,'scripts','run.mjs'),'--help'],{env:wrapperEnv(override)}),error=>{
      assert.equal(error.code,code);assert.equal(error.stdout,'');assert.equal(error.stderr,'fixture child error');return true;
    });
  }
});

test('wrapper reports malformed or relative config safely and does not fall back to an unrelated project',async t=>{
  const {projectDir,dest}=await fixture(t);await installSkill({projectDir,dest});
  const secret='fixture-not-a-real-secret';
  for(const content of [`{broken ${secret}`,JSON.stringify({projectDir:secret}),JSON.stringify({projectDir:null})]){
    await writeFile(join(dest,'local-config.json'),content);
    await assert.rejects(exec(process.execPath,[join(dest,'scripts','run.mjs'),'--help'],{cwd:projectDir,env:wrapperEnv()}),error=>{
      assert.equal(error.code,1);assert.equal(error.stdout,'');assert.match(error.stderr,/技能設定無效/);assert.equal(error.stderr.includes(secret),false);return true;
    });
  }
});

test('wrapper reports a moved or missing CLI without echoing its local config contents',async t=>{
  const {base,projectDir,dest}=await fixture(t);await installSkill({projectDir,dest});
  const missing=join(base,'fixture-private-location');await writeFile(join(dest,'local-config.json'),JSON.stringify({projectDir:missing}));
  await assert.rejects(exec(process.execPath,[join(dest,'scripts','run.mjs'),'--help'],{env:wrapperEnv()}),error=>{
    assert.equal(error.code,1);assert.equal(error.stdout,'');assert.match(error.stderr,/找不到 Udemy 備份 CLI/);assert.equal(error.stderr.includes(missing),false);return true;
  });
});

test('force updates only managed files and preserves unrelated nested user data',async t=>{
  const {projectDir,source,dest}=await fixture(t);await installSkill({projectDir,dest});
  await mkdir(join(dest,'notes'));await writeFile(join(dest,'notes','keep.txt'),'keep nested');
  await writeFile(join(dest,'scripts','custom.mjs'),'keep custom');
  await writeFile(join(dest,'local-config.json'),JSON.stringify({projectDir:'fixture-old'}));
  await writeFile(join(source,'agents','openai.yaml'),'interface:\n  display_name: "Updated fixture"\n');
  await assert.rejects(installSkill({projectDir,dest}),/--force/);
  await installSkill({projectDir,dest,force:true});
  assert.equal(await readFile(join(dest,'notes','keep.txt'),'utf8'),'keep nested');
  assert.equal(await readFile(join(dest,'scripts','custom.mjs'),'utf8'),'keep custom');
  assert.equal(await readFile(join(dest,'agents','openai.yaml'),'utf8'),'interface:\n  display_name: "Updated fixture"\n');
  assert.deepEqual(JSON.parse(await readFile(join(dest,'local-config.json'),'utf8')),{projectDir});
});

test('force refuses an existing Duotify skill or non-skill directory without any write',async t=>{
  const {base,projectDir,dest}=await fixture(t);
  await mkdir(dest);const original='---\nname: course-backup\ndescription: Duotify fixture\n---\nPreserve this skill.\n';
  await writeFile(join(dest,'SKILL.md'),original);
  await assert.rejects(installSkill({projectDir,dest,force:true}),/不同技能/);
  assert.equal(await readFile(join(dest,'SKILL.md'),'utf8'),original);
  assert.deepEqual(await readdir(dest),['SKILL.md']);
  const unrelated=join(base,'unrelated');await mkdir(unrelated);await writeFile(join(unrelated,'keep.txt'),'safe');
  await assert.rejects(installSkill({projectDir,dest:unrelated,force:true}),/不同技能/);
  assert.deepEqual(await readdir(unrelated),['keep.txt']);
});

test('default install uses a distinct Udemy skill destination and preserves the Duotify sibling',async t=>{
  const {base,projectDir}=await fixture(t);const codexRoot=join(base,'codex-home');const duotify=join(codexRoot,'skills','course-backup');
  await mkdir(duotify,{recursive:true});await writeFile(join(duotify,'SKILL.md'),'Duotify fixture sentinel');
  const previous=process.env.CODEX_HOME;
  try{
    process.env.CODEX_HOME=codexRoot;
    const target=await installSkill({projectDir});
    assert.equal(target,join(codexRoot,'skills',name));
    assert.equal(await readFile(join(duotify,'SKILL.md'),'utf8'),'Duotify fixture sentinel');
  }finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});

test('missing or wrongly named source is rejected before creating a destination',async t=>{
  const {projectDir,source,dest}=await fixture(t);
  await writeFile(join(source,'SKILL.md'),'---\nname: course-backup\ndescription: wrong source\n---\n');
  await assert.rejects(installSkill({projectDir,dest}),/完整 Udemy 技能/);await assertAbsent(dest);
  await copyFile(join(repo,'skills',name,'SKILL.md'),join(source,'SKILL.md'));
  await rm(join(projectDir,'cli','index.mjs'));
  await assert.rejects(installSkill({projectDir,dest}),/完整 Udemy 技能/);await assertAbsent(dest);
});

test('installer refuses destination overlap with its own source',async t=>{
  const {projectDir,source}=await fixture(t);
  for(const dest of [source,join(source,'nested-copy'),dirname(source)])await assert.rejects(installSkill({projectDir,dest,force:true}),/互相包含/);
  await assertAbsent(join(source,'nested-copy'));await assertAbsent(join(source,'local-config.json'));
});

test('installer rejects a destination junction and a junction in an ancestor',async t=>{
  const {base,projectDir,dest}=await fixture(t);const outside=join(base,'junction target');await mkdir(outside);
  await symlink(outside,dest,process.platform==='win32'?'junction':'dir');
  await assert.rejects(installSkill({projectDir,dest,force:true}),/符號連結/);
  await assert.rejects(installSkill({projectDir,dest:join(dest,'nested'),force:true}),/符號連結/);
  assert.deepEqual(await readdir(outside),[]);
});

test('installer rejects a managed subdirectory junction before updating any skill file',async t=>{
  const {base,projectDir,dest}=await fixture(t);await mkdir(dest);
  const original='---\nname: udemy-course-backup\ndescription: old\n---\nDo not change yet.\n';await writeFile(join(dest,'SKILL.md'),original);
  const outside=join(base,'outside scripts');await mkdir(outside);
  await symlink(outside,join(dest,'scripts'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(installSkill({projectDir,dest,force:true}),/符號連結/);
  assert.equal(await readFile(join(dest,'SKILL.md'),'utf8'),original);assert.deepEqual(await readdir(outside),[]);
});

test('installer rejects an incompatible managed file before updating any other file',async t=>{
  const {projectDir,dest}=await fixture(t);await installSkill({projectDir,dest});
  const original=await readFile(join(dest,'SKILL.md'));await rm(join(dest,'local-config.json'));await mkdir(join(dest,'local-config.json'));
  await assert.rejects(installSkill({projectDir,dest,force:true}),/不相容/);
  assert.deepEqual(await readFile(join(dest,'SKILL.md')),original);
});

test('installer rejects a managed file hardlink without changing the external file',async t=>{
  const {base,projectDir,dest}=await fixture(t);await installSkill({projectDir,dest});
  const original=await readFile(join(dest,'SKILL.md'));const outside=join(base,'outside-wrapper.mjs');
  await writeFile(outside,'preserve external wrapper');await rm(join(dest,'scripts','run.mjs'));await link(outside,join(dest,'scripts','run.mjs'));
  await assert.rejects(installSkill({projectDir,dest,force:true}),/硬連結/);
  assert.equal(await readFile(outside,'utf8'),'preserve external wrapper');assert.deepEqual(await readFile(join(dest,'SKILL.md')),original);
});

test('installer arguments distinguish destination folder and force from unsupported flags',()=>{
  assert.deepEqual(parseInstallArgs([]),{});
  assert.deepEqual(parseInstallArgs(['--dest','folder with spaces','--force']),{dest:'folder with spaces',force:true});
  assert.deepEqual(parseInstallArgs(['--help']),{help:true});
  for(const args of [['--dest'],['--dest','--force'],['--dest','a','--dest','b'],['--force','--force'],['--unknown']])assert.throws(()=>parseInstallArgs(args),/不支援/);
});
