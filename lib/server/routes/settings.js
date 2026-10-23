import path from 'node:path';
import { audioToolsAvailable } from '../../audio.js';
import { listPlaces } from '../../browse.js';
import { nativeDialogAvailable } from '../../native-dialog.js';
import { deleteSavedSettings, mergeSettings, sanitizeSettings, writeSavedSettings } from '../../settings.js';

/** Server capabilities and the saved defaults. */
export function settingsRoutes({ config, policy, currentSettings, allowedFolder }) {
  const unsaved = (settings) => ({ settings, defaults: config.envSettings, saved: false, savedAt: null, problems: [] });

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

    async '/api/settings/save'(body) {
      const input = body.settings;
      const { settings } = sanitizeSettings(input, { strict: true });
      if (settings.targets) {
        for (const kind of ['episode', 'movie']) {
          if (Object.hasOwn(settings.targets, kind)) settings.targets[kind] = await allowedFolder(input.targets[kind]);
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
