import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redirectsAllowed, readResource, loadPlaylist, saveMedia } from '../extension/transfer.mjs';

const sources = ['https://udemy.com', 'https://*.udemy.com', 'https://udemycdn.com', 'https://*.udemycdn.com'];
const policy = `script-src 'self'; object-src 'self'; connect-src ${sources.join(' ')}`;
const manifest = value => ({ manifest_version: 3, content_security_policy: { extension_pages: value } });
const secret = 'VERY_PRIVATE_SIGNATURE_ABC';
const initialUrl = `https://www.udemy.com/assets/123/master.m3u8?sig=${secret}`;

async function withManifest(value, action, protocol = 'chrome-extension:') {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    if (protocol === null) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { protocol } });
    if (value === undefined) delete globalThis.chrome;
    else Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { getManifest: () => value } } });
    return await action();
  } finally {
    if (original) Object.defineProperty(globalThis, 'chrome', original);
    else delete globalThis.chrome;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globalThis.location;
  }
}

function response({ finalUrl = initialUrl, status = 200, contentType = 'application/vnd.apple.mpegurl', text = '', bytes, readError, redirected = true } = {}) {
  const data = bytes || new TextEncoder().encode(text);
  const calls = { reads: 0, cancels: 0, releases: 0 };
  let sent = false;
  return {
    calls,
    value: {
      url: finalUrl, redirected, status, ok: status >= 200 && status < 300,
      headers: { get: name => name === 'content-type' ? contentType : name === 'content-length' ? String(data.length) : null },
      body: { getReader: () => ({
        async read() {
          calls.reads += 1;
          if (readError) throw readError;
          if (sent) return { done: true };
          sent = true; return { value: data, done: false };
        },
        async cancel() { calls.cancels += 1; },
        releaseLock() { calls.releases += 1; },
      }) },
    },
  };
}

function assertPrivate(value) {
  const encoded = JSON.stringify(value);
  assert(!encoded.includes(secret), 'diagnostics must not expose signature tokens');
  assert(!encoded.includes('/assets/'), 'diagnostics must not expose resource paths');
  assert(!encoded.includes('https://'), 'diagnostics expose hostnames, not full URLs');
}

test('redirect gate accepts only one exact HTTPS connect-src source list', () => {
  assert.equal(redirectsAllowed(manifest(policy)), true);
  assert.equal(redirectsAllowed(manifest(`connect-src\t${sources.slice().reverse().join('  ')}; script-src 'self';`)), true);
  for (const rejected of [
    undefined, {}, manifest(''), manifest("default-src 'self'"),
    manifest('connect-src *'),
    manifest(`connect-src ${sources.slice(0, 3).join(' ')}`),
    manifest(`connect-src ${sources.join(' ')} https://example.com`),
    manifest(`connect-src ${sources.join(' ')} https:`),
    manifest(`connect-src ${sources.join(' ').replace('https://udemy.com', 'http://udemy.com')}`),
    manifest(`${policy}; connect-src *`),
    manifest(`CONNECT-SRC *; ${policy}`),
    manifest(`${policy}; CONNECT-SRC *`),
  ]) assert.equal(redirectsAllowed(rejected), false, JSON.stringify(rejected));
});

test('packaged manifest contains the exact redirect allowlist', () => {
  const actual = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(redirectsAllowed(actual), true);
  assert.deepEqual(actual.optional_host_permissions, ['https://*.udemy.com/*', 'https://*.udemycdn.com/*']);
});

test('fetch follows redirects only when the current extension has the restrictive CSP', async () => {
  for (const [current, expected, protocol] of [[undefined, 'error'], [manifest('connect-src *'), 'error'], [manifest(policy), 'follow'], [manifest(policy), 'error', 'https:'], [manifest(policy), 'error', null]]) {
    await withManifest(current, async () => {
      const diagnostics = []; const fixture = response({ text: 'fixture' });
      const bytes = await readResource(initialUrl, { maxBytes: 100, onDiagnostic: entry => diagnostics.push(entry), fetcher: async (_url, options) => {
        assert.equal(options.redirect, expected); assert.equal(options.credentials, 'include');
        assert.equal(options.cache, 'no-store'); return fixture.value;
      } });
      assert.equal(new TextDecoder().decode(bytes), 'fixture');
      assert.equal(diagnostics[0].redirectMode, expected); assertPrivate(diagnostics);
    }, protocol);
  }
});

