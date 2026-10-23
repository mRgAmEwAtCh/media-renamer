import path from 'node:path';
import { mapLimit } from '../async.ts';
import { DEFAULT_FILTERS, DEFAULT_PATTERNS, MAX_FILES } from '../defaults.ts';
import { InputError } from '../errors.ts';
import { renderPattern, validatePattern } from '../format.ts';
import type { PatternValues } from '../format.ts';
import { lstatIfExists } from '../fs-utils.ts';
import { resolveInside, toRootRelative } from '../paths.ts';
import type { ConflictReason, Filters, ItemStatus, MediaKind, MetadataSource, ParsedKind, ParsedMedia, Patterns, PreviewItem, Targets } from '../types.ts';
import { filterReason, parseRelativePath } from './scan.ts';

/** Pattern values for one file plus how they were found. */
interface LookupResult {
  values: PatternValues;
  match?: string;
  status?: ItemStatus;
  message?: string;
}

export interface PreviewOptions {
  root: string;
  target?: string | null;
  targets?: Partial<Targets>;
  files: readonly string[];
  patterns?: Partial<Patterns>;
  filters?: Partial<Filters>;
  metadata: MetadataSource;
  concurrency?: number;
}

const yearSuffix = (year: number | null) => (year ? ` (${year})` : '');

