import test from 'node:test';
import assert from 'node:assert/strict';
import {lectureDownloadPath, chooseVariant, safeQueueSnapshot, runQueue} from '../extension/batch-core.mjs';

const item = (key, extra = {}) => ({key, selected: true, status: 'queued', sectionIndex: 1, sectionTitle: '第一章', lectureIndex: 1, title: '相同標題', lectureId: key, ...extra});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

test('lecture paths remain deterministic and distinguish equal/sanitized/truncated titles', () => {
  const first = item('one');
  const path = lectureDownloadPath(first, {courseTitle: 'ASP.NET'});
  assert.equal(path, lectureDownloadPath(first, {courseTitle: 'ASP.NET'}));
  assert.match(path, /^ASP\.NET \[[a-f0-9]{16}\]\/01 - 第一章\/001 - 相同標題 \[one-[a-f0-9]{16}\]\.ts$/);
  assert.notEqual(path, lectureDownloadPath(item('two'), {courseTitle: 'ASP.NET'}));
  assert.notEqual(lectureDownloadPath(item('a:b', {title: 'a/b'})), lectureDownloadPath(item('a?b', {title: 'a\\b'})));
  assert.notEqual(lectureDownloadPath(item('first-' + 'x'.repeat(200))), lectureDownloadPath(item('first-' + 'x'.repeat(200) + 'z')));
  assert.notEqual(
    lectureDownloadPath(first, {courseTitle: 'Long title '.repeat(30) + '[course-one]'}).split('/')[0],
    lectureDownloadPath(first, {courseTitle: 'Long title '.repeat(30) + '[course-two]'}).split('/')[0]
  );
  assert.notEqual(lectureDownloadPath(first, {courseTitle: 'Same', courseKey: 'one'}), lectureDownloadPath(first, {courseTitle: 'Same', courseKey: 'two'}));
});

test('path components cannot escape folders or create reserved Windows filenames', () => {
  const path = lectureDownloadPath(item('../../CON', {
    title: '../A/..\\B:<x>|?*\u0000. ', sectionTitle: '..\\..//NUL', sectionIndex: 12, lectureIndex: 42
  }), {courseTitle: 'CON'});
  const parts = path.split('/');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^_CON \[[a-f0-9]{16}\]$/);
  assert.match(parts[1], /^12 - /);
  assert.match(parts[2], /^042 - /);
  for (const part of parts) {
    assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(part), part);
    assert.ok(part !== '.' && part !== '..');
    assert.ok(!/[. ]$/.test(part));
  }
  assert.throws(() => lectureDownloadPath(item('x'), {extension: '../exe'}), /副檔名/);
  assert.throws(() => lectureDownloadPath({title: 'No ID'}), /識別碼/);
  const long = lectureDownloadPath(item('x', {title: '🎥'.repeat(300), sectionTitle: '🎥'.repeat(300)}), {courseTitle: '🎥'.repeat(300)});
  assert.ok(long.length < 240);
  assert.ok(!/\p{Surrogate}/u.test(long));
});

test('quality chooses the best height under cap, otherwise smallest, without mutation', () => {
  const variants = [
    {height: 1080, bandwidth: 8000}, {height: 360, bandwidth: 2000},
    {height: 720, bandwidth: 5000}, {height: 720, bandwidth: 4000},
    {height: 2160, bandwidth: 16000}
  ];
  const before = [...variants];
  assert.equal(chooseVariant(variants, 'best'), variants[4]);
  assert.equal(chooseVariant(variants, '1080'), variants[0]);
  assert.equal(chooseVariant(variants, '720'), variants[2]);
  assert.equal(chooseVariant(variants, '480'), variants[1]);
  assert.equal(chooseVariant([variants[0], variants[2]], '480'), variants[2]);
  assert.deepEqual(variants, before);
  assert.equal(chooseVariant([], 'best'), null);
  assert.throws(() => chooseVariant(variants, '2160'), /畫質/);
});

test('unknown resolution is used only as fallback, with deterministic bandwidth selection', () => {
  const low = {height: null, bandwidth: 100};
  const high = {height: null, bandwidth: 900};
  const known = {height: 720, bandwidth: 300};
  assert.equal(chooseVariant([high, known], 'best'), known);
  assert.equal(chooseVariant([high, low], 'best'), high);
  assert.equal(chooseVariant([high, low], '720'), low);
});

