import './isolated-config.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { moveFile } from '../lib/mover.ts';
import { applyRenames, buildPreview, freeName, undoLast } from '../lib/renamer.ts';
import { createServer } from '../server.ts';

const tempDir = async (prefix) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
const write = async (root, rel, content) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
};
const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');
const missing = (root, rel) => fs.access(path.join(root, rel)).then(() => false, () => true);
const metadata = { tmdbKey: '', findShow: async () => null, findEpisode: async () => null, findMovie: async () => null };

test('preview reports file sizes, the size of the file in the way, and what the item was before the conflict', async () => {
  const downloads = await tempDir('mr-dl-');
  const library = await tempDir('mr-lib-');
  await write(downloads, 'Heat.1995.2160p.mkv', 'new and bigger');
  await write(downloads, 'Alien.1979.mkv', 'a');
  await write(downloads, 'Alien.1979.1080p.mkv', 'bb');
  await write(library, 'Heat (1995).mkv', 'old');

  const items = await buildPreview({ root: downloads, targets: { episode: null, movie: library }, files: ['Heat.1995.2160p.mkv', 'Alien.1979.mkv', 'Alien.1979.1080p.mkv'], metadata });
  const byRel = Object.fromEntries(items.map((item) => [item.rel, item]));

  const heat = byRel['Heat.1995.2160p.mkv'];
  assert.equal(heat.status, 'conflict');
  assert.equal(heat.message, 'A file with the new name already exists');
  assert.deepEqual([heat.size, heat.existingSize], [14, 3]);
  assert.deepEqual(heat.conflict, { reason: 'exists', status: 'warning', message: 'No TMDB key; using parsed name' });

  for (const rel of ['Alien.1979.mkv', 'Alien.1979.1080p.mkv']) {
    assert.equal(byRel[rel].status, 'conflict');
    assert.equal(byRel[rel].conflict.reason, 'duplicate');
    assert.equal(byRel[rel].existingSize, undefined);
  }
  assert.deepEqual([byRel['Alien.1979.mkv'].size, byRel['Alien.1979.1080p.mkv'].size], [1, 2]);
});

test('freeName numbers the new file, skipping names on disk and names already planned', async () => {
  const library = await tempDir('mr-free-');
  await write(library, 'Heat (1995).mkv', '');
  await write(library, 'Heat (1995) (2).mkv', '');
  assert.equal(await freeName(library, 'Heat (1995).mkv'), 'Heat (1995) (3).mkv');
  assert.equal(await freeName(library, 'Heat (1995).mkv', ['heat (1995) (3).MKV']), 'Heat (1995) (4).mkv');
  assert.equal(await freeName(library, 'Show/Season 01/Show - S01E01.mkv'), 'Show/Season 01/Show - S01E01 (2).mkv');
  assert.equal(await freeName(library, 'Heat (1995).de.srt'), 'Heat (1995) (2).de.srt');
  await assert.rejects(freeName(library, '../outside.mkv'), /outside/);
});

test('overwrite replaces the file in the way; undo brings the new file back but not the replaced one', async () => {
  const downloads = await tempDir('mr-dl-');
  const library = await tempDir('mr-lib-');
  await write(downloads, 'Heat.1995.2160p.mkv', 'new');
  await write(library, 'Heat (1995).mkv', 'old');

  await assert.rejects(applyRenames(downloads, [{ from: 'Heat.1995.2160p.mkv', to: 'Heat (1995).mkv', target: library }]), /already exists/);
  const result = await applyRenames(downloads, [{ from: 'Heat.1995.2160p.mkv', to: 'Heat (1995).mkv', target: library, overwrite: true }]);
  assert.equal(result.renamed, 1);
  assert.equal(result.renames[0].replaced, true);
  assert.equal(result.removed, undefined);
  assert.equal(await read(library, 'Heat (1995).mkv'), 'new');

  const undone = await undoLast(downloads);
  assert.equal(undone.restored, 1);
  assert.equal(await read(downloads, 'Heat.1995.2160p.mkv'), 'new');
  assert.ok(await missing(library, 'Heat (1995).mkv'));
});

test('a copy across disks also replaces the file in the way only when asked', async () => {
  const dir = await tempDir('mr-exdev-');
  await write(dir, 'new.mkv', 'new');
  await write(dir, 'old.mkv', 'old');
  const acrossDisks = async () => {
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  };
  await assert.rejects(moveFile(path.join(dir, 'new.mkv'), path.join(dir, 'old.mkv'), { rename: acrossDisks }), /exists/);
  assert.equal(await read(dir, 'old.mkv'), 'old');
  assert.equal(await moveFile(path.join(dir, 'new.mkv'), path.join(dir, 'old.mkv'), { rename: acrossDisks, overwrite: true }), 'copied');
  assert.equal(await read(dir, 'old.mkv'), 'new');
  assert.ok(await missing(dir, 'new.mkv'));
});

