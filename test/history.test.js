import './isolated-config.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canDismiss } from '../lib/job-attention.ts';
import { JobManager } from '../lib/jobs.ts';

/** Run one job to its end and return its id. */
async function finish(manager, result, { fail = false } = {}) {
  const job = manager.start({ kind: 'import', root: '/media', label: 'x', run: async () => (fail ? Promise.reject(new Error('disk full')) : result) });
  while (['queued', 'running'].includes(manager.get(job.id).state)) await new Promise((resolve) => setTimeout(resolve, 5));
  return job.id;
}

test('only finished jobs that need nothing more can be dismissed', () => {
  const finished = (result) => ({ kind: 'import', state: 'finished', label: 'x', result });
  assert.equal(canDismiss(finished({ imported: 2, review: 0, failed: 0 })), true);
  assert.equal(canDismiss({ kind: 'apply', state: 'finished', label: 'x', result: { renamed: 1, failed: [] } }), true);
  assert.equal(canDismiss(finished({ imported: 0, review: 1, failed: 0 })), false, 'files need review');
  assert.equal(canDismiss({ kind: 'apply', state: 'finished', label: 'x', result: { renamed: 1, failed: [{}] } }), false, 'a file failed');
  for (const state of ['queued', 'running', 'cancelling', 'cancelled', 'failed', 'interrupted']) {
    assert.equal(canDismiss({ kind: 'apply', state, label: 'x', result: { renamed: 1, failed: [] } }), false, state);
  }
});

test('removes one dismissable job from the history and keeps the rest', async () => {
  const storeFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-history-')), 'jobs.json');
  const manager = new JobManager({ storeFile });
  const done = await finish(manager, { imported: 1, review: 0, failed: 0, cancelled: false, targets: [] });
  const review = await finish(manager, { imported: 0, review: 1, failed: 0, cancelled: false, targets: [] });
  const failed = await finish(manager, null, { fail: true });

  await manager.remove(done);
  assert.deepEqual(manager.list().map((job) => job.id).sort(), [review, failed].sort());
  assert.deepEqual(JSON.parse(await fs.readFile(storeFile, 'utf8')).map((job) => job.id).sort(), [review, failed].sort(), 'saved');

  await assert.rejects(manager.remove(review), (error) => error.status === 409);
  await assert.rejects(manager.remove(failed), (error) => error.status === 409);
  await assert.rejects(manager.remove('nope'), (error) => error.status === 404);
});
