import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderPattern, validatePattern } from './format.js';
import { convertAndMove } from './audio.js';
import { isCancellation, moveFile, partialPathFor, sweepPartials } from './mover.js';
import { isMediaFile, isSampleFolder, isSamplePath, isVideoFile, parseMediaFile } from './parse.js';

export const DEFAULT_PATTERNS = Object.freeze({
  episode: '{n} - {s00e00} - {t}',
  movie: '{n} ({y})',
});
export const UNDO_LOG = '.media-renamer-undo.json';
export const MAX_FILES = 5000;

/** An error caused by caller input rather than an internal failure. */
export class InputError extends Error {}

const toPosix = (value) => value.split(path.sep).join('/');

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw new InputError('A folder path is required');
  let root;
  try {
    root = await fs.realpath(path.resolve(input.trim()));
  } catch {
    throw new InputError(`Folder not found: ${input}`);
  }
  if (!(await fs.stat(root)).isDirectory()) throw new InputError(`Not a folder: ${input}`);
  return root;
}

/** Resolve an optional destination folder; null means "rename in place". */
export async function resolveTarget(root, input) {
  if (input === undefined || input === null || (typeof input === 'string' && !input.trim())) return null;
  const target = await resolveRoot(input);
  return target === root ? null : target;
}

/** Resolve a root-relative path and refuse anything that escapes the root. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new InputError('Empty file path');
  const absolute = path.resolve(root, rel);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InputError(`Path is outside the selected folder: ${rel}`);
  }
  return absolute;
}

/** Convert a caller path (absolute, or relative to root) into a normalized root-relative path. */
export function toRootRelative(root, input) {
  let absolute = path.resolve(root, input);
  if (path.isAbsolute(input) && path.relative(root, absolute).startsWith('..')) {
    try {
      absolute = path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      // Leave the path unchanged; resolveInside reports it as outside the root.
    }
  }
  return toPosix(path.relative(root, resolveInside(root, path.relative(root, absolute))));
}

export const DEFAULT_FILTERS = Object.freeze({ videoOnly: false, excludeSamples: true });

/** Why a file is left out by the filters, or null when it should be processed. */
export function filterReason(rel, { videoOnly = DEFAULT_FILTERS.videoOnly, excludeSamples = DEFAULT_FILTERS.excludeSamples } = {}) {
  const fileName = path.posix.basename(rel);
  if (!isMediaFile(fileName)) return 'Not a media file';
  if (videoOnly && !isVideoFile(fileName)) return 'Not a video file (video-only filter)';
  if (excludeSamples && isSamplePath(rel)) return 'Sample file (sample filter)';
  return null;
}

export async function scanFolder(root, { recursive = true, limit = MAX_FILES, ...filterOptions } = {}) {
  const filters = { ...DEFAULT_FILTERS, ...filterOptions };
  const files = [];
  const excluded = { samples: 0, nonVideo: 0 };
  let truncated = false;

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (filters.excludeSamples && isSampleFolder(entry.name)) {
          excluded.samples += await countMediaFiles(absolute);
          continue;
        }
        await walk(absolute);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        const rel = toPosix(path.relative(root, absolute));
        const reason = filterReason(rel, filters);
        if (reason) {
          excluded[reason.startsWith('Sample') ? 'samples' : 'nonVideo'] += 1;
          continue;
        }
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
      if (truncated) return;
    }
  }

  await walk(root);
  return { files, truncated, excluded };
}

async function countMediaFiles(directory) {
  let count = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && isMediaFile(entry.name)) count += 1;
  }
  return count;
}

