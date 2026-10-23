import { readSecret } from '../config.js';
import { MetadataClient, normalizeLanguage, normalizeRegion } from '../metadata.js';
import { resolveRoot, resolveTarget } from '../renamer.js';
import { activeTargets } from '../settings.js';
import { UsageError } from './args.js';

const TARGET_COMMANDS = ['preview', 'apply', 'import'];

export const createMetadata = (ctx) =>
  new MetadataClient({ tmdbKey: readSecret(process.env, 'TMDB_API_KEY'), language: ctx.language, region: ctx.region });

/** Destinations: saved/environment defaults, overridden by --target, --tv-target and --movie-target. */
async function targetsFor(command, root, values, effective) {
  const flags = ['target', 'tv-target', 'movie-target'].filter((name) => values[name] !== undefined);
  const usesTargets = TARGET_COMMANDS.includes(command);
  if (flags.length && !usesTargets) throw new UsageError(`--${flags[0]} is only used by preview, apply and import`);
  if (!usesTargets) return { targets: { episode: null, movie: null }, explicitTarget: false };
  const wanted = activeTargets(effective);
  if (values.target !== undefined) Object.assign(wanted, { episode: values.target, movie: values.target });
  if (values['tv-target'] !== undefined) wanted.episode = values['tv-target'];
  if (values['movie-target'] !== undefined) wanted.movie = values['movie-target'];
  const targets = { episode: await resolveTarget(root, wanted.episode), movie: await resolveTarget(root, wanted.movie) };
  return { targets, explicitTarget: flags.length > 0 };
}

function filtersFor(values, effective) {
  if (values['video-only'] && values['all-types']) throw new UsageError('--video-only and --all-types cannot be combined');
  return {
    videoOnly: values['video-only'] ? true : values['all-types'] ? false : effective.filters.videoOnly,
    excludeSamples: values['include-samples'] ? false : effective.filters.excludeSamples,
  };
}

function localeFor(values, effective) {
  try {
    return {
      language: normalizeLanguage(values.language) ?? effective.language,
      region: values.region !== undefined ? normalizeRegion(values.region) : effective.region,
    };
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/** Everything a folder command needs: the folder, destinations, filters, patterns and metadata locale. */
export async function buildContext(command, directory, values, effective) {
  const root = await resolveRoot(directory);
  const { targets, explicitTarget } = await targetsFor(command, root, values, effective);
  const filters = filtersFor(values, effective);
  const patterns = {
    episode: values['episode-pattern'] ?? effective.patterns.episode,
    movie: values['movie-pattern'] ?? effective.patterns.movie,
  };
  return { root, targets, explicitTarget, filters, patterns, ...localeFor(values, effective), settings: effective };
}
