import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsResponse } from '../../../lib/api-types.ts';
import { api, errorMessage } from '../api.ts';
import { readLocal } from '../local.ts';
import { changedFields, EMPTY_FORM, formFromSettings, settingsFromForm, type SettingsForm } from '../settings-form.ts';
import type { SetStatus } from './useStatus.ts';

const BITRATES = ['640k', '768k', '1024k', '1536k'];

export interface ServerInfo {
  tmdbStatus: string;
  hookStatus: string;
}

function describeServer(response: { tmdbConfigured: boolean; hookEnabled: boolean; audioToolsAvailable: boolean }): ServerInfo {
  return {
    tmdbStatus: response.tmdbConfigured
      ? 'Movie lookups (TMDB): enabled by the server configuration.'
      : 'Movie lookups (TMDB): disabled. Set TMDB_API_KEY in the server configuration to enable them.',
    hookStatus: [
      response.hookEnabled
        ? 'The import hook is enabled (POST /api/hooks/extracted).'
        : 'The import hook is disabled. Set MEDIA_RENAMER_HOOK_TOKEN on the server to enable it.',
      response.audioToolsAvailable ? '' : 'ffmpeg is not installed, so audio tracks cannot be added.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * Earlier versions kept patterns and destinations in this browser only. Offer
 * them once (as unsaved changes) if nothing has been saved on the server yet.
 */
function legacyChanges(): Partial<SettingsForm> | null {
  const legacy = readLocal();
  if (!['episodePattern', 'moviePattern', 'target', 'language'].some((key) => legacy[key as keyof typeof legacy])) return null;
  return {
    ...(legacy.episodePattern && { episodePattern: legacy.episodePattern }),
    ...(legacy.moviePattern && { moviePattern: legacy.moviePattern }),
    ...(legacy.moveEnabled && legacy.target && { move: true, tvTarget: legacy.target, movieTarget: legacy.target }),
    ...(legacy.language && { language: legacy.language }),
    ...(legacy.region && { region: legacy.region }),
  };
}

/**
 * The settings form: loaded from the server, edited in the page, and saved
 * as the default for every browser and the CLI. `onLoaded` runs once after the
 * first load (the caller then rewrites what this browser remembers).
 */
export function useSettings(setStatus: SetStatus, onLoaded: () => void) {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM);
  /** The settings as last loaded or saved; null until the first load. */
  const [savedForm, setSavedForm] = useState<SettingsForm | null>(null);
  const [saved, setSaved] = useState({ exists: false, at: null as string | null });
  const [server, setServer] = useState<ServerInfo>({ tmdbStatus: '', hookStatus: '' });
  const [extraBitrates, setExtraBitrates] = useState<string[]>([]);
  const loaded = useRef(false);

  const changes = useMemo(() => (savedForm ? changedFields(form, savedForm) : []), [form, savedForm]);
  const dirty = changes.length > 0;
  const update = useCallback((patch: Partial<SettingsForm>) => setForm((current) => ({ ...current, ...patch })), []);

  /** Show a settings response from the server and remember it as the saved state. */
  const remember = useCallback((response: SettingsResponse) => {
    const next = formFromSettings(response.settings);
    const bitrate = next.audioBitrate;
    if (!BITRATES.includes(bitrate)) setExtraBitrates((current) => (current.includes(bitrate) ? current : [...current, bitrate]));
    setForm(next);
    setSavedForm(next);
    setSaved({ exists: response.saved, at: response.savedAt });
    return next;
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        const response = await api('/api/settings', {});
        const next = remember(response);
        setServer(describeServer(response));
        if (response.problems?.length) setStatus(`Saved settings problem: ${response.problems.join('; ')}`, 'error');
        const legacy = response.saved ? null : legacyChanges();
        if (legacy) {
          setForm({ ...next, ...legacy });
          setStatus('Loaded the settings this browser remembered. Click “Save as default” to keep them on the server.');
        }
        onLoaded();
      } catch (error) {
        setServer((current) => ({ ...current, tmdbStatus: `Could not read server settings: ${errorMessage(error)}` }));
      }
    })();
  }, [remember, setStatus, onLoaded]);

  /** Save the form as the default; resolves to the saved form, or null when saving failed. */
  const save = useCallback(async (): Promise<SettingsForm | null> => {
    try {
      const next = remember(await api('/api/settings/save', { settings: settingsFromForm(form) }));
      setStatus('Saved as default. The web UI on every device, imports and the CLI now use these settings.', 'success');
      return next;
    } catch (error) {
      setStatus(`Not saved: ${errorMessage(error)}`, 'error');
      return null;
    }
  }, [form, remember, setStatus]);

  /** Drop unsaved changes; resolves to the saved form now shown. */
  const revert = useCallback((): SettingsForm => {
    const next = savedForm ?? form;
    setForm(next);
    setStatus('Unsaved changes discarded.');
    return next;
  }, [form, savedForm, setStatus]);

  const reset = useCallback(async () => {
    if (!confirm('Forget the saved defaults and use the server’s configuration again?')) return;
    try {
      remember(await api('/api/settings/reset', {}));
      setStatus('Saved defaults removed. Using the server’s configuration.', 'success');
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    }
  }, [remember, setStatus]);

  const bitrates = useMemo(() => [...BITRATES, ...extraBitrates], [extraBitrates]);

  return { form, loaded: savedForm !== null, update, dirty, changes, saved, server, bitrates, save, revert, reset };
}

export type SettingsState = ReturnType<typeof useSettings>;
