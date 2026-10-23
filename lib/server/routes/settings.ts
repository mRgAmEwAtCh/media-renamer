import path from 'node:path';
import { audioToolsAvailable } from '../../audio.ts';
import { listPlaces } from '../../browse.ts';
import { nativeDialogAvailable } from '../../native-dialog.ts';
import type { Settings } from '../../types.ts';
import type { RouteContext } from '../context.ts';
import type { RequestBody, Routes } from '../http.ts';
import { deleteSavedSettings, mergeSettings, sanitizeSettings, writeSavedSettings } from '../../settings.ts';

/** Server capabilities and the saved defaults. */
export function settingsRoutes({ config, policy, currentSettings, allowedFolder }: RouteContext): Routes {
  const unsaved = (settings: Settings) => ({ settings, defaults: config.envSettings, saved: false, savedAt: null, problems: [] });

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
        hookEnabled: Boolean(config.hookToken),
        audioToolsAvailable: await audioToolsAvailable(config.audioTools),
      };
    },

    async '/api/settings/save'(body: RequestBody) {
      const input = body.settings;
      const { settings } = sanitizeSettings(input, { strict: true });
      if (settings.targets) {
        for (const kind of ['episode', 'movie'] as const) {
          if (Object.hasOwn(settings.targets, kind)) settings.targets[kind] = await allowedFolder((input as { targets: Record<string, unknown> }).targets[kind]);
        }
      }
      const { savedAt } = await writeSavedSettings(config.settingsFile, settings);
      return { ...unsaved(mergeSettings(config.envSettings, settings)), saved: true, savedAt };
    },

    async '/api/settings/reset'() {
      await deleteSavedSettings(config.settingsFile);
      return unsaved(config.envSettings);
    },
  };
}
