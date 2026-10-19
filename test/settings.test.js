import './isolated-config.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { envSettings, mergeSettings, readSavedSettings, sanitizeSettings, writeSavedSettings } from '../lib/settings.js';

const CLI = path.resolve(import.meta.dirname, '../bin/media-renamer.js');

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function runCli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

test('environment defaults: per-kind targets, MEDIA_RENAMER_TARGET as fallback, patterns', () => {
  assert.deepEqual(envSettings({}).targets, { episode: null, movie: null });
  assert.equal(envSettings({}).move, false);
  const shared = envSettings({ MEDIA_RENAMER_TARGET: '/lib' });
  assert.deepEqual([shared.targets, shared.move], [{ episode: '/lib', movie: '/lib' }, true]);
  const split = envSettings({ MEDIA_RENAMER_TARGET: '/lib', MEDIA_RENAMER_MOVIE_TARGET: '/films', MEDIA_RENAMER_TV_TARGET: '' });
  assert.deepEqual(split.targets, { episode: null, movie: '/films' }, 'an empty per-kind value overrides the shared one');
  assert.equal(envSettings({ MEDIA_RENAMER_MOVIE_PATTERN: '{n} ({y})/{n} ({y})' }).patterns.movie, '{n} ({y})/{n} ({y})');
  assert.throws(() => envSettings({ MEDIA_RENAMER_EPISODE_PATTERN: '{bogus}' }), /MEDIA_RENAMER_EPISODE_PATTERN/);
  assert.throws(() => envSettings({ MEDIA_RENAMER_TV_TARGET: 'relative' }), /absolute/);
});

test('saved settings override the environment field by field; a broken file is ignored', async () => {
  const dir = await tempDir('mr-settings-');
  const file = path.join(dir, 'nested', 'settings.json');
  await writeSavedSettings(file, { patterns: { movie: '{n} ({y})/{n} ({y})' }, targets: { movie: null }, language: 'fr' });
  const saved = await readSavedSettings(file);
  const merged = mergeSettings(envSettings({ MEDIA_RENAMER_TARGET: '/lib', MEDIA_RENAMER_LANGUAGE: 'de-DE' }), saved.settings);
  assert.equal(merged.patterns.movie, '{n} ({y})/{n} ({y})');
  assert.equal(merged.patterns.episode, '{n} - {s00e00} - {t}', 'unsaved fields keep the default');
  assert.deepEqual(merged.targets, { episode: '/lib', movie: null });
  assert.equal(merged.language, 'fr');

  await fs.writeFile(file, '{ not json');
  const broken = await readSavedSettings(file);
  assert.deepEqual(broken.settings, {});
  assert.match(broken.problems[0], /not valid JSON/);

  const lenient = sanitizeSettings({ patterns: { episode: '{n} {zzz}', movie: '{n}' }, region: 'GERMANY' });
  assert.deepEqual(lenient.settings, { patterns: { movie: '{n}' } }, 'invalid fields are dropped, valid ones kept');
  assert.equal(lenient.problems.length, 2);
  assert.throws(() => sanitizeSettings({ move: 'yes' }, { strict: true }), /move/);
});

test('CLI routes episodes and movies to their own targets and reads saved defaults', async () => {
  const downloads = await tempDir('mr-dl-');
  const tv = await tempDir('mr-tv-');
  const movies = await tempDir('mr-movies-');
  const config = await tempDir('mr-cfg-');
  await fs.writeFile(path.join(downloads, 'Show.S01E01.mkv'), '');
  await fs.mkdir(path.join(downloads, 'extracted'));
  await fs.writeFile(path.join(downloads, 'extracted', 'The.Godfather.1972.mkv'), '');
  // Offline: no TMDB key and an unreachable metadata lookup are fine; parsed names are used (status "warning").
  const env = { MEDIA_RENAMER_CONFIG_DIR: config, TMDB_API_KEY: '', NODE_OPTIONS: '' };
  await fs.writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ version: 1, patterns: { episode: '{n}/Season {s}/{s00e00}', movie: '{n} ({y})' }, targets: { episode: tv, movie: movies }, move: true }),
  );

  const settings = await runCli(['settings', '--format', 'tsv'], { env });
  assert.match(settings.stdout, new RegExp(`tv destination\\t${tv}`));
  assert.match(settings.stdout, /episode pattern\t\{n\}\/Season \{s\}\/\{s00e00\}/);

  // A plan in JSON Lines with kinds but no targets uses the saved per-kind destinations.
  const plan = [
    { rel: 'Show.S01E01.mkv', kind: 'episode', newRel: 'Show/Season 1/S01E01.mkv', status: 'ok' },
    { rel: 'extracted/The.Godfather.1972.mkv', kind: 'movie', newRel: 'The Godfather (1972).mkv', status: 'ok' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
  const dry = await runCli(['apply', downloads, '--plan', '-', '--dry-run', '--format', 'tsv', '-q'], { input: plan, env });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.stdout, `Show.S01E01.mkv\tShow/Season 1/S01E01.mkv\t${tv}\nextracted/The.Godfather.1972.mkv\tThe Godfather (1972).mkv\t${movies}\n`);

  // --movie-target '' renames movies in place while episodes still move.
  const overridden = await runCli(['apply', downloads, '--plan', '-', '--movie-target', '', '--format', 'json', '-q'], {
    input: plan.replace('"newRel":"The Godfather (1972).mkv"', '"newRel":"extracted/The Godfather (1972).mkv"'),
    env,
  });
  assert.equal(overridden.code, 0, overridden.stderr);
  const result = JSON.parse(overridden.stdout);
  assert.deepEqual(result.targets, [tv]);
  await fs.access(path.join(tv, 'Show/Season 1/S01E01.mkv'));
  await fs.access(path.join(downloads, 'extracted', 'The Godfather (1972).mkv'));

  const undone = await runCli(['undo', downloads, '--format', 'json', '-q'], { env });
  assert.equal(JSON.parse(undone.stdout).restored, 2);
  await fs.access(path.join(downloads, 'Show.S01E01.mkv'));
  await fs.access(path.join(downloads, 'extracted', 'The.Godfather.1972.mkv'));
});

test('CLI rejects target flags on commands that do not move files', async () => {
  const dir = await tempDir('mr-dl-');
  const result = await runCli(['scan', dir, '--tv-target', dir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--tv-target is only used by preview and apply/);
});
