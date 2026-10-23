import path from 'node:path';
import { mapLimit } from '../async.js';
import { DEFAULT_FILTERS, DEFAULT_PATTERNS, MAX_FILES } from '../defaults.js';
import { InputError } from '../errors.js';
import { renderPattern, validatePattern } from '../format.js';
import { exists } from '../fs-utils.js';
import { resolveInside, toRootRelative } from '../paths.js';
import { filterReason, parseRelativePath } from './scan.js';

const yearSuffix = (year) => (year ? ` (${year})` : '');

/** Pattern values for an episode, from TMDB/TVmaze when found, else from the file name. */
async function lookupEpisode(parsed, metadata) {
  const values = { name: parsed.title, year: parsed.year, season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd };
  const show = await metadata.findShow(parsed.title, parsed.year);
  if (!show) {
    return { values, status: 'warning', message: `No ${metadata.tmdbKey ? 'TMDB/TVmaze' : 'TVmaze'} match; using parsed name` };
  }
  const episode = await metadata.findEpisode(show, parsed.season, parsed.episode);
  Object.assign(values, { name: show.name, originalName: show.originalName, year: show.year, title: episode?.title, airdate: episode?.airdate });
  const match = `${show.source}: ${show.name}${yearSuffix(show.year)}${episode ? ` · ${episode.title}` : ''}`;
  if (!episode) return { values, match, status: 'warning', message: 'Episode not found; title left empty' };
  return { values, match };
}

/** Pattern values for a movie, from TMDB when found, else from the file name. */
async function lookupMovie(parsed, metadata) {
  const values = { name: parsed.title, year: parsed.year };
  const movie = await metadata.findMovie(parsed.title, parsed.year);
  if (!movie) {
    const reason = metadata.tmdbKey ? 'No TMDB match' : 'No TMDB key';
    return { values, status: 'warning', message: `${reason}; using parsed name` };
  }
  Object.assign(values, { name: movie.name, originalName: movie.originalName, year: movie.year ?? parsed.year });
  return { values, match: `${movie.source}: ${movie.name}${yearSuffix(movie.year)}` };
}

const LOOKUPS = { episode: lookupEpisode, movie: lookupMovie };

async function describe(rel, parsed, patterns, metadata, { moving = false } = {}) {
  const base = { rel, kind: parsed.kind, newRel: null, target: null, status: 'ok', match: null, message: null };
  if (!Object.hasOwn(LOOKUPS, parsed.kind)) return { ...base, status: 'skipped', message: 'Not recognised as a movie or episode' };
  if (parsed.kind === 'episode' && !parsed.title) return { ...base, status: 'skipped', message: 'Series name could not be determined' };

  const { values, match = null, status = 'ok', message = null } = await LOOKUPS[parsed.kind](parsed, metadata);
  const item = { ...base, match, status, message };
  const rendered = renderPattern(patterns[parsed.kind], values);
  if (!rendered) return { ...item, status: 'error', message: 'Pattern produced an empty name' };
  const fileName = `${rendered}${parsed.language ? `.${parsed.language}` : ''}${parsed.extension}`;
  const directory = path.posix.dirname(rel);
  // Renaming in place keeps the file's subfolder. Moving into a library starts at
  // the destination root, so download folder names never end up in the library.
  item.newRel = moving || rendered.includes('/') || directory === '.' ? fileName : `${directory}/${fileName}`;
  return item;
}

/** Mark items that are already named correctly or that collide with each other or an existing file. */
async function markConflicts(root, items) {
  const byTarget = new Map();
  for (const item of items) {
    if (!item.newRel || !['ok', 'warning'].includes(item.status)) continue;
    const destination = item.target ?? root;
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

function validatePatterns(patterns) {
  for (const [kind, pattern] of Object.entries(patterns)) {
    try {
      validatePattern(pattern);
    } catch (error) {
      throw new InputError(`${kind} pattern: ${error.message}`);
    }
  }
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
  validatePatterns(effective);

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
