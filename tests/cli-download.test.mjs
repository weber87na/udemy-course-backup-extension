import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, basename, resolve} from 'node:path';
import {downloadLecture} from '../cli/download.mjs';
import {createSessionFetch} from '../cli/network.mjs';
import {lectureDownloadPath} from '../extension/batch-core.mjs';

const origin = 'https://stream.udemycdn.com';
const url = `${origin}/course/list.m3u8?token=private-secret`;
const lecture = {key: 'lecture:123', lectureId: '123', title: '離線測試', sectionIndex: 1, sectionTitle: '章節', lectureIndex: 1};
const baseArgs = {item: lecture, courseTitle: '測試課程', courseKey: 'offline-course', capture: {candidates: [{url}]}};
const media = (...uris) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', ...uris.flatMap(uri => ['#EXTINF:2,', uri]), '#EXT-X-ENDLIST'].join('\n');

function ts(seed = 0) {
  const bytes = new Uint8Array(188 * 3).fill(seed);
  for (let offset = 0; offset < bytes.length; offset += 188) {
    bytes[offset] = 0x47; bytes[offset + 1] = 0; bytes[offset + 3] = 0x10;
  }
  return bytes;
}

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'udemy-cli-test-'));
  t.after(async () => {
    // Recursively delete only this test's uniquely allocated temp directory.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('udemy-cli-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}

function mappedFetch(routes, calls = []) {
  return createSessionFetch({fetchImpl: async (value, options) => {
    calls.push(value);
    if (!(value in routes)) throw new Error('Unexpected URL with private-secret');
    const result = typeof routes[value] === 'function' ? await routes[value](value, options) : routes[value];
    return result instanceof Response ? result : new Response(result);
  }});
}

async function allFiles(root) {
  const entries = await readdir(root, {withFileTypes: true});
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}

test('clear VOD downloads valid TS bytes and atomically publishes only one final file', async t => {
  const outputDir = await temp(t), calls = [], progress = [];
  const fetcher = mappedFetch({[url]: media('one.ts', 'two.ts'), [`${origin}/course/one.ts`]: ts(1), [`${origin}/course/two.ts`]: ts(2)}, calls);
  const result = await downloadLecture({...baseArgs, outputDir, fetcher, onProgress: value => progress.push(value)});
  assert.equal(result.status, 'completed');
  assert.equal(result.bytes, 1128);
  assert.equal(result.segments, 2);
  assert.deepEqual(await readFile(result.path), Buffer.concat([ts(1), ts(2)]));
  assert.deepEqual(await allFiles(outputDir), [result.path]);
  assert.equal(progress.at(-1).completed, 2);
  assert.ok(calls.slice(1).every(value => !value.includes('token=')));
  assert.ok(!result.path.includes('private-secret'));
});

test('final redirect URL supplies media relative URL resolution', async t => {
  const outputDir = await temp(t), calls = [];
  const fetcher = mappedFetch({
    [url]: new Response('', {status: 302, headers: {location: '/new/location.m3u8?own=1'}}),
    [`${origin}/new/location.m3u8?own=1`]: media('one.ts'), [`${origin}/new/one.ts`]: ts()
  }, calls);
  const result = await downloadLecture({...baseArgs, outputDir, fetcher});
  assert.equal(result.status, 'completed');
  assert.equal(calls.at(-1), `${origin}/new/one.ts`);
});

test('encrypted, fMP4, live and malformed playlists never create media or temporary files', async t => {
  const outputDir = await temp(t);
  for (const text of [
    media('a.ts').replace('#EXTINF:2,', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,'),
    media('a.ts').replace('#EXTINF:2,', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,'),
    media('a.ts').replace('\n#EXT-X-ENDLIST', ''), '<html>login</html>'
  ]) {
    const calls = [];
    await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher: mappedFetch({[url]: text}, calls)}));
    assert.deepEqual(calls, [url]);
    assert.deepEqual(await allFiles(outputDir), []);
  }
});

test('invalid or failed later TS segments clean only this download part and never publish', async t => {
  const outputDir = await temp(t);
  const unrelated = join(outputDir, '.someone-else.part');
  await writeFile(unrelated, 'leave me');
  for (const second of [new Uint8Array(10), () => { throw new Error('private-secret'); }]) {
    const fetcher = mappedFetch({[url]: media('one.ts', 'two.ts'), [`${origin}/course/one.ts`]: ts(), [`${origin}/course/two.ts`]: second});
    await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher}), error => !error.message.includes('private-secret'));
    assert.deepEqual(await allFiles(outputDir), [unrelated]);
    assert.equal(await readFile(unrelated, 'utf8'), 'leave me');
  }
});

test('scrambled transport packets are rejected before any output file is opened', async t => {
  const outputDir = await temp(t);
  const encrypted = ts(); encrypted[3] |= 0x80;
  await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher: mappedFetch({[url]: media('a.ts'), [`${origin}/course/a.ts`]: encrypted})}), /加密/);
  assert.deepEqual(await allFiles(outputDir), []);
});

