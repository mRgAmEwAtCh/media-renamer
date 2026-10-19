import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listDirectory, listPlaces } from './lib/browse.js';
import { hostnameOf, loadConfig, loadEnvFile, mapPath } from './lib/config.js';
import { audioToolsAvailable } from './lib/audio.js';
import { runImport } from './lib/importer.js';
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
  '/activity.js': ['activity.js', 'text/javascript; charset=utf-8'],
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

async function readRaw(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new InputError('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw Object.assign(new InputError('Content-Type must be application/json'), { status: 415 });
  }
  const text = await readRaw(request);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new InputError('Request body is not valid JSON');
  }
}

/** JSON, or a form post such as `curl --data-urlencode "ARCHIVE_PATH=…"`. */
async function readJsonOrForm(request) {
  const type = String(request.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(await readRaw(request)));
  return readJson(request);
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

function createRoutes(config, jobs, { createMetadata }) {
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

  const routes = {
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
        hookEnabled: Boolean(config.hookToken),
        audioToolsAvailable: await audioToolsAvailable(config.audioTools),
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
      const metadata = createMetadata({ tmdbKey: config.tmdbKey, language, region });
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
        label: `Rename ${renames.length} file(s)`,
        run: (control) => applyRenames(root, renames, { owner: 'web UI', ...control }),
      });
    },
    async '/api/undo'(body) {
      const root = await allowedRoot(body.root);
      return jobs.start({
        kind: 'undo',
        root,
        label: 'Undo last batch',
        run: (control) => undoLast(root, { checkTarget: (target) => policy.check(target), owner: 'web UI', ...control }),
      });
    },
    async '/api/job'(body) {
      return { job: jobs.get(typeof body.id === 'string' ? body.id : null) };
    },
    async '/api/jobs'() {
      return { jobs: jobs.list() };
    },
    async '/api/job/cancel'(body) {
      if (typeof body.id !== 'string') throw new InputError('Job id required');
      return { job: jobs.cancel(body.id) };
    },
  };

  /** Runs one automatic import with the settings that apply when it starts. */
  const importRunner = (root, target) => async (control) => {
    await policy.check(target);
    const { effective } = await currentSettings();
    const metadata = createMetadata({ tmdbKey: config.tmdbKey, language: effective.language, region: effective.region });
    return runImport({
      root,
      target,
      settings: effective,
      metadata,
      audioTools: config.audioTools,
      stableSeconds: config.stableSeconds,
      control,
      owner: 'automatic import',
    });
  };

  /** POST /api/hooks/extracted: queue an import for a folder or file a downloader just finished. */
  async function hook(request) {
    if (!config.hookToken) {
      throw Object.assign(new InputError('The import hook is switched off; set MEDIA_RENAMER_HOOK_TOKEN'), { status: 404 });
    }
    const header = String(request.headers.authorization ?? '');
    const token = header.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? request.headers['x-hook-token'];
    if (!token || !timingSafeEqual(digest(String(token)), digest(config.hookToken))) {
      throw Object.assign(new InputError('Missing or wrong hook token'), { status: 401 });
    }
    const body = await readJsonOrForm(request);
    const requested = String(body.path ?? body.ARCHIVE_PATH ?? '').trim();
    if (!requested) throw new InputError('Send the folder or file as "path" (JSON) or ARCHIVE_PATH (form field)');
    const { effective } = await currentSettings();
    if (!effective.automation.enabled) throw Object.assign(new InputError('Automatic import is switched off in the settings'), { status: 409 });

    const mapped = mapPath(requested, config.pathMap);
    const located = await policy.check(mapped).catch((error) => {
      if (error.status === 403) throw error;
      throw Object.assign(new InputError(`Not found: ${mapped}${mapped === requested ? '' : ` (sent as ${requested})`}`), { status: 404 });
    });
    const stat = await fs.stat(located.real);
    const root = located.root ?? (stat.isDirectory() ? located.real : path.dirname(located.real));
    const existing = jobs.findActive((job) => job.kind === 'import' && job.params?.path === located.real);
    if (existing) return { ...existing, duplicate: true };
    return jobs.start({
      kind: 'import',
      root,
      params: { path: located.real, requested },
      label: path.basename(located.real),
      source: 'hook',
      run: importRunner(root, located.real),
    });
  }

  /** Re-create the runner for an import that was queued or interrupted before a restart. */
  const resume = (job) => (job.kind === 'import' && job.params?.path ? importRunner(job.root, job.params.path) : null);

  return { routes, hook, resume };
}

export function createServer(config, { jobs = new JobManager(), createMetadata = (options) => new MetadataClient(options) } = {}) {
  const { routes, hook, resume } = createRoutes(config, jobs, { createMetadata });
  jobs.resume ??= resume;

  const fail = (response, error) => {
    const status = error.status ?? (error instanceof InputError ? 400 : 500);
    if (status === 500) console.error(error);
    return send(response, status, { error: error.message });
  };

  const server = http.createServer(async (request, response) => {
    // Reject unknown Host headers so web pages cannot reach this API via DNS rebinding.
    if (config.allowedHosts && !config.allowedHosts.has(hostnameOf(request.headers.host))) {
      return send(response, 421, { error: 'Unexpected Host header; add it to MEDIA_RENAMER_ALLOWED_HOSTS' });
    }
    const { pathname } = new URL(request.url, 'http://localhost');

    if (pathname === '/healthz' && request.method === 'GET') return send(response, 200, { ok: true });
    // The hook has its own token so a downloader can call it without the web password.
    if (pathname === '/api/hooks/extracted') {
      if (request.method !== 'POST') return send(response, 405, { error: 'Use POST' }, undefined, { Allow: 'POST' });
      try {
        return send(response, 202, await hook(request));
      } catch (error) {
        return fail(response, error);
      }
    }
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
      return fail(response, error);
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
    const server = createServer(config, { jobs: new JobManager({ storeFile: config.jobsFile }) });
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const { port } = server.address();
      const shown = ['0.0.0.0', '::'].includes(config.host) ? os.hostname() : config.host;
      process.stderr.write(`Media Renamer running at http://${shown}:${port}/\n`);
      if (config.roots.length) process.stderr.write(`Allowed folders: ${config.roots.join(', ')}\n`);
      process.stderr.write(`Movie lookups (TMDB): ${config.tmdbKey ? 'enabled' : 'disabled, set TMDB_API_KEY'}\n`);
      process.stderr.write(
        `Import hook: ${config.hookToken ? `POST /api/hooks/extracted${config.pathMap.length ? ` (path map: ${config.pathMap.map((m) => `${m.from}=${m.to}`).join(', ')})` : ''}` : 'disabled, set MEDIA_RENAMER_HOOK_TOKEN'}\n`,
      );
      server.jobs.restore().catch((error) => process.stderr.write(`warning: could not restore jobs: ${error.message}\n`));
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
