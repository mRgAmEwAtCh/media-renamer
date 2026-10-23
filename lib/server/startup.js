import { activeTargets, mergeSettings, readSavedSettings } from '../settings.js';

const log = (line) => process.stderr.write(`${line}\n`);

/** Print where the server listens and which features are switched on. */
export function logStartup(config, { shown, port }) {
  log(`Media Renamer running at http://${shown}:${port}/`);
  if (config.roots.length) log(`Allowed folders: ${config.roots.join(', ')}`);
  log(`Movie lookups (TMDB): ${config.tmdbKey ? 'enabled' : 'disabled, set TMDB_API_KEY'}`);
  const pathMap = config.pathMap.length ? ` (path map: ${config.pathMap.map((m) => `${m.from}=${m.to}`).join(', ')})` : '';
  log(`Import hook: ${config.hookToken ? `POST /api/hooks/extracted${pathMap}` : 'disabled, set MEDIA_RENAMER_HOOK_TOKEN'}`);
}

/** Print the effective settings (saved over environment defaults). */
export async function logSettings(config) {
  const saved = await readSavedSettings(config.settingsFile);
  const effective = mergeSettings(config.envSettings, saved.settings);
  const where = (target) => target ?? 'rename in place';
  const targets = activeTargets(effective);
  log(`Settings: ${config.settingsFile}${saved.exists ? '' : ' (not saved yet; using defaults)'}`);
  for (const problem of saved.problems) log(`warning: ${problem}`);
  log(`Destinations: TV → ${where(targets.episode)}, movies → ${where(targets.movie)}`);
  log(`Metadata language: ${effective.language}${effective.region ? `, region ${effective.region}` : ''}`);
}
