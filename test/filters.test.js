import './isolated-config.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { envFlag, filterDefaults } from '../lib/config.js';
import { isSamplePath, isVideoFile } from '../lib/parse.js';
import { buildPreview, scanFolder } from '../lib/renamer.js';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../bin/media-renamer.js');

async function library() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-filter-')));
  const files = [
    'Movie.2010.1080p/Movie.2010.1080p.mkv',
    'Movie.2010.1080p/movie.2010.1080p-sample.mkv',
    'Movie.2010.1080p/Sample/movie-sample.mkv',
    'Movie.2010.1080p/Samples/clip.mkv',
    'Movie.2010.1080p/Movie.2010.en.srt',
    'Show.S01E01.mkv',
    'Show.S01E01.SAMPLE.mp4',
    'The.Samples.2015.mkv',
    'notes.txt',
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), '');
  }
  return root;
}

test('recognises samples by folder and by name, without false positives', () => {
  for (const sample of ['Sample/x.mkv', 'a/Samples/x.mkv', 'sample.mkv', 'movie-sample.mkv', 'Movie.2010.SAMPLE.mkv', 'x_sample_1.mkv', 'Movie [sample].mkv']) {
    assert.ok(isSamplePath(sample), sample);
  }
  for (const real of ['The.Samples.2015.mkv', 'Sampled.mkv', 'Samplers/x.mkv', 'Free Samplecraft.mkv']) {
    assert.ok(!isSamplePath(real), real);
  }
  assert.ok(isVideoFile('a.MKV') && isVideoFile('a.ts') && !isVideoFile('a.srt'));
});

test('scan skips samples by default and subtitles when video-only', async () => {
  const root = await library();
  const defaults = await scanFolder(root);
  assert.deepEqual(defaults.files, ['Movie.2010.1080p/Movie.2010.1080p.mkv', 'Movie.2010.1080p/Movie.2010.en.srt', 'Show.S01E01.mkv', 'The.Samples.2015.mkv']);
  assert.deepEqual(defaults.excluded, { samples: 4, nonVideo: 0 });

  const videoOnly = await scanFolder(root, { videoOnly: true });
  assert.ok(!videoOnly.files.some((f) => f.endsWith('.srt')));
  assert.deepEqual(videoOnly.excluded, { samples: 4, nonVideo: 1 });

  const everything = await scanFolder(root, { excludeSamples: false });
  assert.equal(everything.files.length, 8);
});

test('explicit files are filtered too and reported as skipped with the reason', async () => {
  const root = await library();
  const metadata = { tmdbKey: '', findShow: async () => null, findEpisode: async () => null, findMovie: async () => null };
  const items = await buildPreview({
    root,
    files: ['Show.S01E01.SAMPLE.mp4', 'Movie.2010.1080p/Movie.2010.en.srt', 'notes.txt'],
    filters: { videoOnly: true },
    metadata,
  });
  assert.deepEqual(
    items.map((i) => [i.status, i.message]),
    [
      ['skipped', 'Sample file (sample filter)'],
      ['skipped', 'Not a video file (video-only filter)'],
      ['skipped', 'Not a media file'],
    ],
  );
});

test('filter defaults come from the environment', () => {
  assert.deepEqual(filterDefaults({}), { videoOnly: false, excludeSamples: true });
  assert.deepEqual(filterDefaults({ MEDIA_RENAMER_VIDEO_ONLY: 'yes', MEDIA_RENAMER_INCLUDE_SAMPLES: 'true' }), { videoOnly: true, excludeSamples: false });
  assert.equal(envFlag('', true), true);
  assert.throws(() => envFlag('maybe', false), /Invalid boolean/);
});

test('CLI flags override environment defaults', async () => {
  const root = await library();
  const scan = async (args, env = {}) => {
    const { stdout } = await run(process.execPath, [CLI, 'scan', root, '--format', 'json', '-q', ...args], { env: { ...process.env, ...env } });
    return JSON.parse(stdout);
  };
  const viaEnv = await scan([], { MEDIA_RENAMER_VIDEO_ONLY: 'true' });
  assert.equal(viaEnv.filters.videoOnly, true);
  assert.ok(!viaEnv.files.some((f) => f.rel.endsWith('.srt')));

  const allTypes = await scan(['--all-types'], { MEDIA_RENAMER_VIDEO_ONLY: 'true' });
  assert.ok(allTypes.files.some((f) => f.rel.endsWith('.srt')));

  const withSamples = await scan(['--include-samples']);
  assert.equal(withSamples.excluded.samples, 0);

  await assert.rejects(run(process.execPath, [CLI, 'scan', root, '--video-only', '--all-types']), (error) => error.code === 2);
});
