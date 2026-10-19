import './isolated-config.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hostnameOf, loadConfig } from '../lib/config.js';
import { applyRenames, buildPreview, moveFile, undoLast, UNDO_LOG } from '../lib/renamer.js';
import { createServer } from '../server.js';

const CLI = path.resolve(import.meta.dirname, '../bin/media-renamer.js');

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeFiles(root, files) {
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), `content of ${file}`);
  }
}

const offlineMetadata = {
  tmdbKey: '',
  findShow: async () => ({ source: 'TVmaze', id: 1, name: 'Show', year: 2020 }),
  findEpisode: async (_id, season, episode) => ({ title: `Episode ${season}.${episode}` }),
  findMovie: async () => null,
};

function runCli(args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
    child.stdin.end(input ?? '');
  });
}

describe('moving into a destination folder', () => {
  test('preview resolves names against the destination and flags conflicts there', async () => {
    const source = await tempDir('mr-src-');
    const library = await tempDir('mr-lib-');
    await writeFiles(source, ['Show.S01E01.mkv', 'Show.S01E02.mkv']);
    await writeFiles(library, ['Show/Season 01/Show - S01E02 - Episode 1.2.mkv']);

    const items = await buildPreview({
      root: source,
      target: library,
      files: ['Show.S01E01.mkv', 'Show.S01E02.mkv'],
      patterns: { episode: '{n}/Season {s00}/{n} - {s00e00} - {t}' },
      metadata: offlineMetadata,
    });
    assert.deepEqual(
      items.map((i) => [i.status, i.newRel]),
      [
        ['ok', 'Show/Season 01/Show - S01E01 - Episode 1.1.mkv'],
        ['conflict', 'Show/Season 01/Show - S01E02 - Episode 1.2.mkv'],
      ],
    );
  });

  test('files whose name is already right are still moved', async () => {
    const source = await tempDir('mr-src-');
    const library = await tempDir('mr-lib-');
    await writeFiles(source, ['Show - S01E01 - Episode 1.1.mkv']);
    const [item] = await buildPreview({ root: source, target: library, files: ['Show - S01E01 - Episode 1.1.mkv'], metadata: offlineMetadata });
    assert.equal(item.status, 'ok', 'same name in another folder is a move, not "unchanged"');
  });

  test('apply moves into the destination and undo moves back', async () => {
    const source = await tempDir('mr-src-');
    const library = await tempDir('mr-lib-');
    await writeFiles(source, ['in/a.mkv']);

    const result = await applyRenames(source, [{ from: 'in/a.mkv', to: 'Shows/A.mkv' }], { target: library });
    assert.equal(result.target, library);
    assert.equal(await fs.readFile(path.join(library, 'Shows/A.mkv'), 'utf8'), 'content of in/a.mkv');
    await assert.rejects(fs.access(path.join(source, 'in/a.mkv')));
    const log = JSON.parse(await fs.readFile(path.join(source, UNDO_LOG), 'utf8'));
    assert.equal(log[0].renames[0].target, library, 'undo log lives in the source and records each destination');

    const undone = await undoLast(source);
    assert.equal(undone.restored, 1);
    await fs.access(path.join(source, 'in/a.mkv'));
  });

  test('undo refuses a recorded destination the caller does not allow', async () => {
    const source = await tempDir('mr-src-');
    const library = await tempDir('mr-lib-');
    await writeFiles(source, ['a.mkv']);
    await applyRenames(source, [{ from: 'a.mkv', to: 'b.mkv' }], { target: library });
    await assert.rejects(
      undoLast(source, {
        checkTarget: async () => {
          throw new Error('not allowed');
        },
      }),
      /not allowed/,
    );
    const log = JSON.parse(await fs.readFile(path.join(source, UNDO_LOG), 'utf8'));
    assert.equal(log.length, 1, 'a refused undo keeps the batch');
  });

  test('cross-device moves copy, verify, preserve mtime and delete the source', async () => {
    const dir = await tempDir('mr-exdev-');
    await writeFiles(dir, ['from.mkv']);
    const mtime = new Date('2020-01-02T03:04:05Z');
    await fs.utimes(path.join(dir, 'from.mkv'), mtime, mtime);
    const exdev = async () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };

    assert.equal(await moveFile(path.join(dir, 'from.mkv'), path.join(dir, 'to.mkv'), { rename: exdev }), 'copied');
    await assert.rejects(fs.access(path.join(dir, 'from.mkv')));
    assert.equal(await fs.readFile(path.join(dir, 'to.mkv'), 'utf8'), 'content of from.mkv');
    assert.equal((await fs.stat(path.join(dir, 'to.mkv'))).mtime.getTime(), mtime.getTime());

    await writeFiles(dir, ['other.mkv']);
    await assert.rejects(moveFile(path.join(dir, 'other.mkv'), path.join(dir, 'to.mkv'), { rename: exdev }), { code: 'EEXIST' });
    assert.equal(await fs.readFile(path.join(dir, 'to.mkv'), 'utf8'), 'content of from.mkv', 'existing file untouched');
    await fs.access(path.join(dir, 'other.mkv'));
  });

  test('CLI --target and MEDIA_RENAMER_TARGET move files; plans keep their destination', async () => {
    const source = await tempDir('mr-src-');
    const library = await tempDir('mr-lib-');
    const other = await tempDir('mr-other-');
    await writeFiles(source, ['a.mkv', 'b.mkv', 'c.mkv']);

    const viaFlag = await runCli(['apply', source, '--target', library, '--plan', '-', '--format', 'tsv', '-q'], {
      input: JSON.stringify({ root: source, items: [{ rel: 'a.mkv', newRel: 'A/a.mkv', status: 'ok' }] }),
    });
    assert.equal(viaFlag.code, 0, viaFlag.stderr);
    assert.equal(viaFlag.stdout, `a.mkv\tA/a.mkv\t${library}\n`);
    await fs.access(path.join(library, 'A/a.mkv'));

    const viaEnv = await runCli(['apply', source, '--plan', '-', '--format', 'json', '-q'], {
      input: `${JSON.stringify({ rel: 'b.mkv', newRel: 'B/b.mkv', status: 'ok' })}\n`,
      env: { MEDIA_RENAMER_TARGET: library },
    });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.equal(JSON.parse(viaEnv.stdout).target, library);
    await fs.access(path.join(library, 'B/b.mkv'));

    const mismatch = await runCli(['apply', source, '--target', other, '--plan', '-', '-q'], {
      input: JSON.stringify({ root: source, target: library, items: [{ rel: 'c.mkv', newRel: 'c.mkv', status: 'ok' }] }),
    });
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.stderr, /Plan moves files to/);

    const inPlace = await runCli(['apply', source, '--target', '', '--plan', '-', '--format', 'tsv', '-q'], {
      input: `${JSON.stringify({ rel: 'c.mkv', newRel: 'C.mkv', status: 'ok' })}\n`,
      env: { MEDIA_RENAMER_TARGET: library },
    });
    assert.equal(inPlace.code, 0, inPlace.stderr);
    await fs.access(path.join(source, 'C.mkv'));
  });
});

