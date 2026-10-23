import { api } from './api.js';
import { $, setStatus } from './dom.js';
import { state } from './state.js';

// The browser only remembers the last source folder; everything else is saved on the server.
const LOCAL_KEY = 'media-renamer:settings';

/** Form settings as last loaded from / saved to the server. */
const saved = { snapshot: null, exists: false, at: null };

export function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ root: $('root').value.trim(), recursive: $('recursive').checked }));
}

const csvLower = (text) => text.split(',').map((code) => code.trim().toLowerCase()).filter(Boolean);

/** The settings as currently entered in the form. */
function formSettings() {
  return {
    patterns: { episode: $('episodePattern').value, movie: $('moviePattern').value },
    targets: { episode: $('tvTarget').value.trim() || null, movie: $('movieTarget').value.trim() || null },
    move: $('moveEnabled').checked,
    language: $('language').value.trim(),
    region: $('region').value.trim().toUpperCase() || null,
    filters: formFilters(),
    automation: {
      enabled: $('autoEnabled').checked,
      includeWarnings: $('autoWarnings').checked,
      cleanupEmptyFolders: $('autoCleanup').checked,
      audioFix: {
        enabled: $('audioFixEnabled').checked,
        episodes: $('audioFixEpisodes').checked,
        languages: csvLower($('audioLanguages').value),
        bitrate: $('audioBitrate').value,
      },
    },
  };
}

function applySettings(settings) {
  $('episodePattern').value = settings.patterns.episode;
  $('moviePattern').value = settings.patterns.movie;
  $('tvTarget').value = settings.targets.episode ?? '';
  $('movieTarget').value = settings.targets.movie ?? '';
  $('moveEnabled').checked = settings.move;
  $('language').value = settings.language ?? '';
  $('region').value = settings.region ?? '';
  $('videoOnly').checked = settings.filters.videoOnly;
  $('excludeSamples').checked = settings.filters.excludeSamples;
  const { automation } = settings;
  $('autoEnabled').checked = automation.enabled;
  $('autoWarnings').checked = automation.includeWarnings;
  $('autoCleanup').checked = automation.cleanupEmptyFolders;
  $('audioFixEnabled').checked = automation.audioFix.enabled;
  $('audioFixEpisodes').checked = automation.audioFix.episodes;
  $('audioLanguages').value = automation.audioFix.languages.join(', ');
  const bitrate = $('audioBitrate');
  if (![...bitrate.options].some((option) => option.value === automation.audioFix.bitrate)) {
    bitrate.append(new Option(automation.audioFix.bitrate, automation.audioFix.bitrate));
  }
  bitrate.value = automation.audioFix.bitrate;
  syncTargetFields();
}

/** Show a settings response from the server and remember it as the saved state. */
function rememberSaved(response) {
  applySettings(response.settings);
  Object.assign(saved, { snapshot: JSON.stringify(formSettings()), exists: response.saved, at: response.savedAt });
  updateDefaultsStatus();
}

export const isDirty = () => saved.snapshot !== null && JSON.stringify(formSettings()) !== saved.snapshot;

export function updateDefaultsStatus() {
  const status = $('defaultsStatus');
  if (isDirty()) {
    status.textContent = 'Unsaved changes. “Save as default” keeps them for all browsers and the CLI.';
    status.className = 'hint dirty';
  } else if (saved.exists) {
    const when = saved.at ? ` (${new Date(saved.at).toLocaleString()})` : '';
    status.textContent = `Using your saved defaults${when}.`;
    status.className = 'hint';
  } else {
    status.textContent = 'Using the server’s defaults. Nothing saved yet.';
    status.className = 'hint';
  }
  $('saveDefaults').disabled = state.busy || !isDirty();
  $('resetDefaults').disabled = state.busy || !saved.exists;
}

function describeServer(response) {
  $('tmdbStatus').textContent = response.tmdbConfigured
    ? 'Movie lookups (TMDB): enabled by the server configuration.'
    : 'Movie lookups (TMDB): disabled. Set TMDB_API_KEY in the server configuration to enable them.';
  $('hookStatus').textContent = [
    response.hookEnabled
      ? 'The import hook is enabled (POST /api/hooks/extracted).'
      : 'The import hook is disabled. Set MEDIA_RENAMER_HOOK_TOKEN on the server to enable it.',
    response.audioToolsAvailable ? '' : 'ffmpeg is not installed, so audio tracks cannot be added.',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function loadServerSettings() {
  try {
    const response = await api('/api/settings', {});
    rememberSaved(response);
    describeServer(response);
    if (response.problems?.length) setStatus(`Saved settings problem: ${response.problems.join('; ')}`, 'error');
    adoptLegacyBrowserSettings(response.saved);
  } catch (error) {
    $('tmdbStatus').textContent = `Could not read server settings: ${error.message}`;
  }
}

/**
 * Earlier versions kept patterns and destinations in this browser only. Offer
 * them once (as unsaved changes) if nothing has been saved on the server yet.
 */
function adoptLegacyBrowserSettings(serverHasSaved) {
  const legacy = readLocal();
  const hasLegacy = ['episodePattern', 'moviePattern', 'target', 'language'].some((key) => legacy[key]);
  if (hasLegacy && !serverHasSaved) {
    if (legacy.episodePattern) $('episodePattern').value = legacy.episodePattern;
    if (legacy.moviePattern) $('moviePattern').value = legacy.moviePattern;
    if (legacy.moveEnabled && legacy.target) {
      $('moveEnabled').checked = true;
      $('tvTarget').value = legacy.target;
      $('movieTarget').value = legacy.target;
    }
    if (legacy.language) $('language').value = legacy.language;
    if (legacy.region) $('region').value = legacy.region;
    syncTargetFields();
    updateDefaultsStatus();
    setStatus('Loaded the settings this browser remembered. Click “Save as default” to keep them on the server.');
  }
  saveLocal(); // drop the legacy fields; only the source folder stays in the browser
}

export async function saveDefaults() {
  try {
    rememberSaved(await api('/api/settings/save', { settings: formSettings() }));
    setStatus('Saved as default. The web UI on every device and the CLI now use these settings.', 'success');
  } catch (error) {
    setStatus(`Not saved: ${error.message}`, 'error');
  }
}

export async function resetDefaults() {
  if (!confirm('Forget the saved defaults and use the server’s configuration again?')) return;
  try {
    rememberSaved(await api('/api/settings/reset', {}));
    setStatus('Saved defaults removed. Using the server’s configuration.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

/** Destination fields are only shown while "Move renamed files" is ticked. */
export function syncTargetFields() {
  for (const field of document.querySelectorAll('.target-field')) field.hidden = !$('moveEnabled').checked;
}

/** Destinations to request: none unless moving; an empty field renames that kind in place. */
export function requestedTargets() {
  if (!$('moveEnabled').checked) return { episode: null, movie: null };
  return { episode: $('tvTarget').value.trim() || null, movie: $('movieTarget').value.trim() || null };
}

export const formFilters = () => ({ videoOnly: $('videoOnly').checked, excludeSamples: $('excludeSamples').checked });

/** Naming and lookup options for a preview request. */
export function previewOptions() {
  return {
    patterns: { episode: $('episodePattern').value, movie: $('moviePattern').value },
    ...formFilters(),
    ...($('language').value.trim() && { language: $('language').value.trim() }),
    region: $('region').value.trim() || null,
  };
}
