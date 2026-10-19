import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyRenames, buildPreview, undoLast, UNDO_LOG } from '../lib/renamer.js';

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeFiles(root, files) {
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
}

const metadata = {
  tmdbKey: 'test',
  findShow: async () => ({ source: 'TMDB', id: 1, name: 'Severance', year: 2022 }),
  findEpisode: async (_show, season, episode) => ({ title: `Folge ${season}.${episode}` }),
  findMovie: async (title, year) => ({ source: 'TMDB', id: 2, name: 'Der Pate', year }),
};

test('episodes and movies go to their own destinations, starting at the destination root', async () => {
  const downloads = await tempDir('mr-dl-');
  const tv = await tempDir('mr-tv-');
  const movies = await tempDir('mr-movies-');
  await writeFiles(downloads, ['release/Severance.S01E01.1080p/Severance.S01E01.1080p.mkv', 'extracted/The.Godfather.1972/The.Godfather.1972.mkv', 'notes/README.mkv']);

  const items = await buildPreview({
    root: downloads,
    targets: { episode: tv, movie: movies },
    files: ['release/Severance.S01E01.1080p/Severance.S01E01.1080p.mkv', 'extracted/The.Godfather.1972/The.Godfather.1972.mkv'],
    patterns: { episode: '{n}/Season {s}/{s00e00} {t}', movie: '{n} ({y})' },
    metadata,
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.target, i.newRel, i.status]),
    [
      ['episode', tv, 'Severance/Season 1/S01E01 Folge 1.1.mkv', 'ok'],
      ['movie', movies, 'Der Pate (1972).mkv', 'ok'],
    ],
    'a pattern without "/" places the movie directly in the movie folder, not under extracted/…',
  );

  const result = await applyRenames(
    downloads,
    items.map((i) => ({ from: i.rel, to: i.newRel, target: i.target })),
  );
  assert.equal(result.renamed, 2);
  assert.equal(result.target, null, 'no single shared destination');
  assert.deepEqual(result.targets.sort(), [tv, movies].sort());
  await fs.access(path.join(tv, 'Severance/Season 1/S01E01 Folge 1.1.mkv'));
  await fs.access(path.join(movies, 'Der Pate (1972).mkv'));

  const undone = await undoLast(downloads);
  assert.equal(undone.restored, 2);
  assert.deepEqual(undone.renames.map((r) => r.target).sort(), [tv, movies].sort());
  await fs.access(path.join(downloads, 'release/Severance.S01E01.1080p/Severance.S01E01.1080p.mkv'));
  await fs.access(path.join(downloads, 'extracted/The.Godfather.1972/The.Godfather.1972.mkv'));
});

test('one kind can move while the other is renamed in place', async () => {
  const downloads = await tempDir('mr-dl-');
  const tv = await tempDir('mr-tv-');
  await writeFiles(downloads, ['Show.S01E01.mkv', 'films/The.Godfather.1972.mkv']);
  const items = await buildPreview({
    root: downloads,
    targets: { episode: tv, movie: null },
    files: ['Show.S01E01.mkv', 'films/The.Godfather.1972.mkv'],
    metadata,
  });
  assert.deepEqual(
    items.map((i) => [i.target, i.newRel]),
    [
      [tv, 'Severance - S01E01 - Folge 1.1.mkv'],
      [null, 'films/Der Pate (1972).mkv'],
    ],
    'in-place renames keep their subfolder',
  );
});

test('conflicts are checked inside each destination separately', async () => {
  const downloads = await tempDir('mr-dl-');
  const tv = await tempDir('mr-tv-');
  const movies = await tempDir('mr-movies-');
  await writeFiles(downloads, ['Show.S01E01.mkv', 'The.Godfather.1972.mkv']);
  await writeFiles(movies, ['Der Pate (1972).mkv']);
  // Same rendered name for both, but different destinations: not a duplicate.
  const items = await buildPreview({
    root: downloads,
    targets: { episode: tv, movie: movies },
    files: ['Show.S01E01.mkv', 'The.Godfather.1972.mkv'],
    patterns: { episode: 'Der Pate ({y})', movie: '{n} ({y})' },
    metadata: { ...metadata, findShow: async () => ({ source: 'TMDB', id: 1, name: 'x', year: 1972 }) },
  });
  assert.deepEqual(
    items.map((i) => i.status),
    ['ok', 'conflict'],
    'only the movie collides, with the file already in the movie folder',
  );
});

test('undo still understands journals that record one destination per batch', async () => {
  const downloads = await tempDir('mr-dl-');
  const library = await tempDir('mr-lib-');
  await writeFiles(library, ['moved.mkv']);
  await fs.writeFile(
    path.join(downloads, UNDO_LOG),
    JSON.stringify([{ id: 'old', at: '2026-10-16T00:00:00Z', target: library, status: 'complete', renames: [{ from: 'orig.mkv', to: 'moved.mkv', state: 'done' }] }]),
  );
  const undone = await undoLast(downloads);
  assert.equal(undone.restored, 1);
  assert.equal(undone.target, library);
  await fs.access(path.join(downloads, 'orig.mkv'));
});

test('a destination must be an absolute folder', async () => {
  const downloads = await tempDir('mr-dl-');
  await writeFiles(downloads, ['a.mkv']);
  await assert.rejects(applyRenames(downloads, [{ from: 'a.mkv', to: 'b.mkv', target: 'relative/dir' }]), /absolute/);
});