test('existing nonempty files are unverified skips without network; zero-byte files remain untouched', async t => {
  const outputDir = await temp(t);
  const path = join(outputDir, lectureDownloadPath(lecture, baseArgs));
  await mkdir(dirname(path), {recursive: true});
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('must not run'); };
  await writeFile(path, 'existing');
  const result = await downloadLecture({...baseArgs, outputDir, fetcher});
  assert.equal(result.status, 'skipped'); assert.equal(result.verified, false); assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), 'existing');
  await writeFile(path, '');
  await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher}), /空白檔案/);
  assert.equal((await readFile(path)).length, 0);
  assert.equal(calls, 0);
});

test('a competing file appearing before publication is never overwritten', async t => {
  const outputDir = await temp(t);
  const path = join(outputDir, lectureDownloadPath(lecture, baseArgs));
  let created;
  const fetcher = mappedFetch({[url]: media('one.ts', 'two.ts'), [`${origin}/course/one.ts`]: ts(), [`${origin}/course/two.ts`]: async () => {
    await writeFile(path, 'other writer won', {flag: 'wx'}); created = true; return ts();
  }});
  const result = await downloadLecture({...baseArgs, outputDir, fetcher});
  assert.equal(created, true);
  assert.equal(result.status, 'skipped'); assert.equal(result.verified, false);
  assert.equal(await readFile(path, 'utf8'), 'other writer won');
  assert.deepEqual(await allFiles(outputDir), [path]);
});

test('a competing zero-byte destination also survives publication failure unchanged', async t => {
  const outputDir = await temp(t);
  const path = join(outputDir, lectureDownloadPath(lecture, baseArgs));
  const fetcher = mappedFetch({[url]: media('one.ts', 'two.ts'), [`${origin}/course/one.ts`]: ts(), [`${origin}/course/two.ts`]: async () => {
    await writeFile(path, '', {flag: 'wx'}); return ts();
  }});
  await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher}), /空白檔案/);
  assert.equal((await readFile(path)).length, 0);
  assert.deepEqual(await allFiles(outputDir), [path]);
});

test('abort after a validated write removes its part and leaves no formal file', async t => {
  const outputDir = await temp(t), controller = new AbortController();
  const fetcher = mappedFetch({[url]: media('one.ts', 'two.ts'), [`${origin}/course/one.ts`]: ts(), [`${origin}/course/two.ts`]: ts()});
  await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher, signal: controller.signal, onProgress: () => controller.abort()}), {name: 'AbortError'});
  assert.deepEqual(await allFiles(outputDir), []);
});

test('best/worst use arbitrary maxHeight cap and never silently exceed it', async t => {
  const outputDir = await temp(t);
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000,RESOLUTION=1920x1080\n1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n360.m3u8';
  for (const [quality, maxHeight, expected] of [['best', undefined, 1080], ['worst', undefined, 360], ['best', 800, 720]]) {
    const calls = [];
    const routes = {[url]: master};
    for (const h of [1080, 720, 360]) { routes[`${origin}/course/${h}.m3u8`] = media(`${h}.ts`); routes[`${origin}/course/${h}.ts`] = ts(); }
    const result = await downloadLecture({...baseArgs, item: {...lecture, key: `${quality}-${maxHeight || 0}`}, outputDir, fetcher: mappedFetch(routes, calls), quality, maxHeight});
    assert.equal(result.qualityLabel, `${expected}p`);
    assert.ok(calls.includes(`${origin}/course/${expected}.m3u8`));
  }
  const calls = [];
  await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher: mappedFetch({[url]: master}, calls), maxHeight: 100}), /高度上限/);
  assert.deepEqual(calls, [url]);
});

test('maxHeight rejects direct media of unknown height before requesting segments or creating files', async t => {
  const outputDir = await temp(t), calls = [];
  const fetcher = mappedFetch({[url]: media('one.ts'), [`${origin}/course/one.ts`]: ts()}, calls);
  for (const quality of ['best', 'worst']) {
    calls.length = 0;
    await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher, quality, maxHeight: 720}), /無法確認.*高度上限.*省略 --max-height/);
    assert.deepEqual(calls, [url]);
    assert.deepEqual(await readdir(outputDir), []);
  }
  calls.length = 0;
  const result = await downloadLecture({...baseArgs, outputDir, fetcher});
  assert.equal(result.status, 'completed');
  assert.match(result.qualityLabel, /未提供解析度/);
  assert.deepEqual(calls, [url, `${origin}/course/one.ts`]);
});

test('maxHeight also rejects a master with no declared variant heights', async t => {
  const outputDir = await temp(t), calls = [];
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8';
  await assert.rejects(downloadLecture({...baseArgs, outputDir, maxHeight: 720, fetcher: mappedFetch({[url]: master}, calls)}), /高度上限/);
  assert.deepEqual(calls, [url]);
  assert.deepEqual(await readdir(outputDir), []);
});

test('nested master playlists and invalid options are rejected before media writes', async t => {
  const outputDir = await temp(t);
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8';
  const fetcher = mappedFetch({[url]: master, [`${origin}/course/child.m3u8`]: master});
  await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher}), /巢狀/);
  for (const options of [{quality: '720'}, {maxHeight: 0}, {maxHeight: 1.5}]) await assert.rejects(downloadLecture({...baseArgs, outputDir, fetcher, ...options}));
  assert.deepEqual(await allFiles(outputDir), []);
});