describe('configuration', () => {
  test('defaults to loopback; public binding warns and accepts any host unless restricted', () => {
    const local = loadConfig({});
    assert.equal(local.host, '127.0.0.1');
    assert.ok(local.allowedHosts.has('localhost'));
    assert.deepEqual(local.warnings, []);

    const open = loadConfig({ HOST: '0.0.0.0' });
    assert.equal(open.allowedHosts, null);
    assert.equal(open.warnings.length, 3);

    const locked = loadConfig({ HOST: '0.0.0.0', MEDIA_RENAMER_ALLOWED_HOSTS: 'NAS.local', MEDIA_RENAMER_PASSWORD: 'x', MEDIA_RENAMER_ROOTS: '/media' });
    assert.ok(locked.allowedHosts.has('nas.local'));
    assert.deepEqual(locked.warnings, []);
  });

  test('reads secrets from *_FILE and validates values', async () => {
    const dir = await tempDir('mr-secret-');
    await fs.writeFile(path.join(dir, 'tmdb'), 'abc123\n');
    assert.equal(loadConfig({ TMDB_API_KEY_FILE: path.join(dir, 'tmdb') }).tmdbKey, 'abc123');
    assert.throws(() => loadConfig({ MEDIA_RENAMER_ROOTS: 'relative/path' }), /absolute/);
    assert.throws(() => loadConfig({ UMASK: '999' }), /UMASK/);
    assert.equal(loadConfig({ UMASK: '002' }).umask, 2);
  });

  test('parses Host headers', () => {
    assert.equal(hostnameOf('NAS.local:4173'), 'nas.local');
    assert.equal(hostnameOf('[::1]:4173'), '::1');
    assert.equal(hostnameOf('192.168.1.10'), '192.168.1.10');
  });
});

