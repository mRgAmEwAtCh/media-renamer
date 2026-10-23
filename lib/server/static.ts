import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { send } from './http.ts';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Only these files are served. "Public" ones load without logging in: the login
// page, and the icons and manifest phones fetch for home-screen shortcuts.
const PUBLIC_FILES = [
  'login.js',
  'sw.js',
  'style.css',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'manifest.webmanifest',
];
const APP_MODULES = [
  'app.js',
  'activity.js',
  'api.js',
  'dom.js',
  'file-table.js',
  'format.js',
  'job-panel.js',
  'notify.js',
  'picker.js',
  'settings-form.js',
  'state.js',
  'text.js',
];

interface StaticFile {
  file: string;
  type: string;
  isPublic: boolean;
}

const entry = (file: string, { isPublic = false, url = `/${file}` }: { isPublic?: boolean; url?: string } = {}): [string, StaticFile] => [url, { file, type: CONTENT_TYPES[path.extname(file)], isPublic }];
const STATIC_FILES = new Map([
  entry('index.html', { url: '/' }),
  entry('login.html', { url: '/login', isPublic: true }),
  ...PUBLIC_FILES.map((file) => entry(file, { isPublic: true })),
  ...APP_MODULES.map((file) => entry(file)),
]);

export const isStaticFile = (pathname: string): boolean => STATIC_FILES.has(pathname);
export const isPublicFile = (pathname: string): boolean => STATIC_FILES.get(pathname)?.isPublic === true;

export async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const { file, type } = STATIC_FILES.get(pathname)!;
  return send(response, 200, await fs.readFile(path.join(PUBLIC_DIR, file)), type);
}