export function parseRelativePath(rel) {
  const parts = rel.split('/');
  const fileName = parts.pop();
  return parseMediaFile(fileName, { folderNames: parts.reverse() });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function describe(rel, parsed, patterns, metadata, { moving = false } = {}) {
  const base = { rel, kind: parsed.kind, newRel: null, target: null, status: 'ok', match: null, message: null };
  let values;

  if (parsed.kind === 'episode') {
    if (!parsed.title) return { ...base, status: 'skipped', message: 'Series name could not be determined' };
    values = { name: parsed.title, year: parsed.year, season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd };
    const show = await metadata.findShow(parsed.title, parsed.year);
    if (show) {
      const episode = await metadata.findEpisode(show, parsed.season, parsed.episode);
      Object.assign(values, {
        name: show.name,
        originalName: show.originalName,
        year: show.year,
        title: episode?.title,
        airdate: episode?.airdate,
      });
      base.match = `${show.source}: ${show.name}${show.year ? ` (${show.year})` : ''}${episode ? ` · ${episode.title}` : ''}`;
      if (!episode) Object.assign(base, { status: 'warning', message: 'Episode not found; title left empty' });
    } else {
      Object.assign(base, { status: 'warning', message: `No ${metadata.tmdbKey ? 'TMDB/TVmaze' : 'TVmaze'} match; using parsed name` });
    }
  } else if (parsed.kind === 'movie') {
    values = { name: parsed.title, year: parsed.year };
    const movie = await metadata.findMovie(parsed.title, parsed.year);
    if (movie) {
      Object.assign(values, { name: movie.name, originalName: movie.originalName, year: movie.year ?? parsed.year });
      base.match = `${movie.source}: ${movie.name}${movie.year ? ` (${movie.year})` : ''}`;
    } else {
      const reason = metadata.tmdbKey ? 'No TMDB match' : 'No TMDB key';
      Object.assign(base, { status: 'warning', message: `${reason}; using parsed name` });
    }
  } else {
    return { ...base, status: 'skipped', message: 'Not recognised as a movie or episode' };
  }

  const rendered = renderPattern(patterns[parsed.kind], values);
  if (!rendered) return { ...base, status: 'error', message: 'Pattern produced an empty name' };
  const fileName = `${rendered}${parsed.language ? `.${parsed.language}` : ''}${parsed.extension}`;
  const directory = path.posix.dirname(rel);
  // Renaming in place keeps the file's subfolder. Moving into a library starts at
  // the destination root, so download folder names never end up in the library.
  base.newRel = moving || rendered.includes('/') || directory === '.' ? fileName : `${directory}/${fileName}`;
  return base;
}

const destinationOf = (root, item) => item.target ?? root;

async function markConflicts(root, items) {
  const byTarget = new Map();
  for (const item of items) {
    if (!item.newRel || !['ok', 'warning'].includes(item.status)) continue;
    const destination = destinationOf(root, item);
    const sameRoot = destination === root;
    if (sameRoot && item.newRel === item.rel) {
      Object.assign(item, { status: 'unchanged', message: 'Already named correctly' });
      continue;
    }
    const key = `${destination}\0${item.newRel.toLowerCase()}`;
    if (byTarget.has(key)) {
      for (const duplicate of [byTarget.get(key), item]) {
        Object.assign(duplicate, { status: 'conflict', message: 'Another file maps to the same name' });
      }
      continue;
    }
    byTarget.set(key, item);
    const caseOnly = sameRoot && item.rel.toLowerCase() === item.newRel.toLowerCase();
    if (!caseOnly && (await exists(resolveInside(destination, item.newRel)))) {
      Object.assign(item, { status: 'conflict', message: 'A file with the new name already exists' });
    }
  }
}

/** Per-kind destinations from either `targets` ({ episode, movie }) or one shared `target`. */
export function destinationsFrom({ target = null, targets } = {}) {
  return {
    episode: targets && targets.episode !== undefined ? targets.episode : target,
    movie: targets && targets.movie !== undefined ? targets.movie : target,
  };
}

/**
 * Compute proposed names without touching the file system.
 * TV episodes go to `targets.episode`, movies to `targets.movie` (a shared `target`
 * sets both; null renames in place). Each item's `newRel` is relative to its
 * `target`, or to `root` when the item stays in place.
 */
export async function buildPreview({ root, target = null, targets, files, patterns = DEFAULT_PATTERNS, filters = DEFAULT_FILTERS, metadata, concurrency = 3 }) {
  if (!Array.isArray(files)) throw new InputError('files must be an array');
  if (files.length > MAX_FILES) throw new InputError(`At most ${MAX_FILES} files can be previewed at once`);
  const destinations = destinationsFrom({ target, targets });
  const effective = { ...DEFAULT_PATTERNS, ...patterns };
  for (const [kind, pattern] of Object.entries(effective)) {
    try {
      validatePattern(pattern);
    } catch (error) {
      throw new InputError(`${kind} pattern: ${error.message}`);
    }
  }

  const failure = (rel, status, message) => ({ rel, kind: 'unknown', newRel: null, target: null, status, match: null, message });
  const items = await mapLimit(files, concurrency, async (input) => {
    let rel = input;
    try {
      rel = toRootRelative(root, input);
      if (!(await exists(resolveInside(root, rel)))) return failure(rel, 'error', 'File not found');
      const reason = filterReason(rel, { ...DEFAULT_FILTERS, ...filters });
      if (reason) return failure(rel, 'skipped', reason);
      const parsed = parseRelativePath(rel);
      const destination = destinations[parsed.kind] ?? null;
      const item = await describe(rel, parsed, effective, metadata, { moving: Boolean(destination) });
      if (item.newRel) item.target = destination;
      return item;
    } catch (error) {
      return failure(rel, 'error', error.message);
    }
  });
  await markConflicts(root, items);
  return items;
}

export { CancelledError, isCancellation, moveFile } from './mover.js';

const LOCK_FILE = '.media-renamer.lock';
const LOCK_HEARTBEAT_MS = 30 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const MAX_LOG_BATCHES = 50;
// Identifies this process instance; a restarted container may reuse the same hostname and PID.
const INSTANCE_ID = randomUUID();

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** A lock is abandoned when its owner on this host is gone, or when it stopped heartbeating. */
function lockIsAbandoned(holder, stat) {
  if (holder.host === os.hostname() && Number.isInteger(holder.pid)) {
    if (holder.pid === process.pid) return holder.instance !== INSTANCE_ID;
    return !processIsAlive(holder.pid);
  }
  return !stat || Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
}

async function readUndoLog(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, UNDO_LOG), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Undo log is unreadable: ${error.message}`);
  }
}

async function writeUndoLog(root, batches) {
  const target = path.join(root, UNDO_LOG);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(batches.slice(-MAX_LOG_BATCHES), null, 2)}\n`, { flush: true });
  await fs.rename(temporary, target);
}

