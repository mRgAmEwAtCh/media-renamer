import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PARTIAL_PREFIX, sweepPartials } from '../lib/mover.ts';
import { applyRenames, CancelledError, moveFile, undoLast, UNDO_LOG } from '../lib/renamer.ts';

const exdev = async () => {
  throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-jobs-')));
}

const readLog = async (root) => JSON.parse(await fs.readFile(path.join(root, UNDO_LOG), 'utf8'));
const listing = async (dir) => (await fs.readdir(dir)).sort();

test('a copy cancelled mid-way leaves the original and no partial file', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'big.mkv'), Buffer.alloc(32 * 1024 * 1024, 7));
  const controller = new AbortController();
  const progress = [];

  await assert.rejects(
    moveFile(path.join(dir, 'big.mkv'), path.join(dir, 'moved.mkv'), {
      rename: exdev,
      signal: controller.signal,
      onProgress: (done, total) => {
        progress.push([done, total]);
        controller.abort();
      },
    }),
    CancelledError,
  );
  assert.ok(progress.length >= 1 && progress[0][1] === 32 * 1024 * 1024, 'reports bytes with the total size');
  assert.deepEqual(await listing(dir), ['big.mkv'], 'original kept, no partial copy or target left behind');
});

test('cross-device copies are committed under the final name only when complete', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'a.mkv'), 'payload');
  const seen = [];
  await moveFile(path.join(dir, 'a.mkv'), path.join(dir, 'b.mkv'), { rename: exdev, onProgress: (d, t) => seen.push([d, t]) });
  assert.deepEqual(await listing(dir), ['b.mkv']);
  assert.deepEqual(seen.at(-1), [7, 7]);
});

test('apply reports progress, continues past a failing file and records it', async () => {
  const root = await tempDir();
  for (const name of ['a.mkv', 'b.mkv', 'c.mkv']) await fs.writeFile(path.join(root, name), name);
  const events = [];
  const renames = [
    { from: 'a.mkv', to: 'A.mkv' },
    { from: 'b.mkv', to: 'B.mkv' },
    { from: 'c.mkv', to: 'C.mkv' },
  ];
  // Make b.mkv fail after validation by removing it as soon as a.mkv completes.
  const result = await applyRenames(root, renames, {
    onProgress: (p) => {
      events.push(p);
      if (p.filesDone === 1 && !p.current) fs.rm(path.join(root, 'b.mkv'), { force: true });
    },
  });
  assert.equal(result.renamed, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].from, 'b.mkv');
  assert.equal(events.at(-1).filesDone, 3);
  assert.equal(events.at(-1).filesTotal, 3);
  const [batch] = await readLog(root);
  assert.equal(batch.status, 'partial');
  assert.deepEqual(batch.renames.map((e) => e.from), ['a.mkv', 'c.mkv']);
});

test('cancelling a batch keeps completed moves and they can be undone', async () => {
  const root = await tempDir();
  const library = await tempDir();
  for (const name of ['1.mkv', '2.mkv', '3.mkv']) await fs.writeFile(path.join(root, name), name);
  const controller = new AbortController();
  const result = await applyRenames(
    root,
    ['1', '2', '3'].map((n) => ({ from: `${n}.mkv`, to: `Show/${n}.mkv` })),
    {
      target: library,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.filesDone === 1) controller.abort();
      },
    },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.renamed, 1);
  assert.deepEqual(await listing(root), ['.media-renamer-undo.json', '2.mkv', '3.mkv']);
  assert.equal((await readLog(root))[0].status, 'cancelled');

  const undone = await undoLast(root);
  assert.equal(undone.restored, 1);
  assert.deepEqual(await listing(root), ['.media-renamer-undo.json', '1.mkv', '2.mkv', '3.mkv']);
});

