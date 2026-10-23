import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JobManager } from '../lib/jobs.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(manager, id, states) {
  for (let i = 0; i < 200; i += 1) {
    const job = manager.get(id);
    if (states.includes(job.state)) return job;
    await tick();
  }
  throw new Error(`job ${id} did not reach ${states}`);
}

test('runs jobs one at a time in the order they were queued', async () => {
  const manager = new JobManager();
  const order = [];
  const gate = deferred();
  const first = manager.start({ kind: 'apply', root: '/a', run: async () => (order.push('first'), gate.promise) });
  const second = manager.start({ kind: 'apply', root: '/a', run: async () => (order.push('second'), { ok: true }) });
  assert.equal(manager.get(first.id).state, 'running');
  assert.equal(manager.get(second.id).state, 'queued');
  assert.equal(manager.get(second.id).queuePosition, 1);
  gate.resolve({ ok: true });
  await waitFor(manager, second.id, ['finished']);
  assert.deepEqual(order, ['first', 'second']);
});

test('reports steps and per-file outcomes', async () => {
  const manager = new JobManager();
  const { id } = manager.start({
    kind: 'import',
    root: '/a',
    run: async ({ defineSteps, step, setFiles }) => {
      defineSteps([
        { id: 'scan', label: 'Scan' },
        { id: 'move', label: 'Move' },
      ]);
      step('scan', { state: 'done', detail: '2 files' });
      step('move', { state: 'running' });
      setFiles([{ rel: 'a.mkv', outcome: 'moved' }]);
      throw new Error('disk full');
    },
  });
  const job = await waitFor(manager, id, ['failed']);
  assert.deepEqual(job.steps.map((s) => [s.id, s.state, s.detail]), [
    ['scan', 'done', '2 files'],
    ['move', 'failed', null],
  ]);
  assert.deepEqual(job.files, [{ rel: 'a.mkv', outcome: 'moved' }]);
  assert.equal(job.error, 'disk full');
});

test('history and queued jobs survive a restart; interrupted imports run again', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-jobs-store-'));
  const storeFile = path.join(dir, 'jobs.json');
  const before = new JobManager({ storeFile });
  const gate = deferred();
  const done = before.start({ kind: 'apply', root: '/a', run: async () => ({ renamed: 1 }) });
  await waitFor(before, done.id, ['finished']);
  const running = before.start({ kind: 'import', root: '/a', params: { path: '/a/x' }, source: 'hook', run: async () => gate.promise });
  const waiting = before.start({ kind: 'import', root: '/a', params: { path: '/a/y' }, source: 'hook', run: async () => ({}) });
  const manual = before.start({ kind: 'apply', root: '/a', run: async () => ({}) });
  await before.save();

  // A new process: imports resume, a queued manual rename does not.
  const resumed = [];
  const after = new JobManager({
    storeFile,
    resume: (job) => (job.kind === 'import' ? async () => (resumed.push(job.params.path), { imported: 1 }) : null),
  });
  await after.restore();
  await waitFor(after, waiting.id, ['finished']);
  assert.deepEqual(resumed, ['/a/x', '/a/y'], 'the interrupted import first, then the queued one');
  assert.equal(after.get(done.id).state, 'finished', 'history kept');
  assert.equal(after.get(running.id).note, 'Restarted after the server stopped during this job');
  assert.equal(after.get(manual.id).state, 'interrupted');
  gate.resolve({});
});

test('cancelling a queued job removes it from the queue', async () => {
  const manager = new JobManager();
  const gate = deferred();
  const first = manager.start({ kind: 'apply', root: '/a', run: async () => gate.promise });
  const second = manager.start({ kind: 'apply', root: '/a', run: async () => assert.fail('must not run') });
  assert.equal(manager.cancel(second.id).state, 'cancelled');
  gate.resolve({});
  await waitFor(manager, first.id, ['finished']);
  await tick();
  assert.equal(manager.get(second.id).state, 'cancelled');
  assert.ok(manager.findActive(() => true) === null);
});

test('clearing the history removes finished jobs, keeps active ones and persists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-jobs-clear-'));
  const storeFile = path.join(dir, 'jobs.json');
  const manager = new JobManager({ storeFile });
  const done = manager.start({ kind: 'apply', root: '/a', run: async () => ({ renamed: 1 }) });
  await waitFor(manager, done.id, ['finished']);
  const gate = deferred();
  const running = manager.start({ kind: 'apply', root: '/a', run: () => gate.promise });
  const queued = manager.start({ kind: 'apply', root: '/a', run: async () => ({ renamed: 0 }) });

  assert.equal(await manager.clear(), 1);
  assert.deepEqual(manager.list().map((job) => job.id), [queued.id, running.id]);
  const stored = JSON.parse(await fs.readFile(storeFile, 'utf8'));
  assert.deepEqual(stored.map((job) => job.id).sort(), [queued.id, running.id].sort());

  gate.resolve({ renamed: 0 });
  await waitFor(manager, queued.id, ['finished']);
  await manager.save();
  await fs.rm(dir, { recursive: true, force: true });
});