test('snapshot whitelists metadata and never persists URLs, results, raw errors or running state', () => {
  const snapshot = safeQueueSnapshot([item('lecture:123', {
    status: 'running', title: 'Welcome https://cdn.udemycdn.com/a?token=private-secret',
    url: 'https://cdn.udemycdn.com/b?token=private-secret', candidates: [{url: 'private-secret'}],
    error: 'private-secret', reason: 'private-secret', result: {url: 'private-secret'},
    accessToken: 'private-secret', lectureId: 'https://udemy.com/?secret=private-secret'
  }), item('https://udemy.com/?token=private-secret')]);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].status, 'queued');
  assert.equal(snapshot[0].title, 'Welcome [網址略]');
  assert.ok(!JSON.stringify(snapshot).includes('private-secret'));
  assert.equal(snapshot[0].lectureId, undefined);
  assert.ok(!('error' in snapshot[0]));
  assert.ok(!('result' in snapshot[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('queue waits for processing resolution before completing or starting the next item', async () => {
  const gate = deferred();
  const entered = deferred();
  const items = [item('first'), item('second')];
  const calls = [];
  const updates = [];
  const running = runQueue(items, {
    processItem: async current => {
      calls.push(current.key);
      if (current.key === 'first') { entered.resolve(); await gate.promise; }
      return {status: 'completed'};
    },
    onUpdate: ({item: current}) => updates.push(`${current.key}:${current.status}`)
  });
  await entered.promise;
  assert.deepEqual(calls, ['first']);
  assert.equal(items[0].status, 'running');
  assert.equal(items[1].status, 'queued');
  gate.resolve();
  const result = await running;
  assert.equal(result.items, items);
  assert.equal(result.cancelled, false);
  assert.deepEqual(updates, ['first:running', 'first:completed', 'second:running', 'second:completed']);
});

test('queue continues after failure, records skips and never repeats completed items', async () => {
  const items = [item('already', {status: 'completed'}), item('unselected', {selected: false}), item('bad'), item('skip'), item('good')];
  const calls = [];
  await runQueue(items, {processItem: async current => {
    calls.push(current.key);
    if (current.key === 'bad') throw new Error('failure');
    return {status: current.key === 'skip' ? 'skipped' : 'completed', reason: 'No video'};
  }});
  assert.deepEqual(calls, ['bad', 'skip', 'good']);
  assert.deepEqual(items.map(current => current.status), ['completed', 'queued', 'failed', 'skipped', 'completed']);
  assert.equal(items[2].error, 'failure');
  const retried = [];
  await runQueue(items, {processItem: async current => { retried.push(current.key); return {status: 'completed'}; }});
  assert.deepEqual(retried, ['bad']);
  assert.equal(items[2].status, 'completed');
  assert.equal(items[2].error, undefined);
});

test('abort reaches active work immediately, waits for cleanup, and leaves remaining queued', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const cleanup = deferred();
  const items = [item('first'), item('second')];
  let abortObserved = false;
  let queueSettled = false;
  const calls = [];
  const running = runQueue(items, {signal: controller.signal, processItem: async (current, {signal}) => {
    calls.push(current.key);
    await new Promise(resolve => {
      signal.addEventListener('abort', () => { abortObserved = true; resolve(); }, {once: true});
      entered.resolve();
    });
    await cleanup.promise;
    throw new DOMException('Cancelled', 'AbortError');
  }}).then(result => { queueSettled = true; return result; });
  await entered.promise;
  controller.abort();
  assert.equal(abortObserved, true);
  await Promise.resolve();
  assert.equal(queueSettled, false);
  assert.deepEqual(calls, ['first']);
  cleanup.resolve();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual(items.map(current => current.status), ['queued', 'queued']);
  assert.ok(!('error' in items[0]));
});

test('pre-aborted queue starts no work, and abort on transition does not start the item', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const items = [item('first')];
  assert.equal((await runQueue(items, {signal: controller.signal, processItem: async () => { calls++; }})).cancelled, true);
  assert.equal(calls, 0);
  const duringUpdate = new AbortController();
  await runQueue(items, {signal: duringUpdate.signal,
    onUpdate: ({item: current}) => { if (current?.status === 'running') duringUpdate.abort(); },
    processItem: async () => { calls++; }
  });
  assert.equal(calls, 0);
  assert.equal(items[0].status, 'queued');
});

test('success committed during cancellation remains completed, with no following work', async () => {
  const controller = new AbortController();
  const items = [item('first'), item('second')];
  await runQueue(items, {signal: controller.signal, processItem: async () => {
    controller.abort();
    return {status: 'completed', bytes: 10};
  }});
  assert.deepEqual(items.map(current => current.status), ['completed', 'queued']);
});

test('duplicate keys cannot cause a completed lecture to be downloaded twice', async () => {
  const items = [item('same'), item('same'), item('done'), item('done', {status: 'completed'})];
  const calls = [];
  await runQueue(items, {processItem: async current => { calls.push(current.key); return {status: 'completed'}; }});
  assert.deepEqual(calls, ['same']);
  assert.ok(items.every(current => current.status === 'completed'));
});

test('duplicate failed keys retry only once next run and are not turned into final skips', async () => {
  const items = [item('same'), item('same')];
  let calls = 0;
  await runQueue(items, {processItem: async () => { calls++; throw new Error('failed'); }});
  assert.equal(calls, 1);
  assert.deepEqual(items.map(current => current.status), ['failed', 'failed']);
  await runQueue(items, {processItem: async () => { calls++; return {status: 'completed'}; }});
  assert.equal(calls, 2);
  assert.deepEqual(items.map(current => current.status), ['completed', 'completed']);
});

test('invalid outcomes fail and continue; observer errors cannot undo completed work', async () => {
  const items = [item('invalid'), item('valid')];
  await runQueue(items, {
    processItem: async current => current.key === 'valid' ? {status: 'completed'} : undefined,
    onUpdate: () => { throw new Error('storage unavailable'); }
  });
  assert.deepEqual(items.map(current => current.status), ['failed', 'completed']);
  assert.match(items[0].error, /未回報/);
});
