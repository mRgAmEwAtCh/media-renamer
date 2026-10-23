import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FILTERS, DEFAULT_PATTERNS, KINDS } from '../defaults.ts';
import { validatePattern } from '../format.ts';
import { DEFAULT_LANGUAGE, normalizeLanguage, normalizeRegion } from '../metadata.ts';
import { AUDIO_LANGUAGE, blankToNull, csv, KIND_LABEL, validAudioBitrate } from './values.ts';

export const SETTINGS_FILE_NAME = 'settings.json';

/** Parse a boolean environment value; undefined/empty returns the fallback. */
export function envFlag(value, fallback) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value} (use true/false)`);
}

/** Default file filters from MEDIA_RENAMER_VIDEO_ONLY and MEDIA_RENAMER_INCLUDE_SAMPLES. */
export function filterDefaults(env = process.env) {
  return {
    videoOnly: envFlag(env.MEDIA_RENAMER_VIDEO_ONLY, DEFAULT_FILTERS.videoOnly),
    excludeSamples: !envFlag(env.MEDIA_RENAMER_INCLUDE_SAMPLES, !DEFAULT_FILTERS.excludeSamples),
  };
}

/** Where saved settings live: MEDIA_RENAMER_CONFIG_DIR, else the platform's per-user config folder. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.MEDIA_RENAMER_CONFIG_DIR?.trim()) return path.resolve(env.MEDIA_RENAMER_CONFIG_DIR.trim());
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'media-renamer');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'media-renamer');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'media-renamer');
}

export const settingsFilePath = (env = process.env) => path.join(configDir(env), SETTINGS_FILE_NAME);

function envTargets(env) {
  const shared = blankToNull(env.MEDIA_RENAMER_TARGET);
  const targets = {
    episode: env.MEDIA_RENAMER_TV_TARGET !== undefined ? blankToNull(env.MEDIA_RENAMER_TV_TARGET) : shared,
    movie: env.MEDIA_RENAMER_MOVIE_TARGET !== undefined ? blankToNull(env.MEDIA_RENAMER_MOVIE_TARGET) : shared,
  };
  for (const kind of KINDS) {
    if (targets[kind] && !path.isAbsolute(targets[kind])) {
      throw new Error(`${KIND_LABEL[kind]} destination must be an absolute path: ${targets[kind]}`);
    }
  }
  return targets;
}

function envPatterns(env) {
  const patterns = {
    episode: blankToNull(env.MEDIA_RENAMER_EPISODE_PATTERN) ?? DEFAULT_PATTERNS.episode,
    movie: blankToNull(env.MEDIA_RENAMER_MOVIE_PATTERN) ?? DEFAULT_PATTERNS.movie,
  };
  for (const kind of KINDS) {
    try {
      validatePattern(patterns[kind]);
    } catch (error) {
      throw new Error(`Invalid MEDIA_RENAMER_${kind.toUpperCase()}_PATTERN: ${error.message}`);
    }
  }
  return patterns;
}

/** Automatic import defaults from the environment. */
function envAutomation(env, language) {
  const languages = csv(env.MEDIA_RENAMER_AUDIO_LANGUAGES);
  for (const code of languages) {
    if (!AUDIO_LANGUAGE.test(code)) throw new Error(`Invalid MEDIA_RENAMER_AUDIO_LANGUAGES entry: ${code} (use e.g. de,en)`);
  }
  const bitrate = env.MEDIA_RENAMER_AUDIO_BITRATE ? validAudioBitrate(env.MEDIA_RENAMER_AUDIO_BITRATE) : '1024k';
  if (!bitrate) throw new Error(`Invalid MEDIA_RENAMER_AUDIO_BITRATE: ${env.MEDIA_RENAMER_AUDIO_BITRATE} (192k–1536k)`);
  return {
    enabled: envFlag(env.MEDIA_RENAMER_AUTO_IMPORT, true),
    includeWarnings: envFlag(env.MEDIA_RENAMER_AUTO_INCLUDE_WARNINGS, false),
    cleanupEmptyFolders: envFlag(env.MEDIA_RENAMER_CLEANUP_EMPTY_FOLDERS, false),
    audioFix: {
      enabled: envFlag(env.MEDIA_RENAMER_AUDIO_FIX, false),
      episodes: envFlag(env.MEDIA_RENAMER_AUDIO_FIX_EPISODES, false),
      languages: languages.length ? languages : [language.split('-')[0]],
      bitrate,
    },
  };
}

/**
 * Defaults from the environment (or built-ins):
 * MEDIA_RENAMER_EPISODE_PATTERN, MEDIA_RENAMER_MOVIE_PATTERN,
 * MEDIA_RENAMER_TV_TARGET, MEDIA_RENAMER_MOVIE_TARGET (MEDIA_RENAMER_TARGET sets both),
 * MEDIA_RENAMER_LANGUAGE, MEDIA_RENAMER_REGION, MEDIA_RENAMER_VIDEO_ONLY, MEDIA_RENAMER_INCLUDE_SAMPLES,
 * and for automatic imports MEDIA_RENAMER_AUTO_IMPORT, MEDIA_RENAMER_AUTO_INCLUDE_WARNINGS,
 * MEDIA_RENAMER_CLEANUP_EMPTY_FOLDERS, MEDIA_RENAMER_AUDIO_FIX, MEDIA_RENAMER_AUDIO_FIX_EPISODES,
 * MEDIA_RENAMER_AUDIO_LANGUAGES (default: the metadata language) and MEDIA_RENAMER_AUDIO_BITRATE.
 */
export function envSettings(env = process.env) {
  const targets = envTargets(env);
  const patterns = envPatterns(env);
  const language = normalizeLanguage(env.MEDIA_RENAMER_LANGUAGE) ?? DEFAULT_LANGUAGE;
  return {
    patterns,
    targets,
    move: Boolean(targets.episode || targets.movie),
    language,
    region: normalizeRegion(env.MEDIA_RENAMER_REGION),
    filters: filterDefaults(env),
    automation: envAutomation(env, language),
  };
}
