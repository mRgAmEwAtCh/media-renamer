import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { audioToolsAvailable, probeFile } from '../lib/audio.js';
import { removeEmptyFolders, runImport, waitForStableFiles } from '../lib/importer.js';
import { undoLast } from '../lib/renamer.js';
import { envSettings, mergeSettings } from '../lib/settings.js';

const run = promisify(execFile);
const hasFfmpeg = await audioToolsAvailable();

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeFiles(root, files) {
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
}

function recorder() {
  const steps = new Map();
  let files = [];
  const control = {
    signal: new AbortController().signal,
    stopSignal: new AbortController().signal,
    onProgress: () => {},
    defineSteps: (list) => list.forEach(({ id }) => steps.set(id, { state: 'pending', detail: null })),
    step: (id, patch) => Object.assign(steps.get(id), patch),
    setFiles: (rows) => {
      files = rows.map((row) => ({ ...row }));
    },
  };
  return { control, steps, files: () => files };
}

const metadata = {
  tmdbKey: 'test',
  findShow: async (name) => (name === 'Severance' ? { source: 'TMDB', id: 1, name: 'Severance', year: 2022 } : null),
  findEpisode: async (_show, season, episode) => ({ title: `Folge ${episode}` }),
  findMovie: async (title, year) => (title === 'The Matrix' ? { source: 'TMDB', id: 2, name: 'Matrix', year } : null),
};

async function library() {
  const root = await tempDir('mr-import-');
  for (const dir of ['Downloads', 'Serien', 'Filme']) await fs.mkdir(path.join(root, dir));
  return {
    root,
    downloads: path.join(root, 'Downloads'),
    settings: mergeSettings(envSettings({}), {
      targets: { episode: path.join(root, 'Serien'), movie: path.join(root, 'Filme') },
      move: true,
      patterns: { episode: '{n}/Season {s}/{s00e00} {t}', movie: '{n} ({y})' },
      filters: { videoOnly: true, excludeSamples: true },
    }),
  };
}

test('imports confident matches into the TV and movie libraries and leaves the rest for review', async () => {
  const { root, downloads, settings } = await library();
  const release = path.join(downloads, 'extracted', 'Release');
  await writeFiles(release, ['Severance.S01E02.1080p.mkv', 'The.Matrix.1999.mkv', 'Unknown.Thing.2001.mkv', 'Sample/sample.mkv', 'info.nfo']);
  const { control, steps, files } = recorder();

  const result = await runImport({ root: downloads, target: release, settings, metadata, stableSeconds: 0, control });
  assert.deepEqual(result, { imported: 2, converted: 0, review: 1, failed: 0, cancelled: false, targets: result.targets });
  await fs.access(path.join(root, 'Serien', 'Severance', 'Season 1', 'S01E02 Folge 2.mkv'));
  await fs.access(path.join(root, 'Filme', 'Matrix (1999).mkv'));
  await fs.access(path.join(release, 'Unknown.Thing.2001.mkv'));

  assert.deepEqual(Object.fromEntries([...steps].map(([id, s]) => [id, s.state])), {
    wait: 'done',
    scan: 'done',
    lookup: 'done',
    audio: 'skipped',
    process: 'done',
    cleanup: 'skipped',
  });
  assert.match(steps.get('scan').detail, /3 media files; skipped 1 sample/);
  assert.equal(steps.get('lookup').detail, '2 to import, 1 needs review'.replace('needs', 'need'));
  assert.deepEqual(
    files().map((row) => [path.basename(row.rel), row.outcome]),
    [
      ['Severance.S01E02.1080p.mkv', 'moved'],
      ['The.Matrix.1999.mkv', 'moved'],
      ['Unknown.Thing.2001.mkv', 'review'],
    ],
  );

  const undone = await undoLast(downloads);
  assert.equal(undone.restored, 2, 'an import is undoable like a manual rename');
  await fs.access(path.join(release, 'The.Matrix.1999.mkv'));
});