test('redirect destinations outside the allowlist are rejected before reading their bodies', async () => {
  await withManifest(manifest(policy), async () => {
    for (const finalUrl of [`http://udemy.com/x?sig=${secret}`, `https://example.com/x?sig=${secret}`, `https://udemy.com.evil.test/x?sig=${secret}`, `https://user:pass@udemy.com/x?sig=${secret}`, `https://udemycdn.com:8443/x?sig=${secret}`]) {
      const fixture = response({ finalUrl, text: 'untrusted' }); const diagnostics = []; let signal;
      await assert.rejects(readResource(initialUrl, { maxBytes: 100, onDiagnostic: entry => diagnostics.push(entry), fetcher: async (_url, options) => { signal = options.signal; return fixture.value; } }), error => {
        assert.match(error.message, /網域/); assertPrivate(error.message); return true;
      });
      assert.equal(fixture.calls.reads, 0); assert.equal(signal.aborted, true); assertPrivate(diagnostics);
    }
  });
});

test('login redirects and HTML responses stop before media parsing', async () => {
  await withManifest(manifest(policy), async () => {
    for (const [options, message] of [
      [{ finalUrl: `https://www.udemy.com/join/login-popup/?next=${secret}` }, /登入頁/],
      [{ finalUrl: `https://www.udemy.com/login?next=${secret}` }, /登入頁/],
      [{ contentType: 'text/html; charset=utf-8', text: `<html>${secret}</html>` }, /回傳網頁/],
    ]) {
      const fixture = response(options); const diagnostics = [];
      await assert.rejects(readResource(initialUrl, { maxBytes: 1000, onDiagnostic: entry => diagnostics.push(entry), fetcher: async () => fixture.value }), error => {
        assert.match(error.message, message); assertPrivate(error.message); return true;
      });
      assert.equal(fixture.calls.reads, 0); assertPrivate(diagnostics);
    }
  });
});

