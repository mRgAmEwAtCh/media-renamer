import { InputError } from '../errors.ts';
import { normalizeLanguage, normalizeRegion } from '../metadata.ts';
import { destinationsFrom, resolveRoot, resolveTarget } from '../renamer.ts';
import { activeTargets, mergeSettings, readSavedSettings } from '../settings.ts';
import { createRootPolicy } from './root-policy.ts';

/**
 * What every route needs: the configuration, the root policy, the current
 * settings and helpers that turn request fields into checked folders.
 */
export function createContext(config, { jobs, createMetadata, push }) {
  const policy = createRootPolicy(config.roots);

  const currentSettings = async () => {
    const saved = await readSavedSettings(config.settingsFile);
    return { saved, effective: mergeSettings(config.envSettings, saved.settings) };
  };

  /** Request filters, falling back to the settings. */
  const filtersFrom = (body, settings) => ({
    videoOnly: typeof body.videoOnly === 'boolean' ? body.videoOnly : settings.filters.videoOnly,
    excludeSamples: typeof body.excludeSamples === 'boolean' ? body.excludeSamples : settings.filters.excludeSamples,
  });

  /** Request language and region, falling back to the settings. */
  const localeFrom = (body, settings) => {
    try {
      return {
        language: normalizeLanguage(body.language) ?? settings.language,
        region: body.region === undefined ? settings.region : normalizeRegion(body.region),
      };
    } catch (error) {
      throw new InputError(error.message);
    }
  };

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
    return allowedRoot(input);
  };

  /** Destinations for a preview: `targets` ({ episode, movie }), a legacy single `target`, or else the saved/configured defaults. */
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

  const metadataFor = ({ language, region }) => createMetadata({ tmdbKey: config.tmdbKey, language, region });

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