test('includes warnings when configured', async () => {
  const { root, downloads, settings } = await library();
  await writeFiles(downloads, ['job/Unknown.Thing.2001.mkv']);
  settings.automation.includeWarnings = true;
  const { control } = recorder();
  const result = await runImport({ root: downloads, target: path.join(downloads, 'job'), settings, metadata, stableSeconds: 0, control });
  assert.equal(result.imported, 1);
  await fs.access(path.join(root, 'Filme', 'Unknown Thing (2001).mkv'));
});

test('removes extraction folders left empty, keeps ones with leftovers', async () => {
  const { downloads, settings } = await library();
  await writeFiles(downloads, ['a/Release/The.Matrix.1999.mkv', 'b/Release/The.Matrix.1999.mkv', 'b/Release/info.nfo']);
  settings.automation.cleanupEmptyFolders = true;
  const first = recorder();
  await runImport({ root: downloads, target: path.join(downloads, 'a'), settings, metadata, stableSeconds: 0, control: first.control });
  assert.equal(first.steps.get('cleanup').detail, 'Removed 2 empty folders');
  await assert.rejects(fs.access(path.join(downloads, 'a')));

  const removed = await removeEmptyFolders(path.join(downloads, 'b'), downloads);
  assert.equal(removed, 0, 'a folder with any file left is kept');
  assert.equal(await removeEmptyFolders(downloads, downloads), 0, 'the root itself is never removed');
});

test('waits until files stop changing', async () => {
  const dir = await tempDir('mr-stable-');
  const file = path.join(dir, 'growing.mkv');
  await fs.writeFile(file, 'a');
  const started = Date.now();
  const writer = setInterval(() => fs.appendFile(file, 'more'), 100);
  setTimeout(() => clearInterval(writer), 600);
  await waitForStableFiles(dir, { seconds: 0.4, pollMs: 100 });
  assert.ok(Date.now() - started >= 800, 'kept waiting while the file grew, then 0.4s more');
});

test('a cancelled import moves nothing', async () => {
  const { downloads, settings } = await library();
  await writeFiles(downloads, ['job/The.Matrix.1999.mkv']);
  const { control } = recorder();
  const controller = new AbortController();
  controller.abort();
  control.signal = controller.signal;
  const result = await runImport({ root: downloads, target: path.join(downloads, 'job'), settings, metadata, stableSeconds: 0, control });
  assert.equal(result.cancelled, true);
  await fs.access(path.join(downloads, 'job', 'The.Matrix.1999.mkv'));
});

test('adds a Dolby Digital Plus track to German DTS movies while importing', { skip: hasFfmpeg ? false : 'ffmpeg/ffprobe not installed (runs in the Docker image)' }, async () => {
  const { root, downloads, settings } = await library();
  const release = path.join(downloads, 'Release');
  await fs.mkdir(release);
  const sample = async (name) =>
    run('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'dca', '-strict', '-2', '-ac', '6', '-metadata:s:a:0', 'language=ger',
      path.join(release, name),
    ]);
  await sample('The.Matrix.1999.mkv');
  await sample('Severance.S01E02.mkv');
  settings.automation.audioFix = { enabled: true, episodes: false, languages: ['de'], bitrate: '640k' };
  const { control, steps, files } = recorder();

  const result = await runImport({ root: downloads, target: release, settings, metadata, stableSeconds: 0, control });
  assert.equal(result.imported, 2);
  assert.equal(result.converted, 1, 'only the movie; episodes are off by default');
  assert.equal(steps.get('audio').detail, '1 file gets a Dolby Digital Plus track');
  const movie = await probeFile(path.join(root, 'Filme', 'Matrix (1999).mkv'));
  assert.deepEqual(movie.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name), ['dts', 'eac3']);
  const episode = await probeFile(path.join(root, 'Serien', 'Severance', 'Season 1', 'S01E02 Folge 2.mkv'));
  assert.deepEqual(episode.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name), ['dts']);
  assert.deepEqual(files().map((row) => row.outcome).sort(), ['converted', 'moved']);
});