test('a batch interrupted by a crash is recovered: partial copies swept, completed moves undoable', async () => {
  const root = await tempDir();
  const library = await tempDir();
  await fs.writeFile(path.join(library, 'done.mkv'), 'moved before the crash');
  await fs.writeFile(path.join(root, 'pending.mkv'), 'still here');
  const partial = path.join(library, `${PARTIAL_PREFIX}dead.mkv`);
  await fs.writeFile(partial, 'half');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(partial, old, old);
  await fs.writeFile(
    path.join(root, UNDO_LOG),
    JSON.stringify([
      {
        id: 'x',
        at: old.toISOString(),
        target: library,
        status: 'running',
        renames: [
          { from: 'done.mkv', to: 'done.mkv', state: 'done' },
          { from: 'pending.mkv', to: 'pending.mkv', state: 'pending' },
        ],
      },
    ]),
  );

  const undone = await undoLast(root);
  assert.equal(undone.restored, 1, 'the completed move is reversed');
  assert.deepEqual(undone.skipped, [], 'the pending entry whose move never happened is dropped silently');
  assert.deepEqual(await listing(root), ['.media-renamer-undo.json', 'done.mkv', 'pending.mkv']);
  assert.deepEqual(await listing(library), [], 'stale partial copy removed');
});

test('a second job in the same folder is refused while the first holds the lock', async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'a.mkv'), Buffer.alloc(1024));
  await fs.writeFile(path.join(root, '.media-renamer.lock'), JSON.stringify({ owner: 'web job' }));
  await assert.rejects(applyRenames(root, [{ from: 'a.mkv', to: 'b.mkv' }]), (error) => error.status === 409 && /web job/.test(error.message));

  const stale = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(path.join(root, '.media-renamer.lock'), stale, stale);
  const result = await applyRenames(root, [{ from: 'a.mkv', to: 'b.mkv' }]);
  assert.equal(result.renamed, 1, 'a stale lock from a crashed process is taken over');
  await assert.rejects(fs.access(path.join(root, '.media-renamer.lock')), 'lock released afterwards');
});

test('a lock left by a process that is gone is taken over immediately', async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'a.mkv'), '');
  const lock = path.join(root, '.media-renamer.lock');
  // Same host, a PID that cannot exist.
  await fs.writeFile(lock, JSON.stringify({ owner: 'crashed', host: os.hostname(), pid: 2 ** 22 + 12345, instance: 'old' }));
  assert.equal((await applyRenames(root, [{ from: 'a.mkv', to: 'b.mkv' }])).renamed, 1);
  // Same host and PID but another instance: a restarted container that reused PID 1.
  await fs.writeFile(lock, JSON.stringify({ owner: 'previous container', host: os.hostname(), pid: process.pid, instance: 'old' }));
  assert.equal((await applyRenames(root, [{ from: 'b.mkv', to: 'c.mkv' }])).renamed, 1);
});

test('recovery deletes the exact partial copy named in the journal, even when it is fresh', async () => {
  const root = await tempDir();
  const library = await tempDir();
  await fs.writeFile(path.join(root, 'ep.mkv'), 'original');
  const partial = `${PARTIAL_PREFIX}abc.mkv`;
  await fs.writeFile(path.join(library, partial), 'half');
  await fs.writeFile(
    path.join(root, UNDO_LOG),
    JSON.stringify([{ id: 'x', at: new Date().toISOString(), target: library, status: 'running', renames: [{ from: 'ep.mkv', to: 'ep.mkv', state: 'pending', partial }] }]),
  );
  const result = await undoLast(root);
  assert.deepEqual([result.restored, result.skipped, result.remaining], [0, [], 0], 'the never-moved file needs no restore');
  assert.deepEqual(await listing(library), [], 'partial copy removed without waiting for the age-based sweep');
  assert.deepEqual(await listing(root), ['.media-renamer-undo.json', 'ep.mkv']);
  assert.deepEqual(await readLog(root), [], 'the batch is gone from the undo log');
});

test('sweepPartials only removes old partial copies', async () => {
  const dir = await tempDir();
  const fresh = path.join(dir, `${PARTIAL_PREFIX}active.mkv`);
  const stale = path.join(dir, `${PARTIAL_PREFIX}stale.mkv`);
  await fs.writeFile(fresh, '');
  await fs.writeFile(stale, '');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(stale, old, old);
  assert.equal(await sweepPartials([dir]), 1);
  assert.deepEqual(await listing(dir), [path.basename(fresh)]);
});
