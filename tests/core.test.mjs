import test from 'node:test';
import assert from 'node:assert/strict';
import {supportedPage, summarize, safeReport} from '../extension/core.mjs';

test('allow only HTTPS Udemy course player pages', () => {
  assert.equal(supportedPage('https://www.udemy.com/course/aspnet-core-api/learn/lecture/22112428#overview'), true);
  for (const url of ['https://udemy.com.evil.test/course/x/learn/', 'https://eviludemy.com/course/x/learn/', 'http://www.udemy.com/course/x/learn/', 'https://www.udemy.com/join/login/', 'https://a:b@www.udemy.com/course/x/learn/', 'not a url']) assert.equal(supportedPage(url), false, url);
});
test('missing control is unknown, disabled control is unavailable', () => {
  const base = {loggedOut:false,hasVideo:true,downloads:[]};
  assert.equal(summarize(base).tone, 'neutral');
  assert.equal(summarize({...base,downloads:[{kind:'lecture',disabled:true}]}).tone,'warning');
  assert.equal(summarize({...base,downloads:[{kind:'lecture',disabled:false}]}).tone,'success');
  assert.equal(summarize({...base,loggedOut:true}).title,'需要登入');
});
test('export excludes signed URLs, internal IDs and page queries', () => {
  const report = safeReport({pageUrl:'https://www.udemy.com/course/x/learn/lecture/1?secret=123#overview',courseTitle:'Test',lectureTitle:'One',lectureId:'1',downloads:[{id:'internal',label:'下載講座',kind:'lecture',disabled:true,url:'https://cdn.test/video?token=abc'}],lectures:[{title:'two',url:'https://www.udemy.com/course/x/learn/lecture/2?token=secret'}],notes:[]});
  const text = JSON.stringify(report);
  for (const secret of ['secret','token','internal','cdn.test']) assert.ok(!text.includes(secret));
  assert.equal(report.officialDownloads[0].available,false);
});
