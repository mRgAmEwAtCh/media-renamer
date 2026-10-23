import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { send } from './http.ts';

/** Where `npm run build` puts the web UI (see vite.config.ts). */
export const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
// Hashed build output never changes under the same name.
const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable' };
const PAGES: Record<string, string> = { 'index.html': '/', 'login.html': '/login' };

export interface WebFile {
  file: string;
  type: string;
  /** Loads without logging in. */
  isPublic: boolean;
  immutable: boolean;
}

/** An entry of Vite's .vite/manifest.json. */
interface ManifestChunk {
  file: string;
  css?: string[];
  assets?: string[];
  imports?: string[];
}

/** Build files the login page needs: its entry chunk and everything it imports. */
function loginFiles(manifest: Record<string, ManifestChunk>): Set<string> {
  const files = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit('login.html');
  return files;
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(directory, entry.name), `${rel}/`)));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/**
 * Index the built web UI: URL → file. Public are the login page and its
 * assets, plus the top-level files copied from web/public (icons, manifest,
 * service worker) that phones fetch without logging in.
 */
async function indexWebDir(webDir: string): Promise<Map<string, WebFile>> {
  const manifest = JSON.parse(await fs.readFile(path.join(webDir, '.vite', 'manifest.json'), 'utf8')) as Record<string, ManifestChunk>;
  const forLogin = loginFiles(manifest);
  const index = new Map<string, WebFile>();
  for (const rel of await listFiles(webDir)) {
    const isPage = Object.hasOwn(PAGES, rel);
    const topLevel = !rel.includes('/');
    index.set(isPage ? PAGES[rel] : `/${rel}`, {
      file: path.join(webDir, rel),
      type: CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream',
      isPublic: rel === 'login.html' || (topLevel && !isPage) || forLogin.has(rel),
      immutable: rel.startsWith('assets/'),
    });
  }
  return index;
}

/** The built web UI in `webDir`, indexed on first use; a missing build is retried on the next request. */
export function createWebFiles(webDir: string = DEFAULT_WEB_DIR) {
  let index: Promise<Map<string, WebFile>> | null = null;
  const load = () => {
    index ??= indexWebDir(webDir).catch((error: unknown) => {
      index = null;
      throw error;
    });
    return index;
  };
  return {
    /** The file for a URL path, or null; null for everything while the UI is not built. */
    async find(pathname: string): Promise<WebFile | null> {
      try {
        return (await load()).get(pathname) ?? null;
      } catch {
        return null;
      }
    },
    async serve(response: ServerResponse, file: WebFile): Promise<void> {
      send(response, 200, await fs.readFile(file.file), file.type, file.immutable ? IMMUTABLE : {});
    },
  };
}

export type WebFiles = ReturnType<typeof createWebFiles>;
