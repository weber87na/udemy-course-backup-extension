import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePlaylist} from '../extension/hls.mjs';

const base = 'https://stream.udemycdn.com/course/master.m3u8?token=private';
const media = (...lines) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', ...lines, '#EXT-X-ENDLIST'].join('\n');
const segment = ['#EXTINF:5.5,', 'one.ts'];

test('parse complete VOD in order without propagating a master query token', () => {
  const result = parsePlaylist(media('#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-KEY:METHOD=NONE', ...segment, '#EXTINF:4.25,Final, chapter', '../two.ts?own=ok'), base);
  assert.deepEqual(result, {type: 'media', segments: [
    {url: 'https://stream.udemycdn.com/course/one.ts', duration: 5.5},
    {url: 'https://stream.udemycdn.com/two.ts?own=ok', duration: 4.25}
  ], duration: 9.75});
});

test('master preserves variant ordering and correctly reads quoted commas', () => {
  const text = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=2200000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720',
    '720/index.m3u8?own=720',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360', '//www.udemy.com/360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=320000', 'other.m3u8'].join('\n');
  assert.deepEqual(parsePlaylist(text, base), {type: 'master', variants: [
    {url: 'https://stream.udemycdn.com/course/720/index.m3u8?own=720', bandwidth: 2200000, width: 1280, height: 720, label: '720p'},
    {url: 'https://www.udemy.com/360.m3u8', bandwidth: 500000, width: 640, height: 360, label: '360p'},
    {url: 'https://stream.udemycdn.com/course/other.m3u8', bandwidth: 320000, width: null, height: null, label: '320 kbps'}
  ]});
});

test('reject every encrypted/keyed playlist even when later marked unencrypted', () => {
  for (const key of [
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR',
    '#EXT-X-KEY:URI="key.bin"',
    '#EXT-X-SESSION-KEY:METHOD=NONE',
    '#EXT-X-KEY:METHOD=NONE,URI="key.bin"'
  ]) assert.throws(() => parsePlaylist(media(key, '#EXT-X-KEY:METHOD=NONE', ...segment), base), /加密|金鑰/);
});

