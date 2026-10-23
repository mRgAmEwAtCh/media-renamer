import './isolated-config.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { createServer } from '../server.ts';

const TOKEN = 'test-hook-token-0123456789abcdef';
let server;
let port;
let base;
let downloads;
let tv;
let movies;
let outside;

const metadata = () => ({
  tmdbKey: 'test',
  findShow: async () => ({ source: 'TMDB', id: 1, name: 'Severance', year: 2022 }),
  findEpisode: async (_show, season, episode) => ({ title: `Folge ${episode}` }),
  findMovie: async () => null,
});

function request(pathname, { method = 'POST', headers = {}, body = '', password = null } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = { Host: '127.0.0.1', ...headers };
    if (password) allHeaders.Authorization = `Basic ${Buffer.from(`any:${password}`).toString('base64')}`;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: allHeaders }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const hookForm = (archivePath, token = TOKEN) =>
  request('/api/hooks/extracted', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ARCHIVE_PATH: archivePath }).toString(),
  });
const hookJson = (body, headers = { 'X-Hook-Token': TOKEN }) =>
  request('/api/hooks/extracted', { headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const api = (pathname, body) =>
  request(pathname, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), password: 's3cret' });

async function waitForJob(id, states = ['finished', 'failed', 'cancelled']) {
  for (let i = 0; i < 200; i += 1) {
    const { job } = (await api('/api/job', { id })).json;
    if (states.includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-hook-')));
  [downloads, tv, movies, outside] = ['Downloads', 'Serien', 'Filme', 'outside'].map((name) => path.join(base, name));
  for (const dir of [downloads, tv, movies, outside]) await fs.mkdir(dir);
  const config = loadConfig(
    {
      MEDIA_RENAMER_ROOTS: `${downloads},${tv},${movies}`,
      MEDIA_RENAMER_PASSWORD: 's3cret',
      MEDIA_RENAMER_HOOK_TOKEN: TOKEN,
      MEDIA_RENAMER_PATH_MAP: `/Downloads=${downloads}`,
      MEDIA_RENAMER_STABLE_SECONDS: '0',
      MEDIA_RENAMER_TV_TARGET: tv,
      MEDIA_RENAMER_MOVIE_TARGET: movies,
      MEDIA_RENAMER_EPISODE_PATTERN: '{n}/Season {s}/{s00e00} {t}',
      MEDIA_RENAMER_CONFIG_DIR: path.join(base, 'config'),
    },
    { port: 0 },
  );
  server = createServer(config, { createMetadata: metadata });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('a downloader can start an import with ARCHIVE_PATH; paths are mapped and the job is visible', async () => {
  await fs.mkdir(path.join(downloads, 'extracted', 'Severance.S01'), { recursive: true });
  await fs.writeFile(path.join(downloads, 'extracted', 'Severance.S01', 'Severance.S01E03.mkv'), 'video');

  const response = await hookForm('/Downloads/extracted/Severance.S01');
  assert.equal(response.status, 202);
  assert.equal(response.json.kind, 'import');
  assert.equal(response.json.source, 'hook');
  assert.equal(response.json.params.path, path.join(downloads, 'extracted', 'Severance.S01'));

  const job = await waitForJob(response.json.id);
  assert.equal(job.state, 'finished', job.error);
  assert.equal(job.result.imported, 1);
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done', 'done', 'skipped', 'done', 'skipped']);
  assert.equal(job.files[0].outcome, 'moved');
  await fs.access(path.join(tv, 'Severance', 'Season 1', 'S01E03 Folge 3.mkv'));

  const list = (await api('/api/jobs', {})).json.jobs;
  assert.equal(list[0].id, job.id, 'newest first in the activity list');
});

test('the hook needs its own token, not the web password', async () => {
  assert.equal((await hookForm('/Downloads', 'wrong')).status, 401);
  const noToken = await request('/api/hooks/extracted', { headers: { 'Content-Type': 'application/json' }, body: '{"path":"/Downloads"}' });
  assert.equal(noToken.status, 401);
  const withPasswordOnly = await request('/api/hooks/extracted', {
    headers: { 'Content-Type': 'application/json' },
    body: '{"path":"/Downloads"}',
    password: 's3cret',
  });
  assert.equal(withPasswordOnly.status, 401);
  assert.equal((await request('/api/hooks/extracted', { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
});

test('refuses paths outside the allowed folders and reports missing ones with the original path', async () => {
  const outsideResponse = await hookJson({ path: outside });
  assert.equal(outsideResponse.status, 403);
  const missing = await hookForm('/Downloads/does-not-exist');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /sent as \/Downloads\/does-not-exist/);
  assert.equal((await hookJson({})).status, 400);
});

test('a second call for the same folder joins the queued job instead of adding another', async () => {
  await fs.mkdir(path.join(downloads, 'dup'));
  let release;
  const blocker = server.jobs.start({ kind: 'apply', root: downloads, run: () => new Promise((resolve) => (release = resolve)) });
  const first = await hookJson({ path: path.join(downloads, 'dup') });
  const second = await hookJson({ path: path.join(downloads, 'dup') });
  assert.equal(first.json.state, 'queued');
  assert.equal(second.json.id, first.json.id);
  assert.equal(second.json.duplicate, true);
  release({});
  await waitForJob(blocker.id);
  await waitForJob(first.json.id);
});

test('when automatic import is switched off in the settings, the hook says so', async () => {
  const saved = await api('/api/settings/save', { settings: { automation: { enabled: false } } });
  assert.equal(saved.status, 200);
  assert.equal((await hookJson({ path: downloads })).status, 409);
  await api('/api/settings/reset', {});
  const settings = (await api('/api/settings', {})).json;
  assert.equal(settings.hookEnabled, true);
  assert.equal(settings.settings.automation.enabled, true);
});
