import type { Config } from '../config.ts';
import { InputError } from '../errors.ts';
import type { JobManager } from '../jobs.ts';
import { normalizeLanguage, normalizeRegion } from '../metadata.ts';
import { destinationsFrom, resolveRoot, resolveTarget } from '../renamer.ts';
import { activeTargets, mergeSettings, readSavedSettings } from '../settings.ts';
import type { Push } from '../push.ts';
import type { Filters, MetadataSource, Settings, Targets } from '../types.ts';
import type { RequestBody } from './http.ts';
import { createRootPolicy } from './root-policy.ts';

export interface Locale {
  language: string;
  region: string | null;
}

/** Creates the metadata lookups for one language and region (tests pass fakes). */
export type MetadataFactory = (options: { tmdbKey: string } & Locale) => MetadataSource;

export interface ContextServices {
  jobs: JobManager;
  createMetadata: MetadataFactory;
  push: Push;
}

/** What createContext gives every route. */
export type RouteContext = ReturnType<typeof createContext>;

/**
 * What every route needs: the configuration, the root policy, the current
 * settings and helpers that turn request fields into checked folders.
 */
export function createContext(config: Config, { jobs, createMetadata, push }: ContextServices) {
  const policy = createRootPolicy(config.roots);

  const currentSettings = async () => {
    const saved = await readSavedSettings(config.settingsFile);
    return { saved, effective: mergeSettings(config.envSettings, saved.settings) };
  };

  /** Request filters, falling back to the settings. */
  const filtersFrom = (body: RequestBody, settings: Settings): Filters => ({
    videoOnly: typeof body.videoOnly === 'boolean' ? body.videoOnly : settings.filters.videoOnly,
    excludeSamples: typeof body.excludeSamples === 'boolean' ? body.excludeSamples : settings.filters.excludeSamples,
  });

  /** Request language and region, falling back to the settings. */
  const localeFrom = (body: RequestBody, settings: Settings): Locale => {
    try {
      return {
        language: normalizeLanguage(body.language) ?? settings.language,
        region: body.region === undefined ? settings.region : normalizeRegion(body.region),
      };
    } catch (error) {
      throw new InputError((error as Error).message);
    }
  };

  const allowedRoot = async (input: unknown): Promise<string> => {
    const root = await resolveRoot(input);
    await policy.check(root);
    return root;
  };

  const allowedTarget = async (root: string, input: unknown): Promise<string | null> => {
    const target = await resolveTarget(root, input);
    if (target) await policy.check(target);
    return target;
  };

  /** Folder to store as a default destination: must exist and be allowed. */
  const allowedFolder = async (input: unknown): Promise<string | null> => {
    if (input === null || input === undefined || (typeof input === 'string' && !input.trim())) return null;
    return allowedRoot(input);
  };

  /** Destinations for a preview: `targets` ({ episode, movie }), a legacy single `target`, or else the saved/configured defaults. */
  const previewTargets = async (root: string, body: RequestBody, settings: Settings): Promise<Targets> => {
    let requested: Targets;
    if (body.targets && typeof body.targets === 'object') requested = destinationsFrom({ targets: body.targets as Partial<Targets> });
    else if (body.target !== undefined) requested = destinationsFrom({ target: body.target as string | null });
    else requested = activeTargets(settings);
    return {
      episode: await allowedTarget(root, requested.episode ?? null),
      movie: await allowedTarget(root, requested.movie ?? null),
    };
  };

  const metadataFor = ({ language, region }: Locale): MetadataSource => createMetadata({ tmdbKey: config.tmdbKey, language, region });

  return {
    config,
    jobs,
    push,
    policy,
    currentSettings,
    filtersFrom,
    localeFrom,
    allowedRoot,
    allowedTarget,
    allowedFolder,
    previewTargets,
    metadataFor,
  };
}
