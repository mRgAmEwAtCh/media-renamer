import './isolated-config.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWebFiles } from '../lib/server/static.ts';
import { createWebFixture, FIXTURE } from './web-fixture.js';

test('serves the pages and build output, with the login page and home-screen files public', async () => {
  const web = createWebFiles(await createWebFixture());
  const find = (pathname) => web.find(pathname);

  for (const pathname of ['/login', FIXTURE.loginChunk, FIXTURE.sharedChunk, FIXTURE.css, '/manifest.webmanifest', '/icon-192.png', '/sw.js']) {
    assert.equal((await find(pathname))?.isPublic, true, pathname);
  }
  for (const pathname of ['/', FIXTURE.appChunk]) {
    const file = await find(pathname);
    assert.ok(file, pathname);
    assert.equal(file.isPublic, false, pathname);
  }
  assert.equal((await find(FIXTURE.appChunk)).immutable, true);
  assert.equal((await find('/icon.svg')).immutable, false);
  assert.equal((await find('/manifest.webmanifest')).type, 'application/manifest+json; charset=utf-8');
});

test('serves nothing else: no page under its file name, no manifest, no unknown paths', async () => {
  const web = createWebFiles(await createWebFixture());
  for (const pathname of ['/index.html', '/login.html', '/.vite/manifest.json', '/assets/missing.js', '/../package.json', '/assets']) {
    assert.equal(await web.find(pathname), null, pathname);
  }
});

test('a missing build serves nothing until it appears', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-web-empty-'));
  const web = createWebFiles(dir);
  assert.equal(await web.find('/'), null);
  await fs.cp(await createWebFixture(), dir, { recursive: true });
  assert.ok(await web.find('/'));
});

test('every file in web/public is served without login', async () => {
  const web = createWebFiles(await createWebFixture());
  for (const name of await fs.readdir(path.resolve(import.meta.dirname, '../web/public'))) {
    assert.equal((await web.find(`/${name}`))?.isPublic, true, name);
  }
});
