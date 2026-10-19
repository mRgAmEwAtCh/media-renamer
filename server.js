import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listDirectory, listPlaces } from './lib/browse.js';
import { hostnameOf, loadConfig, loadEnvFile } from './lib/config.js';
import { JobManager } from './lib/jobs.js';
import { MetadataClient, normalizeLanguage, normalizeRegion } from './lib/metadata.js';
import { nativeDialogAvailable, pickFolderNative } from './lib/native-dialog.js';
import {
  applyRenames,
  buildPreview,
  destinationsFrom,
  InputError,
  parseRelativePath,
  resolveRoot,
  resolveTarget,
  scanFolder,
  undoLast,
} from './lib/renamer.js';
import {
  activeTargets,
  deleteSavedSettings,
  mergeSettings,
  readSavedSettings,
  sanitizeSettings,
  writeSavedSettings,
} from './lib/settings.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/picker.js': ['picker.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const forbidden = (message) => Object.assign(new InputError(message), { status: 403 });

function send(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Type': contentType });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(request) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw Object.assign(new InputError('Content-Type must be application/json'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new InputError('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new InputError('Request body is not valid JSON');
  }
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

function authorized(request, password) {
  const match = String(request.headers.authorization ?? '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  return timingSafeEqual(digest(decoded.slice(decoded.indexOf(':') + 1)), digest(password));
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Enforces MEDIA_RENAMER_ROOTS on real (symlink-resolved) paths. */
function createRootPolicy(roots) {
  const realRoots = async () =>
    (await Promise.all(roots.map((root) => fs.realpath(root).catch(() => null)))).filter(Boolean);

  return {
    restricted: roots.length > 0,
    realRoots,
    /** Resolve a folder and return it with the allowed root that contains it. */
    async check(input) {
      if (typeof input !== 'string' || !input.trim()) throw new InputError('A folder path is required');
      const real = await fs.realpath(path.resolve(input.trim())).catch(() => null);
      if (!real) throw new InputError(`Folder not found: ${input}`);
      if (!roots.length) return { real, root: null };
      const root = (await realRoots()).find((candidate) => isWithin(candidate, real));
      if (!root) throw forbidden(`Outside the allowed folders (${roots.join(', ')}): ${input}`);
      return { real, root };
    },
  };
}

function createRoutes(config, jobs) {
  const policy = createRootPolicy(config.roots);
  const currentSettings = async () => {
    const saved = await readSavedSettings(config.settingsFile);
    return { saved, effective: mergeSettings(config.envSettings, saved.settings) };
  };
  const filtersFrom = (body, settings) => ({
    videoOnly: typeof body.videoOnly === 'boolean' ? body.videoOnly : settings.filters.videoOnly,
    excludeSamples: typeof body.excludeSamples === 'boolean' ? body.excludeSamples : settings.filters.excludeSamples,
  });
  const allowedRoot = async (input) => {
    const root = await resolveRoot(input);
    await policy.check(root);
    return root;
  };
  const allowedTarget = async (root, input) => {
    const target = await resolveTarget(root, input);
    if (target) await policy.check(target);
    return target;
  };
  /** Folder to store as a default destination: must exist and be allowed. */
  const allowedFolder = async (input) => {
    if (input === null || input === undefined || (typeof input === 'string' && !input.trim())) return null;
    const folder = await resolveRoot(input);
    await policy.check(folder);
    return folder;
  };
  /**
   * Destinations for a preview: `targets` ({ episode, movie }), a legacy single
   * `target`, or else the saved/configured defaults.
   */
  const previewTargets = async (root, body, settings) => {
    let requested;
    if (body.targets && typeof body.targets === 'object') requested = destinationsFrom({ targets: body.targets });
    else if (body.target !== undefined) requested = destinationsFrom({ target: body.target });
    else requested = activeTargets(settings);
    return {
      episode: await allowedTarget(root, requested.episode ?? null),
      movie: await allowedTarget(root, requested.movie ?? null),
    };
  };

  return {
    async '/api/places'() {
      const places = policy.restricted
        ? (await policy.realRoots()).map((root) => ({ label: path.basename(root) || root, path: root, kind: 'volume' }))
        : await listPlaces();
      const nativeDialog = !policy.restricted && (await nativeDialogAvailable());
      return { platform: process.platform, separator: path.sep, places, nativeDialog, tmdbConfigured: Boolean(config.tmdbKey) };
    },
    async '/api/settings'() {
      const { saved, effective } = await currentSettings();
      return {
        settings: effective,
        defaults: config.envSettings,
        saved: saved.exists,
        savedAt: saved.savedAt,
        problems: saved.problems,
        tmdbConfigured: Boolean(config.tmdbKey),
      };
    },
    async '/api/settings/save'(body) {
      const input = body.settings;
      const { settings } = sanitizeSettings(input, { strict: true });
      if (settings.targets) {
        for (const kind of ['episode', 'movie']) {
          if (Object.hasOwn(settings.targets, kind)) settings.targets[kind] = await allowedFolder(input.targets[kind]);
        }
      }
      const { savedAt } = await writeSavedSettings(config.settingsFile, settings);
      return { settings: mergeSettings(config.envSettings, settings), defaults: config.envSettings, saved: true, savedAt, problems: [] };
    },
    async '/api/settings/reset'() {
      await deleteSavedSettings(config.settingsFile);
      return { settings: config.envSettings, defaults: config.envSettings, saved: false, savedAt: null, problems: [] };
    },
    async '/api/browse'(body) {
      const { real, root } = await policy.check(body.path);
      const listing = await listDirectory(real, { showHidden: body.showHidden === true });
      if (!root) return listing;
      return {
        ...listing,
        parent: listing.path === root ? null : listing.parent,
        breadcrumbs: listing.breadcrumbs.filter((crumb) => isWithin(root, crumb.path)),
      };
    },
    async '/api/pick-folder'(body) {
      if (policy.restricted) throw forbidden('The system folder dialog is disabled when MEDIA_RENAMER_ROOTS is set');
      return pickFolderNative({ start: body.start });
    },
    async '/api/scan'(body) {
      const root = await allowedRoot(body.root);
      const { effective } = await currentSettings();
      const filters = filtersFrom(body, effective);
      const { files, truncated, excluded } = await scanFolder(root, { recursive: body.recursive !== false, ...filters });
      return { root, truncated, excluded, filters, files: files.map((rel) => ({ rel, parsed: parseRelativePath(rel) })) };
    },
    async '/api/preview'(body) {
      const root = await allowedRoot(body.root);
      const { effective } = await currentSettings();
      const targets = await previewTargets(root, body, effective);
      let language;
      let region;
      try {
        language = normalizeLanguage(body.language) ?? effective.language;
        region = body.region === undefined ? effective.region : normalizeRegion(body.region);
      } catch (error) {
        throw new InputError(error.message);
      }
      const patterns = { ...effective.patterns, ...body.patterns };
      const metadata = new MetadataClient({ tmdbKey: config.tmdbKey, language, region });
      const items = await buildPreview({ root, targets, files: body.files, patterns, filters: filtersFrom(body, effective), metadata });
      return { root, targets, language, region, patterns, items };
    },
    async '/api/apply'(body) {
      const root = await allowedRoot(body.root);
      if (!Array.isArray(body.renames) || body.renames.length === 0) throw new InputError('Nothing to rename');
      const fallback = await allowedTarget(root, body.target);
      const resolved = new Map();
      const renames = [];
      for (const rename of body.renames) {
        let target = fallback;
        if (rename && typeof rename === 'object' && Object.hasOwn(rename, 'target')) {
          const key = String(rename.target ?? '');
          if (!resolved.has(key)) resolved.set(key, await allowedTarget(root, rename.target));
          target = resolved.get(key);
        }
        renames.push({ from: rename?.from, to: rename?.to, target });
      }
      const targets = [...new Set(renames.map((rename) => rename.target).filter(Boolean))];
      return jobs.start({
        kind: 'apply',
        root,
        targets,
        run: (control) => applyRenames(root, renames, { owner: 'web UI', ...control }),
      });
    },
    async '/api/undo'(body) {
      const root = await allowedRoot(body.root);
      return jobs.start({
        kind: 'undo',
        root,
        run: (control) => undoLast(root, { checkTarget: (target) => policy.check(target), owner: 'web UI', ...control }),
      });
    },
    async '/api/job'(body) {
      return { job: jobs.get(typeof body.id === 'string' ? body.id : null) };
    },
    async '/api/job/cancel'(body) {
      if (typeof body.id !== 'string') throw new InputError('Job id required');
      return { job: jobs.cancel(body.id) };
    },
  };
}

export function createServer(config, { jobs = new JobManager() } = {}) {
  const routes = createRoutes(config, jobs);

  const server = http.createServer(async (request, response) => {
    // Reject unknown Host headers so web pages cannot reach this API via DNS rebinding.
    if (config.allowedHosts && !config.allowedHosts.has(hostnameOf(request.headers.host))) {
      return send(response, 421, { error: 'Unexpected Host header; add it to MEDIA_RENAMER_ALLOWED_HOSTS' });
    }
    const { pathname } = new URL(request.url, 'http://localhost');

    if (pathname === '/healthz' && request.method === 'GET') return send(response, 200, { ok: true });
    if (config.password && !authorized(request, config.password)) {
      return send(response, 401, { error: 'Authentication required' }, undefined, {
        'WWW-Authenticate': 'Basic realm="Media Renamer", charset="UTF-8"',
      });
    }

    try {
      if (request.method === 'GET' && STATIC_FILES[pathname]) {
        const [file, type] = STATIC_FILES[pathname];
        return send(response, 200, await fs.readFile(path.join(PUBLIC_DIR, file), 'utf8'), type);
      }
      if (request.method === 'POST' && Object.hasOwn(routes, pathname)) {
        return send(response, 200, await routes[pathname](await readJson(request)));
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status ?? (error instanceof InputError ? 400 : 500);
      if (status === 500) console.error(error);
      return send(response, status, { error: error.message });
    }
  });
  server.jobs = jobs;
  return server;
}

export function startServer(overrides = {}) {
  loadEnvFile();
  const config = loadConfig(process.env, overrides);
  if (config.umask !== null) process.umask(config.umask);
  for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);

  return new Promise((resolve, reject) => {
    const server = createServer(config);
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const { port } = server.address();
      const shown = ['0.0.0.0', '::'].includes(config.host) ? os.hostname() : config.host;
      process.stderr.write(`Media Renamer running at http://${shown}:${port}/\n`);
      if (config.roots.length) process.stderr.write(`Allowed folders: ${config.roots.join(', ')}\n`);
      process.stderr.write(`Movie lookups (TMDB): ${config.tmdbKey ? 'enabled' : 'disabled, set TMDB_API_KEY'}\n`);
      readSavedSettings(config.settingsFile).then((saved) => {
        const effective = mergeSettings(config.envSettings, saved.settings);
        const where = (target) => target ?? 'rename in place';
        const targets = activeTargets(effective);
        process.stderr.write(`Settings: ${config.settingsFile}${saved.exists ? '' : ' (not saved yet; using defaults)'}\n`);
        for (const problem of saved.problems) process.stderr.write(`warning: ${problem}\n`);
        process.stderr.write(`Destinations: TV → ${where(targets.episode)}, movies → ${where(targets.movie)}\n`);
        process.stderr.write(`Metadata language: ${effective.language}${effective.region ? `, region ${effective.region}` : ''}\n`);
      });

      let stopping = false;
      const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        server.close();
        const active = server.jobs.get(null);
        if (active?.state === 'running') {
          process.stderr.write(
            `${signal}: letting the current file finish (up to ${Math.round(config.shutdownGraceMs / 1000)}s), then stopping the job…\n`,
          );
        }
        await server.jobs.shutdown({ graceMs: config.shutdownGraceMs });
        server.closeAllConnections();
        process.exit(0);
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
