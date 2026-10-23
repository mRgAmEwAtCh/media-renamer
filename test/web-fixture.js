import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PUBLIC = path.resolve(import.meta.dirname, '../web/public');

/** File names in the fixture build, as Vite would hash them. */
export const FIXTURE = {
  appChunk: '/assets/index-test.js',
  loginChunk: '/assets/login-test.js',
  sharedChunk: '/assets/react-test.js',
  css: '/assets/styles-test.css',
};

/**
 * A stand-in for `npm run build`: the real files from web/public, the two
 * pages, and hashed chunks listed in a Vite manifest. Resolves to its folder.
 */
export async function createWebFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-web-'));
  await fs.cp(PUBLIC, dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'));
  await fs.mkdir(path.join(dir, '.vite'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Media Renamer</title>');
  await fs.writeFile(path.join(dir, 'login.html'), '<!doctype html><title>Log in</title>');
  for (const file of [FIXTURE.appChunk, FIXTURE.loginChunk, FIXTURE.sharedChunk]) await fs.writeFile(path.join(dir, file), 'export {};');
  await fs.writeFile(path.join(dir, FIXTURE.css), 'body {}');
  const manifest = {
    'index.html': { file: FIXTURE.appChunk.slice(1), isEntry: true, imports: ['_react-test.js'] },
    'login.html': { file: FIXTURE.loginChunk.slice(1), isEntry: true, imports: ['_react-test.js'] },
    '_react-test.js': { file: FIXTURE.sharedChunk.slice(1), css: [FIXTURE.css.slice(1)] },
  };
  await fs.writeFile(path.join(dir, '.vite', 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
