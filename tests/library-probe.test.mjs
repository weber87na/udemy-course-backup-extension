import test from 'node:test';
import assert from 'node:assert/strict';
import {probeHls} from '../extension/library-probe.mjs';

const url = 'https://www.udemy.com/assets/555/master.m3u8?token=fixture';
const capture = {candidates: [{url}]};
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\none.ts\n#EXTINF:4,\ntwo.ts\n#EXT-X-ENDLIST\n';
const response = (body, type = 'application/vnd.apple.mpegurl') => new Response(body, {headers: {'content-type': type}});
function packets() {
  const bytes = new Uint8Array(188 * 3).fill(0xff);
  for (let offset = 0; offset < bytes.length; offset += 188) bytes.set([0x47, 0x40, 0x11, 0x10], offset);
  return bytes;
}
function fixture(playlist = media, segment = packets()) {
  const calls = [];
  return {calls, fetcher: async address => {
    calls.push(address);
    return address === url ? response(playlist) : response(segment, 'video/mp2t');
  }};
}

test('successful check reads a complete HLS playlist and only the first TS segment', async () => {
  const source = fixture();
  assert.deepEqual(await probeHls(capture, source), {status: 'downloadable', reason: 'hls-supported'});
  assert.deepEqual(source.calls, [url, 'https://www.udemy.com/assets/555/one.ts']);
});

test('master check uses highest available quality and never downloads other variants', async () => {
  const calls = [];
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080.m3u8\n';
  const result = await probeHls(capture, {fetcher: async address => {
    calls.push(address);
    return address === url ? response(master) : address.endsWith('.m3u8') ? response(media) : response(packets(), 'video/mp2t');
  }});
  assert.equal(result.status, 'downloadable');
  assert.deepEqual(calls, [url, 'https://www.udemy.com/assets/555/1080.m3u8', 'https://www.udemy.com/assets/555/one.ts']);
});

test('encrypted playlist stops before any segment, key or license request', async () => {
  for (const tag of ['#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="license.bin"']) {
    const source = fixture(media.replace('#EXT-X-TARGETDURATION:4', `${tag}\n#EXT-X-TARGETDURATION:4`));
    assert.deepEqual(await probeHls(capture, source), {status: 'unsupported', reason: 'encrypted'});
    assert.deepEqual(source.calls, [url]);
  }
});

test('known unsupported content is distinct from malformed responses', async () => {
  const unsupported = fixture(media.replace('#EXT-X-TARGETDURATION:4', '#EXT-X-MAP:URI="init.mp4"\n#EXT-X-TARGETDURATION:4'));
  assert.deepEqual(await probeHls(capture, unsupported), {status: 'unsupported', reason: 'unsupported-format'});
  for (const content of ['garbage', '<html>login</html>', '#EXTM3U\n', media.replace('#EXTINF:4,', '#EXTINF:no,'),
    media.replace('#EXT-X-ENDLIST\n', ''), media.replace('one.ts', 'https://evil.test/one.ts')]) {
    const source = fixture(content);
    assert.equal((await probeHls(capture, source)).status, 'unknown', content);
    assert.deepEqual(source.calls, [url]);
  }
});

test('malformed protection declarations are unknown rather than proof of encryption', async () => {
  for (const tag of ['#EXT-X-KEY:METHOD=INVALID,URI="key.bin"', '#EXT-X-SESSION-KEY',
    '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=garbage', '#EXT-X-MAP:garbage',
    '#EXT-X-KEY:METHOD=INVALID,URI="key.bin"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-MAP\n#EXT-X-MAP:URI="init.mp4"']) {
    const source = fixture(media.replace('#EXT-X-TARGETDURATION:4', `${tag}\n#EXT-X-TARGETDURATION:4`));
    assert.equal((await probeHls(capture, source)).status, 'unknown', tag);
    assert.deepEqual(source.calls, [url]);
  }
});

test('HTTP, HTML, permission, oversized and fetch failures stay unknown', async () => {
  const fetchers = [
    async () => new Response('', {status: 403}),
    async () => new Response('', {status: 401}),
    async () => response('<html>login</html>', 'text/html'),
    async () => { throw new TypeError('network failed'); },
    async () => { throw new Error('影片串流已加密，已停止；不讀取金鑰、不解密，也不處理 DRM。'); },
    async () => new Response(media, {headers: {'content-length': String(3 * 1024 * 1024)}})
  ];
  for (const fetcher of fetchers) assert.equal((await probeHls(capture, {fetcher})).status, 'unknown');
  const denied = fixture();
  assert.equal((await probeHls(capture, {...denied, permissionCheck: async () => false})).status, 'unknown');
  assert.equal(denied.calls.length, 0);
});

test('segment network errors and malformed bytes stay unknown, explicit scrambling is unsupported', async () => {
  for (const segment of [new Uint8Array(0), new Uint8Array(188 * 3), new Uint8Array(1000)]) {
    assert.deepEqual(await probeHls(capture, fixture(media, segment)), {status: 'unknown', reason: 'source-unconfirmed'});
  }
  const scrambled = packets(); scrambled[3] |= 0x80;
  assert.deepEqual(await probeHls(capture, fixture(media, scrambled)), {status: 'unsupported', reason: 'encrypted'});
  assert.deepEqual(await probeHls(capture, {fetcher: async address => address === url ? response(media) : new Response('', {status: 403})}), {status: 'unknown', reason: 'network'});
});

test('cancellation and invalid captures do not produce availability claims', async () => {
  const controller = new AbortController(); controller.abort();
  const source = fixture();
  assert.deepEqual(await probeHls(capture, {...source, signal: controller.signal}), {status: 'unknown', reason: 'cancelled'});
  assert.equal(source.calls.length, 0);
  for (const value of [null, {}, {candidates: []}, {candidates: [{url: 42}]}]) {
    assert.deepEqual(await probeHls(value, source), {status: 'unknown', reason: 'source-unconfirmed'});
  }
});

test('probe results contain no signed addresses or response error text', async () => {
  const source = fixture();
  const result = await probeHls(capture, source);
  assert.deepEqual(Object.keys(result), ['status', 'reason']);
  assert.ok(!JSON.stringify(result).includes('fixture'));
  const failed = await probeHls(capture, {fetcher: async () => { throw new Error('https://secret.test/?token=sensitive'); }});
  assert.deepEqual(failed, {status: 'unknown', reason: 'network'});
});
