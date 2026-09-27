import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedUrl, readResource, loadPlaylist, validateTransportStream, saveMedia, safeFilename } from '../extension/transfer.mjs';

const url = 'https://www.udemy.com/assets/123/segment.ts?token=fixture-only';
function transportPackets(count = 3) {
  const bytes = new Uint8Array(188 * count).fill(0xff);
  for (let index = 0; index < bytes.length; index += 188) {
    bytes.set([0x47, 0x40, 0x11, 0x10], index);
  }
  return bytes;
}

function mockResponse(chunks, { status = 200, declared = null } = {}) {
  const calls = { reads: 0, cancels: 0, releases: 0, bodyCancels: 0 };
  let index = 0;
  return {
    calls,
    response: {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: name => name === 'content-length' ? declared : null },
      body: {
        cancel: async () => { calls.bodyCancels += 1; },
        getReader: () => ({
          read: async () => {
            calls.reads += 1;
            return index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true };
          },
          cancel: async () => { calls.cancels += 1; },
          releaseLock: () => { calls.releases += 1; },
        }),
      },
    },
  };
}

function writer(overrides = {}) {
  const calls = { writes: [], closes: 0, aborts: 0 };
  return {
    calls,
    stream: {
      async write(bytes) { calls.writes.push(Uint8Array.from(bytes)); },
      async close() { calls.closes += 1; },
      async abort() { calls.aborts += 1; },
      ...overrides,
    },
  };
}
const media = (count = 2) => ({ type: 'media', duration: count * 4, segments: Array.from({ length: count }, (_, index) => ({ url: `https://udemycdn.com/course/${index}.ts`, duration: 4 })) });

test('HTTPS/domain allowlist accepts official domains and rejects external or credential URLs', () => {
  for (const allowed of ['https://udemy.com/x', 'https://www.udemy.com/x', 'https://a.b.udemycdn.com/x', 'https://udemycdn.com:443/x']) assert.equal(new URL(checkedUrl(allowed)).protocol, 'https:');
  for (const blocked of ['http://udemy.com/x', 'https://udemy.com.evil.test/x', 'https://fakeudemy.com/x', 'https://udemycdn.com.evil.test/x', 'https://example.com/x', 'https://user:pass@udemy.com/x', 'https://udemy.com:8443/x', 'file:///tmp/file', 'javascript:alert(1)', '//udemy.com/x']) assert.throws(() => checkedUrl(blocked));
});

test('invalid destinations are rejected before fetch and requests never follow redirects', async () => {
  let calls = 0;
  await assert.rejects(readResource('https://example.com/x', { maxBytes: 50, fetcher: async () => { calls += 1; } }), /網域/);
  assert.equal(calls, 0);
  const fixture = mockResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
  const bytes = await readResource(url, { maxBytes: 3, fetcher: async (actualUrl, options) => {
    calls += 1; assert.equal(actualUrl, url); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'no-store');
    return fixture.response;
  } });
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3])); assert.equal(calls, 1);
  assert.equal(fixture.calls.cancels, 1); assert.equal(fixture.calls.releases, 1);
});

test('401/403 errors request a fresh authenticated page without leaking URLs', async () => {
  for (const status of [401, 403]) {
    const fixture = mockResponse([], { status });
    await assert.rejects(readResource(url, { maxBytes: 64, fetcher: async () => fixture.response }), error => {
      assert.match(error.message, /存取已過期或被拒絕/); assert(!error.message.includes('fixture-only')); return true;
    });
  }
});

test('network type errors produce a bounded actionable error', async () => {
  await assert.rejects(readResource(url, { maxBytes: 64, fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'error'); throw new TypeError('redirect refused: fixture-only');
  } }), error => {
    assert.match(error.message, /未取得可讀取的回應/); assert(!error.message.includes('fixture-only')); return true;
  });
});

test('streamed byte limit stops reading, cancels and releases the reader', async () => {
  const fixture = mockResponse([new Uint8Array(3), new Uint8Array(3), new Uint8Array(300)]);
  await assert.rejects(readResource(url, { maxBytes: 5, fetcher: async () => fixture.response }), /大小上限/);
  assert.equal(fixture.calls.reads, 2); assert.equal(fixture.calls.cancels, 1); assert.equal(fixture.calls.releases, 1);
});

test('oversized declared response is stopped before its body is read', async () => {
  const fixture = mockResponse([new Uint8Array(100)], { declared: '100' });
  let requestSignal;
  await assert.rejects(readResource(url, { maxBytes: 5, fetcher: async (_url, options) => {
    requestSignal = options.signal; return fixture.response;
  } }), /大小上限/);
  assert.equal(fixture.calls.reads, 0);
  assert(requestSignal.aborted || fixture.calls.bodyCancels > 0 || fixture.calls.cancels > 0, 'a rejected body must be cancelled rather than continuing in the background');
});