/** Pattern values for an episode, from TMDB/TVmaze when found, else from the file name. */
async function lookupEpisode(parsed: ParsedMedia, metadata: MetadataSource): Promise<LookupResult> {
  const values: PatternValues = { name: parsed.title, year: parsed.year, season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd };
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
async function lookupMovie(parsed: ParsedMedia, metadata: MetadataSource): Promise<LookupResult> {
  const values: PatternValues = { name: parsed.title, year: parsed.year };
  const movie = await metadata.findMovie(parsed.title, parsed.year);
  if (!movie) {
    const reason = metadata.tmdbKey ? 'No TMDB match' : 'No TMDB key';
    return { values, status: 'warning', message: `${reason}; using parsed name` };
  }
  Object.assign(values, { name: movie.name, originalName: movie.originalName, year: movie.year ?? parsed.year });
  return { values, match: `${movie.source}: ${movie.name}${yearSuffix(movie.year)}` };
}

const LOOKUPS: Record<MediaKind, (parsed: ParsedMedia, metadata: MetadataSource) => Promise<LookupResult>> = { episode: lookupEpisode, movie: lookupMovie };

async function describe(
  rel: string,
  parsed: ParsedMedia,
  patterns: Patterns,
  metadata: MetadataSource,
  { moving = false }: { moving?: boolean } = {},
): Promise<PreviewItem> {
  const base: PreviewItem = { rel, kind: parsed.kind, newRel: null, target: null, status: 'ok', match: null, message: null };
  if (!Object.hasOwn(LOOKUPS, parsed.kind)) return { ...base, status: 'skipped', message: 'Not recognised as a movie or episode' };
  if (parsed.kind === 'episode' && !parsed.title) return { ...base, status: 'skipped', message: 'Series name could not be determined' };

  const { values, match = null, status = 'ok', message = null } = await LOOKUPS[parsed.kind as MediaKind](parsed, metadata);
  const item: PreviewItem = { ...base, match, status, message };
  const rendered = renderPattern(patterns[parsed.kind as MediaKind], values);
  if (!rendered) return { ...item, status: 'error', message: 'Pattern produced an empty name' };
  const fileName = `${rendered}${parsed.language ? `.${parsed.language}` : ''}${parsed.extension}`;
  const directory = path.posix.dirname(rel);
  // Renaming in place keeps the file's subfolder. Moving into a library starts at
  // the destination root, so download folder names never end up in the library.
  item.newRel = moving || rendered.includes('/') || directory === '.' ? fileName : `${directory}/${fileName}`;
  return item;
}

const CONFLICT_MESSAGES: Record<ConflictReason, string> = {
  duplicate: 'Another file maps to the same name',
  exists: 'A file with the new name already exists',
};

/** Mark an item as a conflict, keeping what it was before so the UI can restore it once resolved. */
function markConflict(item: PreviewItem, reason: ConflictReason): void {
  item.conflict = { reason, status: item.status, message: item.message };
  Object.assign(item, { status: 'conflict', message: CONFLICT_MESSAGES[reason] });
}

/**
 * Mark items that are already named correctly or that collide with each other
 * or with an existing file. Items whose new name is taken get `existingSize`.
 */
async function markConflicts(root: string, items: PreviewItem[]): Promise<void> {
  const byTarget = new Map<string, PreviewItem[]>();
  for (const item of items) {
    if (!item.newRel || !['ok', 'warning'].includes(item.status)) continue;
    const destination = item.target ?? root;
    const sameRoot = destination === root;
    if (sameRoot && item.newRel === item.rel) {
      Object.assign(item, { status: 'unchanged', message: 'Already named correctly' });
      continue;
    }
    const key = `${destination}\0${item.newRel.toLowerCase()}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), item]);
    const caseOnly = sameRoot && item.rel.toLowerCase() === item.newRel.toLowerCase();
    const existing = caseOnly ? null : await lstatIfExists(resolveInside(destination, item.newRel));
    if (existing) item.existingSize = existing.size;
  }
  for (const group of byTarget.values()) {
    for (const item of group) {
      if (group.length > 1) markConflict(item, 'duplicate');
      else if (item.existingSize !== undefined) markConflict(item, 'exists');
    }
  }
}

/** Per-kind destinations from either `targets` ({ episode, movie }) or one shared `target`. */
export function destinationsFrom({ target = null, targets }: { target?: string | null; targets?: Partial<Targets> } = {}): Targets {
  return {
    episode: targets && targets.episode !== undefined ? targets.episode : target,
    movie: targets && targets.movie !== undefined ? targets.movie : target,
  };
}

function validatePatterns(patterns: Patterns): void {
  for (const [kind, pattern] of Object.entries(patterns)) {
    try {
      validatePattern(pattern);
    } catch (error) {
      throw new InputError(`${kind} pattern: ${(error as Error).message}`);
    }
  }
}

/**
 * Compute proposed names without touching the file system.
 * TV episodes go to `targets.episode`, movies to `targets.movie` (a shared `target`
 * sets both; null renames in place). Each item's `newRel` is relative to its
 * `target`, or to `root` when the item stays in place.
 */
export async function buildPreview({ root, target = null, targets, files, patterns = DEFAULT_PATTERNS, filters = DEFAULT_FILTERS, metadata, concurrency = 3 }: PreviewOptions): Promise<PreviewItem[]> {
  if (!Array.isArray(files)) throw new InputError('files must be an array');
  if (files.length > MAX_FILES) throw new InputError(`At most ${MAX_FILES} files can be previewed at once`);
  const destinations: Partial<Record<ParsedKind, string | null>> = destinationsFrom({ target, targets });
  const effective: Patterns = { ...DEFAULT_PATTERNS, ...patterns };
  validatePatterns(effective);

  const failure = (rel: string, status: ItemStatus, message: string): PreviewItem => ({ rel, kind: 'unknown', newRel: null, target: null, status, match: null, message });
  const items = await mapLimit(files, concurrency, async (input) => {
    let rel = input;
    try {
      rel = toRootRelative(root, input);
      const stat = await lstatIfExists(resolveInside(root, rel));
      if (!stat) return failure(rel, 'error', 'File not found');
      const reason = filterReason(rel, { ...DEFAULT_FILTERS, ...filters });
      if (reason) return failure(rel, 'skipped', reason);
      const parsed = parseRelativePath(rel);
      const destination = destinations[parsed.kind] ?? null;
      const item = await describe(rel, parsed, effective, metadata, { moving: Boolean(destination) });
      if (item.newRel) item.target = destination;
      item.size = stat.size;
      return item;
    } catch (error) {
      return failure(rel, 'error', (error as Error).message);
    }
  });
  await markConflicts(root, items);
  return items;
}
