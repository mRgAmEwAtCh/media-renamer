import './isolated-config.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isPublicFile, isStaticFile } from '../lib/server/static.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Every script a page loads, plus every module those scripts import (transitively). */
async function browserScripts() {
  const found = new Set();
  const pending = [];
  for (const page of ['index.html', 'login.html']) {
    const html = await fs.readFile(path.join(PUBLIC_DIR, page), 'utf8');
    for (const [, src] of html.matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)) pending.push(src);
  }
  while (pending.length) {
    const file = pending.pop();
    if (found.has(file)) continue;
    found.add(file);
    const source = await fs.readFile(path.join(PUBLIC_DIR, file), 'utf8');
    for (const [, spec] of source.matchAll(/^import\s[^'"]*['"]\.\/([^'"]+)['"]/gm)) pending.push(spec);
  }
  return [...found];
}

test('the server serves every module the pages load', async () => {
  const scripts = await browserScripts();
  assert.ok(scripts.includes('app.js') && scripts.includes('login.js'));
  for (const file of scripts) assert.ok(isStaticFile(`/${file}`), `/${file} is imported by the web UI but not served`);
});

test('only the login page and home-screen assets load without logging in', () => {
  for (const pathname of ['/login', '/login.js', '/style.css', '/manifest.webmanifest', '/icon-192.png']) assert.ok(isPublicFile(pathname), pathname);
  for (const pathname of ['/', '/app.js', '/api.js', '/settings-form.js']) assert.ok(!isPublicFile(pathname), pathname);
});