/**
 * Exclusive lock for one folder, so two jobs (web UI and CLI, or two browser
 * tabs) never move the same files. The owner refreshes the lock's mtime; a lock
 * left behind by a crash or container restart goes stale and is taken over.
 */
async function acquireLock(root, owner) {
  const file = path.join(root, LOCK_FILE);
  const body = JSON.stringify({ owner, host: os.hostname(), pid: process.pid, instance: INSTANCE_ID, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(file, body, { flag: 'wx' });
      const timer = setInterval(() => {
        const now = new Date();
        fs.utimes(file, now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      timer.unref();
      return async () => {
        clearInterval(timer);
        await fs.rm(file, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(file).catch(() => null);
      let holder = {};
      try {
        holder = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        // Unreadable lock: judged by age only.
      }
      if (!lockIsAbandoned(holder, stat)) {
        throw Object.assign(new InputError(`Another rename job is already running in this folder${holder.owner ? ` (${holder.owner})` : ''}`), {
          status: 409,
        });
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new InputError('Could not lock the folder');
}

/** Destination root of one journal entry (entries record their own; older batches one per batch). */
const entryDestination = (root, batch, entry) => entry.target ?? batch.target ?? root;

/** The single destination shared by all moves, or null when renamed in place or spread over several. */
function sharedTarget(root, destinations) {
  const distinct = [...new Set(destinations)];
  return distinct.length === 1 && distinct[0] !== root ? distinct[0] : null;
}

/** Mark batches left "running" by a crash as interrupted and remove their partial copies. */
async function recoverInterrupted(root, log) {
  const stale = log.filter((batch) => batch.status === 'running');
  if (!stale.length) return false;
  const directories = [];
  for (const batch of stale) {
    batch.status = 'interrupted';
    for (const entry of batch.renames) {
      if (entry.state !== 'pending') continue;
      const target = resolveInside(entryDestination(root, batch, entry), entry.to);
      directories.push(path.dirname(target));
      // The journal names the exact partial file, so it can go immediately.
      if (entry.partial) await fs.rm(path.join(path.dirname(target), path.basename(entry.partial)), { force: true }).catch(() => {});
    }
  }
  await sweepPartials(directories);
  return true;
}

async function fileSize(file) {
  return (await fs.stat(file).catch(() => null))?.size ?? 0;
}

/** Shared progress bookkeeping for apply and undo. */
function createProgress(items, onProgress) {
  const state = {
    filesTotal: items.length,
    filesDone: 0,
    bytesTotal: items.reduce((sum, item) => sum + item.size, 0),
    bytesDone: 0,
    current: null,
  };
  const emit = () => onProgress?.({ ...state, current: state.current && { ...state.current } });
  return {
    state,
    start(item) {
      state.current = { from: item.from, to: item.to, bytesDone: 0, bytesTotal: item.size, phase: item.audio ? 'converting' : 'moving' };
      emit();
    },
    bytes(done) {
      state.current.bytesDone = done;
      emit();
    },
    finish(item) {
      state.filesDone += 1;
      state.bytesDone += item.size;
      state.current = null;
      emit();
    },
  };
}

/**
 * Validate every rename, then move files one by one.
 * `from` paths are relative to root; each `to` is relative to that rename's
 * `target` (an absolute folder, already validated by the caller), falling back
 * to the `target` option and then to root.
 *
 * Each file is journalled as pending before it moves and as done right after,
 * so an interrupted batch (crash, container stop, cancel) can still be undone.
 * A failing file is reported and the remaining files continue. Cancelling via
 * `signal` stops during the current file (its partial copy is removed and the
 * original stays in place); `stopSignal` stops only between files.
 */
export async function applyRenames(root, renames, { target = null, audio = {}, signal, stopSignal, onProgress, owner = 'media-renamer' } = {}) {
  if (!Array.isArray(renames) || renames.length === 0) throw new InputError('Nothing to rename');
  const planned = [];
  const sources = new Set();
  const targets = new Set();

  for (const rename of renames) {
    const requested = rename && Object.hasOwn(rename, 'target') ? rename.target : target;
    if (requested !== null && requested !== undefined && (typeof requested !== 'string' || !path.isAbsolute(requested))) {
      throw new InputError(`Destination must be an absolute folder: ${requested}`);
    }
    const destination = requested ? path.resolve(requested) : root;
    const sameRoot = destination === root;
    const from = toRootRelative(root, String(rename?.from ?? ''));
    const to = toRootRelative(destination, String(rename?.to ?? ''));
    if (sameRoot && from === to) continue;
    if (path.posix.basename(to).startsWith('.')) throw new InputError(`Refusing to create a hidden file: ${to}`);
    if (sources.has(from)) throw new InputError(`File listed twice: ${from}`);
    const key = `${destination}\0${to.toLowerCase()}`;
    if (targets.has(key)) throw new InputError(`Two files map to: ${to}`);
    sources.add(from);
    targets.add(key);

    const fromAbsolute = resolveInside(root, from);
    const toAbsolute = resolveInside(destination, to);
    const caseOnly = sameRoot && from.toLowerCase() === to.toLowerCase();
    const stat = await fs.lstat(fromAbsolute).catch(() => null);
    if (!stat?.isFile()) throw new InputError(`Source is not a regular file: ${from}`);
    if (!caseOnly && (await exists(toAbsolute))) throw new InputError(`Target already exists: ${to}`);
    planned.push({
      from,
      to,
      target: sameRoot ? null : destination,
      fromAbsolute,
      toAbsolute,
      caseOnly,
      size: stat.size,
      audio: rename.audio?.conversions?.length ? rename.audio : null,
    });
  }
  const destinations = [...new Set(planned.map((item) => item.target).filter(Boolean))];
  const summary = { target: sharedTarget(root, planned.map((item) => item.target ?? root)), targets: destinations };
  if (planned.length === 0) return { renamed: 0, failed: [], cancelled: false, ...summary, renames: [] };

  const release = await acquireLock(root, owner);
  try {
    const log = await readUndoLog(root);
    await recoverInterrupted(root, log);
    const batch = { id: randomUUID(), at: new Date().toISOString(), status: 'running', renames: [] };
    log.push(batch);
    await writeUndoLog(root, log);

    const progress = createProgress(planned, onProgress);
    const done = [];
    const failed = [];
    let cancelled = false;

    for (const item of planned) {
      if (signal?.aborted || stopSignal?.aborted) {
        cancelled = true;
        break;
      }
      progress.start(item);
      const partialPath = partialPathFor(item.toAbsolute);
      const entry = { from: item.from, to: item.to, ...(item.target && { target: item.target }), state: 'pending', partial: path.basename(partialPath) };
      batch.renames.push(entry);
      await writeUndoLog(root, log);
      try {
        await fs.mkdir(path.dirname(item.toAbsolute), { recursive: true });
        if (!item.caseOnly && (await exists(item.toAbsolute))) throw new Error('Target appeared after the preview');
        const onBytes = (bytes) => progress.bytes(bytes);
        if (item.audio) {
          await convertAndMove(item.fromAbsolute, item.toAbsolute, { plan: item.audio, partialPath, tools: audio.tools, bitrate: audio.bitrate, signal, onProgress: onBytes });
          entry.converted = true;
        } else {
          await moveFile(item.fromAbsolute, item.toAbsolute, { signal, partialPath, onProgress: onBytes });
        }
        entry.state = 'done';
        delete entry.partial;
        done.push({ from: item.from, to: item.to, target: item.target, ...(item.audio && { converted: true }) });
      } catch (error) {
        batch.renames.pop();
        if (isCancellation(error)) {
          cancelled = true;
          await writeUndoLog(root, log);
          break;
        }
        failed.push({ from: item.from, to: item.to, target: item.target, reason: error.message });
      }
      await writeUndoLog(root, log);
      progress.finish(item);
    }

    batch.status = cancelled ? 'cancelled' : failed.length ? 'partial' : 'complete';
    if (!batch.renames.length) log.pop();
    await writeUndoLog(root, log);
    return { renamed: done.length, failed, cancelled, ...summary, renames: done };
  } finally {
    await release();
  }
}

/**
 * Reverse the most recent batch recorded in the folder's undo log, including
 * batches that were cancelled or interrupted. checkTarget may reject a recorded
 * destination (e.g. outside allowed folders). Cancelling keeps the remaining
 * entries so a later undo continues where this one stopped.
 */
export async function undoLast(root, { checkTarget, signal, stopSignal, onProgress, owner = 'media-renamer' } = {}) {
  const release = await acquireLock(root, owner);
  try {
    const log = await readUndoLog(root);
    const recovered = await recoverInterrupted(root, log);
    if (recovered) await writeUndoLog(root, log);
    const batch = log.at(-1);
    if (!batch) throw new InputError('Nothing to undo in this folder');
    const pendingEntries = batch.renames.filter((entry) => entry.state !== 'undone');
    const destinations = [...new Set(pendingEntries.map((entry) => entryDestination(root, batch, entry)))].filter((d) => d !== root);
    if (checkTarget) for (const destination of destinations) await checkTarget(destination);

    const entries = [];
    for (const entry of [...pendingEntries].reverse()) {
      const destination = entryDestination(root, batch, entry);
      const fromAbsolute = resolveInside(root, entry.from);
      const toAbsolute = resolveInside(destination, entry.to);
      entries.push({
        entry,
        from: entry.to,
        to: entry.from,
        target: destination === root ? null : destination,
        fromAbsolute: toAbsolute,
        toAbsolute: fromAbsolute,
        size: await fileSize(toAbsolute),
      });
    }

    const progress = createProgress(entries, onProgress);
    const restored = [];
    const skipped = [];
    let cancelled = false;
    for (const item of entries) {
      if (signal?.aborted || stopSignal?.aborted) {
        cancelled = true;
        break;
      }
      progress.start(item);
      try {
        const caseOnly = !item.target && item.from.toLowerCase() === item.to.toLowerCase();
        if (!(await exists(item.fromAbsolute))) {
          // A pending entry whose move never happened is simply dropped.
          if (item.entry.state === 'pending' && (await exists(item.toAbsolute))) {
            item.entry.state = 'undone';
            await writeUndoLog(root, log);
            progress.finish(item);
            continue;
          }
          throw new Error('renamed file no longer exists');
        }
        if (!caseOnly && (await exists(item.toAbsolute))) throw new Error('original name is taken');
        await fs.mkdir(path.dirname(item.toAbsolute), { recursive: true });
        await moveFile(item.fromAbsolute, item.toAbsolute, { signal, onProgress: (bytes) => progress.bytes(bytes) });
        item.entry.state = 'undone';
        restored.push({ from: item.from, to: item.to, target: item.target });
      } catch (error) {
        if (isCancellation(error)) {
          cancelled = true;
          break;
        }
        item.entry.state = 'undone';
        skipped.push({ from: item.from, to: item.to, target: item.target, reason: error.message });
      }
      await writeUndoLog(root, log);
      progress.finish(item);
    }

    const remaining = batch.renames.filter((entry) => entry.state !== 'undone').length;
    if (!remaining) log.pop();
    await writeUndoLog(root, log);
    return {
      restored: restored.length,
      skipped,
      cancelled,
      remaining,
      renames: restored,
      batchAt: batch.at,
      target: batch.target ?? sharedTarget(root, entries.map((item) => item.target ?? root)),
      targets: destinations,
    };
  } finally {
    await release();
  }
}