test('reject hostile domains, credentials, schemes, ports and fragments everywhere', () => {
  const badUrls = [
    'https://udemy.com.evil.test/one.ts', 'https://eviludemycdn.com/one.ts',
    'https://udemycdn.com.evil.test/one.ts', 'https://evil.test/one.ts',
    'http://stream.udemycdn.com/one.ts', 'https://name:pass@udemy.com/one.ts',
    'https://udemy.com:444/one.ts', 'https://udemy.com/one.ts#fragment',
    'data:text/plain,one.ts', 'file:///one.ts', '//evil.test/one.ts',
    'https:\\udemy.com\\one.ts'
  ];
  for (const url of badUrls) {
    assert.throws(() => parsePlaylist(media(...segment), url), Error);
    assert.throws(() => parsePlaylist(media('#EXTINF:5.5,', url), base), Error);
    assert.throws(() => parsePlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000\n${url}`, base), Error);
  }
});

test('accept HTTPS apex and subdomain URLs only within the supported hosts', () => {
  for (const host of ['udemy.com', 'a.udemy.com', 'udemycdn.com', 'a.udemycdn.com']) {
    const text = media('#EXTINF:1,', `https://${host}/a.ts`);
    assert.equal(parsePlaylist(text, base).segments[0].url, `https://${host}/a.ts`);
  }
});

test('reject live, event, fMP4, byte ranges, discontinuities and low-latency features', () => {
  assert.throws(() => parsePlaylist(media(...segment).replace('\n#EXT-X-ENDLIST', ''), base), /直播/);
  for (const tag of [
    '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-BYTERANGE:100@0', '#EXT-X-DISCONTINUITY', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
    '#EXT-X-PART:DURATION=1,URI="part.ts"', '#EXT-X-PART-INF:PART-TARGET=1',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part.ts"', '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES',
    '#EXT-X-RENDITION-REPORT:URI="other.m3u8"', '#EXT-X-SKIP:SKIPPED-SEGMENTS=2',
    '#EXT-X-DEFINE:NAME="token",VALUE="secret"', '#EXT-X-I-FRAMES-ONLY', '#EXT-X-GAP'
  ]) assert.throws(() => parsePlaylist(media(tag, ...segment), base), Error, tag);
  for (const name of ['a.m4s', 'a.mp4', 'a.aac', 'a.ts/other', 'a.ts%00']) {
    assert.throws(() => parsePlaylist(media('#EXTINF:1,', name), base), /MPEG-TS/);
  }
  assert.throws(() => parsePlaylist(media('#EXTINF:1,', '{$token}.ts'), base), /變數/);
});

test('reject separate audio and video plus protected-output master variants', () => {
  for (const declaration of [
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000,AUDIO="audio"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000,VIDEO="video"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000,HDCP-LEVEL=TYPE-0'
  ]) assert.throws(() => parsePlaylist(`#EXTM3U\n${declaration}\nvideo.m3u8`, base), /音軌|視訊|保護/);
});

test('reject malformed durations and playlist ordering', () => {
  for (const duration of ['-1', '0', 'NaN', 'Infinity', '1e2', '1.2.3', '', '7']) {
    assert.throws(() => parsePlaylist(media(`#EXTINF:${duration},`, 'a.ts'), base), Error, duration);
  }
  for (const text of [
    media('a.ts'), media('#EXTINF:1,'), media('#EXTINF:1,', '#EXTINF:2,', 'a.ts'),
    media(...segment, '#EXT-X-MEDIA-SEQUENCE:1'), media(...segment, '#EXT-X-TARGETDURATION:6'),
    media(...segment) + '\n#EXTINF:1,\nb.ts', media(...segment) + '\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-STREAM-INF:BANDWIDTH=5\nother.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5\n#EXT-X-ENDLIST',
    media('#EXT-X-ENDLIST:invalid', ...segment), '#EXTM3U\n#EXT-X-ENDLIST',
    media('#EXTM3U', ...segment), media('#EXT-X-UNKNOWN:1', ...segment),
    media('#EXTINF:1', 'a.ts')
  ]) assert.throws(() => parsePlaylist(text, base), Error);
});

test('reject malformed/duplicate master attributes and incomplete master declarations', () => {
  for (const value of [
    'BANDWIDTH=1,BANDWIDTH=2', 'BANDWIDTH=1,CODECS="unterminated',
    'BANDWIDTH=1,CODECS="a,b"garbage', 'BANDWIDTH=1,', 'BANDWIDTH=',
    'BANDWIDTH=-1', 'BANDWIDTH=0', 'RESOLUTION=640x360',
    'BANDWIDTH=1,RESOLUTION=0x360', 'BANDWIDTH=1,RESOLUTION=bad'
  ]) assert.throws(() => parsePlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:${value}\nchild.m3u8`, base), Error);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100', base), /中斷/);
});

test('strict header and UTF-8 byte/segment limits', () => {
  const good = media(...segment);
  assert.equal(parsePlaylist(good.replaceAll('\n', '\r\n'), base).type, 'media');
  for (const text of ['\uFEFF' + good, '\n' + good, good.replace('#EXTM3U', '#extm3u'), good + '\u0000', good.replace('\n', '\r')]) {
    assert.throws(() => parsePlaylist(text, base), Error);
  }
  assert.throws(() => parsePlaylist('#EXTM3U\n#' + '一'.repeat(700000), base), /2 MiB/);
  const many = count => media(...Array.from({length: count}, (_, i) => `#EXTINF:1,\n${i}.ts`));
  assert.equal(parsePlaylist(many(20000), base).segments.length, 20000);
  assert.throws(() => parsePlaylist(many(20001), base), /20,000/);
});

test('errors never repeat signed URI tokens', () => {
  assert.throws(() => parsePlaylist(media('#EXTINF:1,', 'https://evil.test/one.ts?token=private-secret'), base), error => {
    assert.ok(!error.message.includes('private-secret'));
    return true;
  });
  assert.throws(() => parsePlaylist(media('#EXT-X-UNKNOWN:token=private-secret', ...segment), base), error => {
    assert.ok(error.message.includes('#EXT-X-UNKNOWN'));
    assert.ok(!error.message.includes('private-secret'));
    return true;
  });
});

test('legacy cache permission and clock metadata preserve complete segment order', () => {
  const result=parsePlaylist(media('#EXT-X-ALLOW-CACHE:YES','#EXT-X-PROGRAM-DATE-TIME:2020-09-08T20:06:30.000Z','#EXTINF:1,','one.ts','#EXTINF:2,','#EXT-X-PROGRAM-DATE-TIME:2020-09-08T20:06:31+08:00','two.ts'),base);
  assert.equal(result.duration,3);
  assert.equal(result.segments.length,2);
  assert.ok(result.segments[0].url.endsWith('/one.ts'));
  assert.ok(result.segments[1].url.endsWith('/two.ts'));
});

test('metadata support does not admit encrypted, malformed or cache-denied playlists', () => {
  for(const entry of ['#EXT-X-ALLOW-CACHE:NO','#EXT-X-ALLOW-CACHE:MAYBE','#EXT-X-PROGRAM-DATE-TIME:bad']) assert.throws(()=>parsePlaylist(media(entry,...segment),base));
  assert.throws(()=>parsePlaylist(media('#EXT-X-ALLOW-CACHE:YES','#EXT-X-ALLOW-CACHE:YES',...segment),base),/重複/);
  assert.throws(()=>parsePlaylist(media('#EXT-X-ALLOW-CACHE:YES','#EXT-X-KEY:METHOD=AES-128,URI="key"',...segment),base),/加密/);
});