test('overwrite never replaces a folder', async () => {
  const downloads = await tempDir('mr-dl-');
  await write(downloads, 'Heat.1995.mkv', 'new');
  await fs.mkdir(path.join(downloads, 'Heat (1995).mkv'));
  await assert.rejects(applyRenames(downloads, [{ from: 'Heat.1995.mkv', to: 'Heat (1995).mkv', overwrite: true }]), /Only files can be replaced/);
});

test('never replaces or deletes a file that another rename in the same batch uses', async () => {
  const dir = await tempDir('mr-batch-');
  await write(dir, 'a.mkv', 'A');
  await write(dir, 'b.mkv', 'B');
  await write(dir, 'x.mkv', 'X');
  await assert.rejects(
    applyRenames(dir, [{ from: 'a.mkv', to: 'b.mkv', overwrite: true }, { from: 'b.mkv', to: 'c.mkv' }]),
    /renamed in the same batch/,
  );
  await assert.rejects(applyRenames(dir, [{ from: 'x.mkv', to: 'b.mkv', overwrite: true }], { remove: ['b.mkv'] }), /listed twice/);
  await assert.rejects(applyRenames(dir, [{ from: 'x.mkv', to: 'y.mkv' }], { remove: ['y.mkv'] }), /listed twice/);
  assert.deepEqual(await Promise.all(['a.mkv', 'b.mkv', 'x.mkv'].map((file) => read(dir, file))), ['A', 'B', 'X'], 'nothing was touched');
});

test('removes skipped source files after the renames, and only regular files inside the folder', async () => {
  const downloads = await tempDir('mr-dl-');
  await write(downloads, 'Arrival.2016.mkv', 'a');
  await write(downloads, 'dupe/Heat.1995.mkv', 'b');

  const result = await applyRenames(downloads, [{ from: 'Arrival.2016.mkv', to: 'Arrival (2016).mkv' }], { remove: ['dupe/Heat.1995.mkv'] });
  assert.deepEqual([result.renamed, result.removed], [1, ['dupe/Heat.1995.mkv']]);
  assert.ok(await missing(downloads, 'dupe/Heat.1995.mkv'));

  await write(downloads, 'Only.Delete.mkv', 'c');
  assert.deepEqual((await applyRenames(downloads, [], { remove: ['Only.Delete.mkv'] })).removed, ['Only.Delete.mkv']);
  await assert.rejects(applyRenames(downloads, [], { remove: ['../elsewhere.mkv'] }), /outside/);
  await assert.rejects(applyRenames(downloads, [], { remove: ['dupe'] }), /Not a regular file/);
  await assert.rejects(applyRenames(downloads, [{ from: 'Arrival (2016).mkv', to: 'A.mkv' }], { remove: ['Arrival (2016).mkv'] }), /listed twice/);
  await assert.rejects(applyRenames(downloads, []), /Nothing to rename/);
});

test('the web API offers a free name, and applies overwrite and removal as one job', async () => {
  const downloads = await tempDir('mr-dl-');
  const library = await tempDir('mr-lib-');
  await write(downloads, 'Heat.1995.2160p.mkv', 'new');
  await write(downloads, 'Heat.1995.720p.mkv', 'worse');
  await write(library, 'Heat (1995).mkv', 'old');

  const server = createServer(loadConfig({ MEDIA_RENAMER_ROOTS: `${downloads},${library}` }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (pathname, body) =>
    new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers: { 'Content-Type': 'application/json' } }, (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(text) }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
  try {
    const free = await post('/api/free-name', { root: downloads, target: library, rel: 'Heat (1995).mkv', taken: [] });
    assert.deepEqual(free.json, { newRel: 'Heat (1995) (2).mkv' });

    const started = await post('/api/apply', {
      root: downloads,
      renames: [{ from: 'Heat.1995.2160p.mkv', to: 'Heat (1995).mkv', target: library, overwrite: true }],
      remove: ['Heat.1995.720p.mkv'],
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.label, 'Rename 1 file(s), delete 1');
    let job = started.json;
    for (let i = 0; i < 100 && ['queued', 'running'].includes(job.state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await post('/api/job', { id: job.id })).json.job;
    }
    assert.equal(job.state, 'finished', JSON.stringify(job));
    assert.deepEqual(job.result.removed, ['Heat.1995.720p.mkv']);
    assert.equal(await read(library, 'Heat (1995).mkv'), 'new');
    assert.ok(await missing(downloads, 'Heat.1995.720p.mkv'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