describe('web server on a NAS', () => {
  let server;
  let port;
  let media;
  let library;
  let movies;
  let outside;
  let configDir;

  function request(pathname, { method = 'GET', host = '127.0.0.1', body, password = 's3cret' } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Host: host };
      if (body) headers['Content-Type'] = 'application/json';
      if (password !== null) headers.Authorization = `Basic ${Buffer.from(`any:${password}`).toString('base64')}`;
      const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON (static file).
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const post = (pathname, body, options) => request(pathname, { method: 'POST', body, ...options });

  before(async () => {
    const base = await tempDir('mr-nas-');
    media = path.join(base, 'media');
    library = path.join(base, 'library');
    movies = path.join(base, 'movies');
    outside = path.join(base, 'outside');
    configDir = path.join(base, 'config');
    await writeFiles(media, ['Show.S01E01.mkv']);
    await fs.mkdir(library);
    await fs.mkdir(movies);
    await writeFiles(outside, ['secret.mkv']);
    await fs.symlink(outside, path.join(media, 'escape'));

    const config = loadConfig(
      {
        HOST: '127.0.0.1',
        MEDIA_RENAMER_ROOTS: `${media},${library},${movies}`,
        MEDIA_RENAMER_ALLOWED_HOSTS: 'nas.local',
        MEDIA_RENAMER_PASSWORD: 's3cret',
        TMDB_API_KEY: 'super-secret-tmdb-key',
        MEDIA_RENAMER_TV_TARGET: library,
        MEDIA_RENAMER_MOVIE_TARGET: movies,
        MEDIA_RENAMER_CONFIG_DIR: configDir,
      },
      { port: 0 },
    );
    server = createServer(config);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('healthz needs no password; everything else does', async () => {
    assert.equal((await request('/healthz', { password: null })).status, 200);
    const anonymous = await request('/', { password: null });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.location, '/login');
    const api = await post('/api/settings', {}, { password: null });
    assert.equal(api.status, 401);
    assert.equal(api.headers['www-authenticate'], undefined, 'no browser pop-up');
    assert.equal((await request('/api/settings', { method: 'POST', password: 'wrong' })).status, 401);
    assert.equal((await request('/')).status, 200);
  });

  test('the login page sets a cookie that replaces the password', async () => {
    assert.equal((await request('/login', { password: null })).status, 200);
    assert.equal((await post('/api/login', { password: 'wrong' }, { password: null })).status, 401);
    const login = await post('/api/login', { password: 's3cret' }, { password: null });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.match(login.headers['set-cookie'][0], /HttpOnly/);
    const withCookie = (pathname, options = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, method: options.method ?? 'GET', path: pathname, headers: { Host: '127.0.0.1', Cookie: options.cookie ?? cookie, 'Content-Type': 'application/json' } },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
          },
        );
        req.on('error', reject);
        req.end(options.method === 'POST' ? '{}' : undefined);
      });
    assert.equal((await withCookie('/')).status, 200);
    assert.equal((await withCookie('/api/settings', { method: 'POST' })).status, 200);
    assert.equal((await withCookie('/login')).location, '/');
    assert.equal((await withCookie('/', { cookie: `${cookie}x` })).status, 302);
    assert.equal((await withCookie('/', { cookie: 'media_renamer_session=forged' })).status, 302);
  });

  test('icons, the manifest and the login page load without a password; the app still needs it', async () => {
    for (const [pathname, type] of [
      ['/icon.svg', 'image/svg+xml'],
      ['/apple-touch-icon.png', 'image/png'],
      ['/icon-512.png', 'image/png'],
      ['/manifest.webmanifest', 'application/manifest+json'],
    ]) {
      const response = await request(pathname, { password: null });
      assert.equal(response.status, 200, pathname);
      assert.ok(response.headers['content-type'].startsWith(type), pathname);
    }
    assert.equal((await request('/app.js', { password: null })).status, 401);
    assert.equal(JSON.parse((await request('/manifest.webmanifest', { password: null })).text).name, 'Media Renamer');
  });

  test('rejects unknown Host headers (DNS rebinding)', async () => {
    assert.equal((await request('/', { host: 'evil.example' })).status, 421);
    assert.equal((await request('/', { host: 'nas.local:8080' })).status, 200);
  });

  test('places expose only the allowed folders and never the TMDB key', async () => {
    const response = await post('/api/places', {});
    assert.deepEqual(response.json.places.map((p) => p.path), [await fs.realpath(media), await fs.realpath(library), await fs.realpath(movies)]);
    assert.equal(response.json.tmdbConfigured, true);
    assert.equal(response.json.nativeDialog, false);
    assert.ok(!response.text.includes('super-secret-tmdb-key'));
    assert.ok(!(await post('/api/settings', {})).text.includes('super-secret-tmdb-key'));
  });

  test('settings: environment defaults, save to the config folder, survive a restart, reset', async () => {
    const initial = (await post('/api/settings', {})).json;
    assert.equal(initial.saved, false);
    assert.deepEqual(initial.settings.targets, { episode: library, movie: movies });
    assert.equal(initial.settings.move, true);

    const wanted = {
      patterns: { episode: '{n}/Season {s}/{s00e00} {t}', movie: '{n} ({y})/{n} ({y})' },
      targets: { episode: library, movie: '' },
      move: true,
      language: 'de_de',
      region: 'de',
      filters: { videoOnly: true, excludeSamples: true },
    };
    const saved = await post('/api/settings/save', { settings: wanted });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.settings.patterns.movie, '{n} ({y})/{n} ({y})');
    assert.deepEqual(saved.json.settings.targets, { episode: await fs.realpath(library), movie: null }, 'empty = rename movies in place');
    assert.deepEqual([saved.json.settings.language, saved.json.settings.region], ['de-DE', 'DE']);

    const onDisk = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf8'));
    assert.equal(onDisk.patterns.episode, '{n}/Season {s}/{s00e00} {t}');

    // A new server instance (e.g. after a container restart) reads the saved file.
    const restarted = createServer(
      loadConfig({ HOST: '127.0.0.1', MEDIA_RENAMER_ROOTS: `${media},${library},${movies}`, MEDIA_RENAMER_CONFIG_DIR: configDir }, { port: 0 }),
    );
    await new Promise((resolve) => restarted.listen(0, '127.0.0.1', resolve));
    const reloaded = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: restarted.address().port, method: 'POST', path: '/api/settings', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(JSON.parse(text)));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    await new Promise((resolve) => restarted.close(resolve));
    assert.equal(reloaded.saved, true);
    assert.equal(reloaded.settings.patterns.movie, '{n} ({y})/{n} ({y})');
    assert.equal(reloaded.settings.language, 'de-DE');

    const reset = await post('/api/settings/reset', {});
    assert.equal(reset.json.saved, false);
    assert.deepEqual(reset.json.settings.targets, { episode: library, movie: movies });
    await assert.rejects(fs.access(path.join(configDir, 'settings.json')));
  });

  test('settings: invalid values and destinations outside the allowed folders are refused', async () => {
    const badPattern = await post('/api/settings/save', { settings: { patterns: { episode: '{n} {nope}' } } });
    assert.equal(badPattern.status, 400);
    assert.match(badPattern.json.error, /nope/);
    const outsideTarget = await post('/api/settings/save', { settings: { targets: { movie: outside } } });
    assert.equal(outsideTarget.status, 403);
    const badLanguage = await post('/api/settings/save', { settings: { language: 'klingon!' } });
    assert.equal(badLanguage.status, 400);
    await assert.rejects(fs.access(path.join(configDir, 'settings.json')), 'nothing saved after a refused request');
  });

  test('preview sends episodes and movies to their configured destinations by default', async () => {
    await writeFiles(media, ['The.Godfather.1972.mkv']);
    const response = await post('/api/preview', { root: media, files: ['Show.S01E01.mkv', 'The.Godfather.1972.mkv'] });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.targets, { episode: await fs.realpath(library), movie: await fs.realpath(movies) });
    await fs.rm(path.join(media, 'The.Godfather.1972.mkv'));
  });

  test('confines browsing, scanning and destinations to the allowed folders, including via symlinks', async () => {
    const top = await post('/api/browse', { path: media });
    assert.equal(top.status, 200);
    assert.equal(top.json.parent, null, 'cannot navigate above an allowed folder');
    assert.equal(top.json.breadcrumbs[0].path, await fs.realpath(media));

    assert.equal((await post('/api/browse', { path: outside })).status, 403);
    assert.equal((await post('/api/browse', { path: path.join(media, 'escape') })).status, 403);
    assert.equal((await post('/api/scan', { root: outside })).status, 403);
    assert.equal((await post('/api/preview', { root: media, target: outside, files: [] })).status, 403);
    assert.equal((await post('/api/pick-folder', {})).status, 403);
  });

  test('moves into an allowed destination as a background job', async () => {
    const started = await post('/api/apply', { root: media, target: library, renames: [{ from: 'Show.S01E01.mkv', to: 'Show/S01E01.mkv' }] });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.state, 'running');
    assert.equal(started.json.kind, 'apply');

    let job = started.json;
    for (let i = 0; i < 100 && job.state === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await post('/api/job', { id: started.json.id })).json.job;
    }
    assert.equal(job.state, 'finished', JSON.stringify(job));
    assert.equal(job.result.renamed, 1);
    assert.equal(job.result.target, await fs.realpath(library));
    assert.deepEqual([job.progress.filesDone, job.progress.filesTotal], [1, 1]);
    await fs.access(path.join(library, 'Show/S01E01.mkv'));

    assert.equal((await post('/api/job', {})).json.job.id, job.id, 'latest job is returned without an id');
    assert.equal((await post('/api/job/cancel', { id: 'nope' })).status, 404);
  });

  test('queues a second job behind a running one and can cancel it before it starts', async () => {
    let release;
    const blocker = new Promise((resolve) => {
      release = resolve;
    });
    const first = server.jobs.start({ kind: 'apply', root: media, run: () => blocker });
    const second = await post('/api/undo', { root: media });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.state, 'queued');
    assert.equal(second.json.queuePosition, 1);
    const cancelledQueued = await post('/api/job/cancel', { id: second.json.id });
    assert.equal(cancelledQueued.json.job.state, 'cancelled');
    const cancelled = await post('/api/job/cancel', { id: first.id });
    assert.equal(cancelled.json.job.state, 'cancelling');
    release({ cancelled: true });
    await server.jobs.shutdown({ graceMs: 0 }).catch(() => {});
    server.jobs.shuttingDown = false;
    const list = (await post('/api/jobs', {})).json.jobs;
    assert.deepEqual(list.slice(0, 2).map((job) => job.state), ['cancelled', 'cancelled']);
  });
});
