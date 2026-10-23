import './isolated-config.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { MetadataClient } from '../lib/metadata.ts';
import { applyRenames, buildPreview, InputError, resolveRoot, scanFolder, undoLast, UNDO_LOG } from '../lib/renamer.ts';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../bin/media-renamer.ts');

async function tempLibrary(files) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-renamer-')));
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
  return root;
}

const fakeMetadata = {
  tmdbKey: 'test',
  findShow: async (name) => (name === 'Breaking Bad' ? { source: 'TVmaze', id: 169, name: 'Breaking Bad', year: 2008 } : null),
  findEpisode: async () => ({ title: 'Cat’s in the Bag...', airdate: '2008-01-27' }),
  findMovie: async (title, year) => ({ source: 'TMDB', id: 603, name: title, year }),
};

test('previews, applies and undoes a batch', async () => {
  const root = await tempLibrary(['Breaking.Bad.S01E02.720p.mkv', 'movies/The.Matrix.1999.1080p.mp4', 'notes.txt']);
  const { files } = await scanFolder(root);
  assert.deepEqual(files, ['Breaking.Bad.S01E02.720p.mkv', 'movies/The.Matrix.1999.1080p.mp4']);

  const items = await buildPreview({ root, files, metadata: fakeMetadata });
  assert.deepEqual(
    items.map((i) => [i.status, i.newRel]),
    [
      ['ok', 'Breaking Bad - S01E02 - Cat’s in the Bag.mkv'],
      ['ok', 'movies/The Matrix (1999).mp4'],
    ],
  );

  const result = await applyRenames(root, items.map((i) => ({ from: i.rel, to: i.newRel })));
  assert.equal(result.renamed, 2);
  await fs.access(path.join(root, 'movies/The Matrix (1999).mp4'));

  const undone = await undoLast(root);
  assert.equal(undone.restored, 2);
  await fs.access(path.join(root, 'Breaking.Bad.S01E02.720p.mkv'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, UNDO_LOG), 'utf8')), []);
});

test('flags conflicts and refuses paths outside the folder', async () => {
  const root = await tempLibrary(['Arrival.2016.mkv', 'Arrival (2016).mkv', 'Arrival.2016.720p.mkv']);
  const items = await buildPreview({ root, files: ['Arrival.2016.mkv', 'Arrival.2016.720p.mkv'], metadata: fakeMetadata });
  assert.deepEqual(items.map((i) => i.status), ['conflict', 'conflict']);

  await assert.rejects(applyRenames(root, [{ from: 'Arrival.2016.mkv', to: '../escape.mkv' }]), InputError);
  await assert.rejects(applyRenames(root, [{ from: 'Arrival.2016.mkv', to: 'Arrival (2016).mkv' }]), /already exists/);
});

test('metadata client picks the TVmaze show matching the year', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.includes('/search/shows')
      ? [{ show: { id: 1, name: 'Doctor Who', premiered: '1963-11-23' } }, { show: { id: 210, name: 'Doctor Who', premiered: '2005-03-26' } }]
      : { name: 'Rose', airdate: '2005-03-26' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const client = new MetadataClient({ fetchImpl });
  const show = await client.findShow('Doctor Who', 2005);
  assert.equal(show.id, 210);
  assert.equal((await client.findEpisode(show.id, 1, 1)).title, 'Rose');
  await client.findShow('doctor who', 2005);
  assert.equal(calls.length, 2, 'repeated lookups are cached');
  assert.equal(await client.findMovie('Anything'), null, 'movies need a TMDB key');
});

test('CLI applies a piped plan, prints JSON and undoes it', async () => {
  const root = await tempLibrary(['a.mkv']);
  const plan = JSON.stringify({ root, items: [{ rel: 'a.mkv', newRel: 'Renamed/b.mkv', status: 'ok' }] });
  const child = execFile(process.execPath, [CLI, 'apply', root, '--plan', '-', '--format', 'json', '--quiet']);
  child.stdin.end(plan);
  const output = await new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
  });
  assert.deepEqual(JSON.parse(output).renames, [{ from: 'a.mkv', to: 'Renamed/b.mkv', target: null }]);

  const { stdout } = await run(process.execPath, [CLI, 'undo', root, '--format', 'tsv', '-q']);
  assert.equal(stdout, 'Renamed/b.mkv\ta.mkv\t\n', 'third TSV column (destination) is empty for in-place renames');
  await fs.access(path.join(root, 'a.mkv'));
});

test('CLI scan emits NUL-separated TSV and reports usage errors with exit code 2', async () => {
  const root = await tempLibrary(['Show.S01E01.mkv']);
  const { stdout } = await run(process.execPath, [CLI, 'scan', root, '--format', 'tsv', '-0']);
  assert.equal(stdout, 'Show.S01E01.mkv\tepisode\tShow\t\t1\t1\0');

  await assert.rejects(run(process.execPath, [CLI, 'preview']), (error) => error.code === 2);
  await assert.rejects(run(process.execPath, [CLI, 'scan', path.join(root, 'missing')]), (error) => error.code === 1);
  assert.equal(await resolveRoot(root), root);
});
