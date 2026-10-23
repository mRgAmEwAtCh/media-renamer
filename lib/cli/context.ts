import { readSecret } from '../config.ts';
import { MetadataClient, normalizeLanguage, normalizeRegion } from '../metadata.ts';
import { resolveRoot, resolveTarget } from '../renamer.ts';
import { activeTargets } from '../settings.ts';
import type { Filters, Patterns, Settings, Targets } from '../types.ts';
import { UsageError } from './args.ts';
import type { CliValues } from './args.ts';

/** Everything a folder command works with (what `buildContext` returns). */
export interface CliContext {
  root: string;
  targets: Targets;
  /** True when --target, --tv-target or --movie-target was given. */
  explicitTarget: boolean;
  filters: Filters;
  patterns: Patterns;
  language: string;
  region: string | null;
  settings: Settings;
}

type Locale = Pick<CliContext, 'language' | 'region'>;

const TARGET_COMMANDS = ['preview', 'apply', 'import'];

export const createMetadata = (ctx: Locale) =>
  new MetadataClient({ tmdbKey: readSecret(process.env, 'TMDB_API_KEY'), language: ctx.language, region: ctx.region });

/** Destinations: saved/environment defaults, overridden by --target, --tv-target and --movie-target. */
async function targetsFor(
  command: string,
  root: string,
  values: CliValues,
  effective: Settings,
): Promise<{ targets: Targets; explicitTarget: boolean }> {
  const flags = (['target', 'tv-target', 'movie-target'] as const).filter((name) => values[name] !== undefined);
  const usesTargets = TARGET_COMMANDS.includes(command);
  if (flags.length && !usesTargets) throw new UsageError(`--${flags[0]} is only used by preview, apply and import`);
  if (!usesTargets) return { targets: { episode: null, movie: null }, explicitTarget: false };
  const wanted: Targets = activeTargets(effective);
  if (values.target !== undefined) Object.assign(wanted, { episode: values.target, movie: values.target });
  if (values['tv-target'] !== undefined) wanted.episode = values['tv-target'];
  if (values['movie-target'] !== undefined) wanted.movie = values['movie-target'];
  const targets: Targets = { episode: await resolveTarget(root, wanted.episode), movie: await resolveTarget(root, wanted.movie) };
  return { targets, explicitTarget: flags.length > 0 };
}

function filtersFor(values: CliValues, effective: Settings): Filters {
  if (values['video-only'] && values['all-types']) throw new UsageError('--video-only and --all-types cannot be combined');
  return {
    videoOnly: values['video-only'] ? true : values['all-types'] ? false : effective.filters.videoOnly,
    excludeSamples: values['include-samples'] ? false : effective.filters.excludeSamples,
  };
}

function localeFor(values: CliValues, effective: Settings): Locale {
  try {
    return {
      language: normalizeLanguage(values.language) ?? effective.language,
      region: values.region !== undefined ? normalizeRegion(values.region) : effective.region,
    };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Everything a folder command needs: the folder, destinations, filters, patterns and metadata locale. */
export async function buildContext(command: string, directory: string, values: CliValues, effective: Settings): Promise<CliContext> {
  const root = await resolveRoot(directory);
  const { targets, explicitTarget } = await targetsFor(command, root, values, effective);
  const filters = filtersFor(values, effective);
  const patterns: Patterns = {
    episode: values['episode-pattern'] ?? effective.patterns.episode,
    movie: values['movie-pattern'] ?? effective.patterns.movie,
  };
  return { root, targets, explicitTarget, filters, patterns, ...localeFor(values, effective), settings: effective };
}