test('redirected master playlists resolve variant paths against the final response URL', async () => {
  await withManifest(manifest(policy), async () => {
    const fixture = response({ finalUrl: `https://cdn.udemycdn.com/new/base/master.m3u8?sig=${secret}`, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nquality/720.m3u8\n' });
    const diagnostics = [];
    const playlist = await loadPlaylist(initialUrl, { phase: 'master', onDiagnostic: entry => diagnostics.push(entry), fetcher: async () => fixture.value });
    assert.equal(playlist.type, 'master');
    assert.equal(playlist.variants[0].url, 'https://cdn.udemycdn.com/new/base/quality/720.m3u8');
    assert.equal(diagnostics.at(-1).finalHost, 'cdn.udemycdn.com'); assertPrivate(diagnostics);
  });
});

test('redirected media playlists resolve relative segments against the final response URL', async () => {
  await withManifest(manifest(policy), async () => {
    const fixture = response({ finalUrl: `https://cdn.udemycdn.com/moved/video/index.m3u8?sig=${secret}`, text: `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n../segments/part-1.ts?sig=${secret}\n#EXT-X-ENDLIST\n` });
    const diagnostics = [];
    const playlist = await loadPlaylist(initialUrl, { phase: 'revalidate', onDiagnostic: entry => diagnostics.push(entry), fetcher: async () => fixture.value });
    assert.equal(playlist.type, 'media');
    assert.equal(playlist.segments[0].url, `https://cdn.udemycdn.com/moved/segments/part-1.ts?sig=${secret}`);
    assert.equal(diagnostics.at(-1).phase, 'revalidate'); assertPrivate(diagnostics);
  });
});

test('missing host permission is diagnosed before any fetch', async () => {
  const diagnostics = []; let fetches = 0;
  await assert.rejects(readResource(initialUrl, { maxBytes: 100, phase: 'revalidate', onDiagnostic: entry => diagnostics.push(entry), permissionCheck: async origin => {
    assert.equal(origin, 'https://www.udemy.com/*'); return false;
  }, fetcher: async () => { fetches += 1; throw new Error('Must not fetch'); } }), /缺少網域讀取權限/);
  assert.equal(fetches, 0);
  assert.equal(diagnostics.at(-1).code, 'HOST_PERMISSION_MISSING');
  assert.equal(diagnostics.at(-1).stage, 'permission'); assert.equal(diagnostics.at(-1).permissionGranted, false);
  assertPrivate(diagnostics);
});

test('network and mid-body TypeErrors produce distinct safe diagnostics', async () => {
  await withManifest(manifest(policy), async () => {
    for (const bodyFailure of [false, true]) {
      const diagnostics = [];
      const fixture = response({ readError: new TypeError(`reader failure ${initialUrl}`) });
      await assert.rejects(readResource(initialUrl, { maxBytes: 100, phase: 'segment', segmentIndex: 2, totalSegments: 7, permissionCheck: async () => true, onDiagnostic: entry => diagnostics.push(entry), fetcher: async () => {
        if (bodyFailure) return fixture.value;
        throw new TypeError(`network failure ${initialUrl}`);
      } }), error => {
        assert.match(error.message, /影片片段 2 \/ 7/);
        assert.match(error.message, bodyFailure ? /中途讀取失敗/ : /未取得可讀取的回應/);
        assertPrivate(error.message); return true;
      });
      const failure = diagnostics.at(-1);
      assert.equal(failure.code, bodyFailure ? 'BODY_READ_FAILED' : 'NETWORK_FAILED');
      assert.equal(failure.stage, bodyFailure ? 'body' : 'fetch');
      assert.equal(failure.httpStatus, bodyFailure ? 200 : null);
      assert.equal(failure.permissionGranted, true); assert.equal(failure.host, 'www.udemy.com');
      assert.equal(failure.segmentIndex, 2); assert.equal(failure.totalSegments, 7); assertPrivate(diagnostics);
    }
  });
});

test('HTTP auth failures retain only status, phase and sanitized host diagnostics', async () => {
  for (const status of [401, 403]) {
    const fixture = response({ finalUrl: `https://cdn.udemycdn.com/restricted.ts?sig=${secret}`, status }); const diagnostics = [];
    await assert.rejects(readResource(initialUrl, { maxBytes: 100, phase: 'variant', onDiagnostic: entry => diagnostics.push(entry), fetcher: async () => fixture.value }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`)); assertPrivate(error.message); return true;
    });
    assert.equal(diagnostics.at(-1).httpStatus, status); assert.equal(diagnostics.at(-1).phase, 'variant');
    assert.equal(diagnostics.at(-1).finalHost, 'cdn.udemycdn.com'); assertPrivate(diagnostics);
  }
});

test('saveMedia forwards per-segment diagnostics and aborts output on failed transfer', async () => {
  const diagnostics = []; let aborted = 0; let closed = 0;
  const media = { type: 'media', segments: [{ url: `https://udemycdn.com/first.ts?sig=${secret}` }, { url: `https://udemycdn.com/second.ts?sig=${secret}` }] };
  await assert.rejects(saveMedia(media, { write: async () => assert.fail('No failed bytes may be written'), close: async () => { closed += 1; }, abort: async () => { aborted += 1; } }, {
    permissionCheck: async () => true, onDiagnostic: entry => diagnostics.push(entry), fetcher: async () => { throw new TypeError(initialUrl); },
  }), error => { assertPrivate(error.message); return true; });
  assert.equal(aborted, 1); assert.equal(closed, 0);
  assert.equal(diagnostics.at(-1).phase, 'segment'); assert.equal(diagnostics.at(-1).segmentIndex, 1);
  assert.equal(diagnostics.at(-1).totalSegments, 2); assertPrivate(diagnostics);
});
