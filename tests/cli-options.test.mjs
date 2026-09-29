import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {parseCourseUrl,parseOptions,selectLectures,catalogEntries} from '../cli/options.mjs';

const url='https://www.udemy.com/course/fixture-course/learn/lecture/12';
const catalog={complete:true,pageUrl:url,sections:[
  {sectionIndex:1,title:'第一章',items:[{key:'11',lectureId:'11',title:'教材',index:1,kind:'article'},{key:'12',lectureId:'12',title:'影片 A',index:2,kind:'video'}]},
  {sectionIndex:2,title:'第二章',items:[{key:'13',lectureId:'13',title:'影片 B',index:1,kind:'video'},{key:'14',lectureId:'14',title:'影片 C',index:2,kind:'video'}]}
]};
test('course URL normalization accepts player and multilingual course URLs without queries',()=>{
  assert.equal(parseCourseUrl('https://www.udemy.com/course/fixture-course/?couponCode=example#overview').url,'https://www.udemy.com/course/fixture-course/learn/');
  assert.equal(parseCourseUrl(url+'/#overview').lectureId,'12');
  assert.ok(parseCourseUrl('https://www.udemy.com/course/法文課程/').url.includes('%E6'));
  assert.equal(parseCourseUrl(url+'?token=fixture').url,url);
  assert.equal(parseCourseUrl('https://company.udemy.com/course/slug/learn/').origin,'https://company.udemy.com');
});
test('course routing rejects unsupported origins, internal pages and escaped path boundaries',()=>{
  for(const invalid of ['http://www.udemy.com/course/a/','chrome://extensions','chrome-extension://id/a','https://udemy.com.evil/course/a/','https://u:p@www.udemy.com/course/a/','https://www.udemy.com:444/course/a/','https://www.udemy.com/course/a//','https://www.udemy.com/course/a/learn/quiz/1','https://www.udemy.com/course/a%2Fb/','https://www.udemy.com/course/bad%00/','https://www.udemy.com/course/%XX/'])assert.throws(()=>parseCourseUrl(invalid));
});
test('CLI resolves output relative to caller and uses existing Chrome without widening selection',()=>{
  const options=parseOptions(['download',url,'--out','backup'],'D:/fixture');
  assert.equal(options.outputDir,resolve('D:/fixture','backup'));assert.equal(options.browser,'existing');assert.equal(options.all,false);assert.equal(options.waitLoginMs,600000);
  assert.deepEqual(selectLectures(catalog,options).map(item=>item.lectureId),['12']);
  assert.equal(parseOptions([]).command,'help');assert.equal(parseOptions(['--version']).command,'version');
});
test('section and global lecture selectors stay ordered when displayed lecture prefixes repeat',()=>{
  assert.deepEqual(catalogEntries(catalog).map(item=>item.number),[1,2,3,4]);
  assert.deepEqual(selectLectures(catalog,parseOptions(['download',url,'--chapters','2,1,2'])).map(item=>item.lectureId),['12','13','14']);
  assert.deepEqual(selectLectures(catalog,parseOptions(['download',url,'--lectures','4,2'])).map(item=>item.lectureId),['12','14']);
  assert.deepEqual(selectLectures(catalog,parseOptions(['download',url,'--all'])).map(item=>item.lectureId),['12','13','14']);
  assert.throws(()=>selectLectures(catalog,parseOptions(['download',url,'--lectures','1'])),/只下載影片/);
  assert.throws(()=>selectLectures(catalog,parseOptions(['download',url,'--chapters','3'])),/範圍/);
  assert.throws(()=>selectLectures({...catalog,complete:false},parseOptions(['download',url,'--all'])),/尚未完整/);
});
test('conflicting, unsupported and malformed flags fail before any browser work',()=>{
  for(const flags of [['--all','--chapters','1'],['--lectures','1','--chapters','1'],['--chapters','0'],['--chapters','1-3'],['--lectures','-1'],['--max-height','0'],['--max-height','NaN'],['--wait-login','3601'],['--quality','1080'],['--browser','chrome'],['--out',' '],['--title','title']])assert.throws(()=>parseOptions(['download',url,...flags]));
  assert.throws(()=>parseOptions(['scan',url,'--out','file']));assert.throws(()=>parseOptions(['scan',url,'--all']));
  assert.throws(()=>parseOptions(['download',url,'extra']));
});
test('direct HLS is anonymous and limited to Udemy sources; course flags cannot leak into it',()=>{
  const media='https://hls-c.udemycdn.com/assets/example.m3u8?token=fixture';
  assert.equal(parseOptions(['download','--media',media,'--title','name']).url,media);
  assert.throws(()=>parseOptions(['download','--media','https://example.com/file.m3u8']));
  for(const flags of [['--browser','existing'],['--all'],['--chapters','1'],['--wait-login','10']])assert.throws(()=>parseOptions(['download','--media',media,...flags]));
  assert.throws(()=>parseOptions(['scan','--media',media]));assert.throws(()=>parseOptions(['download',url,'--media',media]));
});