test('cancel and request timeout abort the fetch signal', async () => {
  const abortableFetcher = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readResource(url, { signal: controller.signal, maxBytes: 100, fetcher: abortableFetcher }), /已取消/);
  await assert.rejects(readResource(url, { timeoutMs: 5, maxBytes: 100, fetcher: abortableFetcher }), /逾時/);
});

test('loadPlaylist enforces playlist parsing and prevents encrypted manifests', async () => {
  const bytes = new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="https://udemycdn.com/key"\n#EXTINF:4,\npart.ts\n#EXT-X-ENDLIST\n');
  const fixture = mockResponse([bytes]);
  await assert.rejects(loadPlaylist('https://udemycdn.com/manifest.m3u8', { fetcher: async () => fixture.response }), /加密/);
});

test('TS validation rejects truncated, short and nonsynchronised packets', () => {
  assert.doesNotThrow(() => validateTransportStream(transportPackets()));
  for (const invalid of [new Uint8Array(), transportPackets(2), transportPackets().slice(1)]) assert.throws(() => validateTransportStream(invalid), /格式/);
  const invalid = transportPackets(); invalid[188] = 0;
  assert.throws(() => validateTransportStream(invalid), /格式|受保護/);
});

test('TS validation rejects transport scrambling, error indicator and reserved adaptation control', () => {
  const scrambled = transportPackets(); scrambled[3] |= 0x80;
  assert.throws(() => validateTransportStream(scrambled), /加密|格式|受保護/);
  const errored = transportPackets(); errored[1] |= 0x80;
  assert.throws(() => validateTransportStream(errored), /格式|錯誤/);
  const reserved = transportPackets(); reserved[3] &= 0xcf;
  assert.throws(() => validateTransportStream(reserved), /格式/);
});

test('saveMedia writes sequential segments then closes once and reports exact totals', async () => {
  const sink = writer(); const progress = []; let requests = 0;
  const packet = transportPackets();
  const result = await saveMedia(media(), sink.stream, { onProgress: value => progress.push(value), fetcher: async () => {
    requests += 1; return mockResponse([packet]).response;
  } });
  assert.equal(requests, 2); assert.equal(sink.calls.writes.length, 2);
  assert.equal(sink.calls.closes, 1); assert.equal(sink.calls.aborts, 0);
  assert.equal(result.bytes, packet.length * 2); assert.equal(result.segments, 2);
  assert.equal(progress.at(-1).completed, 2); assert.equal(progress.at(-1).bytes, result.bytes);
});

test('saveMedia aborts partial output on invalid media or HTTP failure and never closes it', async () => {
  for (const second of [mockResponse([new Uint8Array(600)]).response, mockResponse([], { status: 403 }).response]) {
    const sink = writer(); let requests = 0;
    await assert.rejects(saveMedia(media(), sink.stream, { fetcher: async () => ++requests === 1 ? mockResponse([transportPackets()]).response : second }));
    assert.equal(sink.calls.writes.length, 1); assert.equal(sink.calls.aborts, 1); assert.equal(sink.calls.closes, 0);
  }
});

test('write errors preserve the original failure and abort instead of closing', async () => {
  let aborted = 0; let closed = 0; const diskError = new Error('Disk full');
  await assert.rejects(saveMedia(media(1), { write: async () => { throw diskError; }, close: async () => { closed += 1; }, abort: async () => { aborted += 1; throw new Error('secondary'); } }, { fetcher: async () => mockResponse([transportPackets()]).response }), error => error === diskError);
  assert.equal(aborted, 1); assert.equal(closed, 0);
});

test('cancellation between segments stops further fetches and aborts partial output', async () => {
  const sink = writer(); const controller = new AbortController(); let requests = 0;
  await assert.rejects(saveMedia(media(), sink.stream, { signal: controller.signal, onProgress: () => controller.abort(), fetcher: async () => { requests += 1; return mockResponse([transportPackets()]).response; } }), /已取消/);
  assert.equal(requests, 1); assert.equal(sink.calls.writes.length, 1);
  assert.equal(sink.calls.aborts, 1); assert.equal(sink.calls.closes, 0);
});

test('output filenames exclude path characters and Windows reserved names', () => {
  assert.equal(safeFilename('CON'), '_CON.ts'); assert.equal(safeFilename('abc:/def'), 'abc__def.ts');
  assert.equal(safeFilename(''), 'udemy-lecture.ts'); assert.equal(safeFilename('lesson.  '), 'lesson.ts');
});
