import type { Patterns, SavedSettings, Settings, Targets } from '../../lib/types.ts';
import type { PreviewRequest } from '../../lib/api-types.ts';

/** The settings form's fields, as the inputs hold them. */
export interface SettingsForm {
  episodePattern: string;
  moviePattern: string;
  move: boolean;
  tvTarget: string;
  movieTarget: string;
  language: string;
  region: string;
  videoOnly: boolean;
  excludeSamples: boolean;
  autoEnabled: boolean;
  autoWarnings: boolean;
  autoCleanup: boolean;
  audioFixEnabled: boolean;
  audioFixEpisodes: boolean;
  audioLanguages: string;
  audioBitrate: string;
}

export const EMPTY_FORM: SettingsForm = {
  episodePattern: '',
  moviePattern: '',
  move: false,
  tvTarget: '',
  movieTarget: '',
  language: '',
  region: '',
  videoOnly: false,
  excludeSamples: true,
  autoEnabled: false,
  autoWarnings: false,
  autoCleanup: false,
  audioFixEnabled: false,
  audioFixEpisodes: false,
  audioLanguages: '',
  audioBitrate: '1024k',
};

const csvLower = (text: string) => text.split(',').map((code) => code.trim().toLowerCase()).filter(Boolean);

export function formFromSettings(settings: Settings): SettingsForm {
  const { automation } = settings;
  return {
    episodePattern: settings.patterns.episode,
    moviePattern: settings.patterns.movie,
    move: settings.move,
    tvTarget: settings.targets.episode ?? '',
    movieTarget: settings.targets.movie ?? '',
    language: settings.language ?? '',
    region: settings.region ?? '',
    videoOnly: settings.filters.videoOnly,
    excludeSamples: settings.filters.excludeSamples,
    autoEnabled: automation.enabled,
    autoWarnings: automation.includeWarnings,
    autoCleanup: automation.cleanupEmptyFolders,
    audioFixEnabled: automation.audioFix.enabled,
    audioFixEpisodes: automation.audioFix.episodes,
    audioLanguages: automation.audioFix.languages.join(', '),
    audioBitrate: automation.audioFix.bitrate,
  };
}

/** The settings as saved by "Save". */
export function settingsFromForm(form: SettingsForm): SavedSettings {
  return {
    patterns: patternsOf(form),
    targets: { episode: form.tvTarget.trim() || null, movie: form.movieTarget.trim() || null },
    move: form.move,
    language: form.language.trim(),
    region: form.region.trim().toUpperCase() || null,
    filters: { videoOnly: form.videoOnly, excludeSamples: form.excludeSamples },
    automation: {
      enabled: form.autoEnabled,
      includeWarnings: form.autoWarnings,
      cleanupEmptyFolders: form.autoCleanup,
      audioFix: {
        enabled: form.audioFixEnabled,
        episodes: form.audioFixEpisodes,
        languages: csvLower(form.audioLanguages),
        bitrate: form.audioBitrate,
      },
    },
  };
}

const patternsOf = (form: SettingsForm): Patterns => ({ episode: form.episodePattern, movie: form.moviePattern });

/** Destinations to request: none unless moving; an empty field renames that kind in place. */
export function requestedTargets(form: SettingsForm): Targets {
  if (!form.move) return { episode: null, movie: null };
  return { episode: form.tvTarget.trim() || null, movie: form.movieTarget.trim() || null };
}

export const formFilters = (form: SettingsForm) => ({ videoOnly: form.videoOnly, excludeSamples: form.excludeSamples });

/** Naming and lookup options for a preview request. */
export function previewOptions(form: SettingsForm): Omit<PreviewRequest, 'root' | 'files' | 'targets'> {
  return {
    patterns: patternsOf(form),
    ...formFilters(form),
    ...(form.language.trim() && { language: form.language.trim() }),
    region: form.region.trim() || null,
  };
}

const FIELD_LABELS: Record<keyof SettingsForm, string> = {
  episodePattern: 'Episode pattern',
  moviePattern: 'Movie pattern',
  move: 'Move renamed files',
  tvTarget: 'Destination for TV shows',
  movieTarget: 'Destination for movies',
  language: 'Language',
  region: 'Region',
  videoOnly: 'Video files only',
  excludeSamples: 'Skip sample files',
  autoEnabled: 'Automatic import',
  autoWarnings: 'Import files with warnings',
  autoCleanup: 'Remove empty folders',
  audioFixEnabled: 'Add audio tracks',
  audioFixEpisodes: 'Add audio tracks to episodes',
  audioLanguages: 'Audio languages',
  audioBitrate: 'Audio bitrate',
};

/** Fields that change the names and destinations a preview proposes. */
export const PREVIEW_FIELDS: ReadonlySet<keyof SettingsForm> = new Set(['episodePattern', 'moviePattern', 'move', 'tvTarget', 'movieTarget', 'language', 'region']);

/** The fields that differ from the saved settings, compared as they would be saved. */
export function changedFields(form: SettingsForm, saved: SettingsForm): (keyof SettingsForm)[] {
  const normalized = (value: SettingsForm) => formFromSettings(settingsFromForm(value) as Settings);
  const [a, b] = [normalized(form), normalized(saved)];
  return (Object.keys(FIELD_LABELS) as (keyof SettingsForm)[]).filter((key) => a[key] !== b[key]);
}

export const fieldLabel = (key: keyof SettingsForm): string => FIELD_LABELS[key];
