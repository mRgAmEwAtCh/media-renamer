import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePattern } from './format.js';
import { DEFAULT_LANGUAGE, normalizeLanguage, normalizeRegion } from './metadata.js';
import { DEFAULT_FILTERS, DEFAULT_PATTERNS, InputError } from './renamer.js';

export const SETTINGS_FILE_NAME = 'settings.json';
const KINDS = ['episode', 'movie'];
const KIND_LABEL = { episode: 'TV', movie: 'Movie' };

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

const blankToNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const csv = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
const AUDIO_LANGUAGE = /^[a-z]{2,3}$/;
const AUDIO_BITRATE = /^(\d{3,4})k$/;

function validAudioBitrate(value) {
  const match = String(value ?? '').trim().toLowerCase().match(AUDIO_BITRATE);
  const kbps = match ? Number(match[1]) : NaN;
  return kbps >= 192 && kbps <= 1536 ? `${kbps}k` : null;
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

/**
 * Validate a (partial) settings object. Strict mode throws on the first problem
 * (used when saving); lenient mode drops invalid fields and reports them
 * (used when reading a file that may have been edited by hand).
 */
export function sanitizeSettings(input, { strict = false } = {}) {
  const settings = {};
  const problems = [];
  const fail = (message) => {
    if (strict) throw new InputError(message);
    problems.push(message);
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Settings must be an object');
    return { settings, problems };
  }

  if (input.patterns !== undefined) {
    const patterns = {};
    for (const kind of KINDS) {
      const value = input.patterns?.[kind];
      if (value === undefined) continue;
      try {
        validatePattern(value);
        patterns[kind] = value;
      } catch (error) {
        fail(`${KIND_LABEL[kind]} pattern: ${error.message}`);
      }
    }
    if (Object.keys(patterns).length) settings.patterns = patterns;
  }

  if (input.targets !== undefined) {
    const targets = {};
    for (const kind of KINDS) {
      if (!input.targets || !Object.hasOwn(input.targets, kind)) continue;
      const value = input.targets[kind];
      if (value === null || (typeof value === 'string' && !value.trim())) targets[kind] = null;
      else if (typeof value === 'string' && path.isAbsolute(value.trim())) targets[kind] = path.resolve(value.trim());
      else fail(`${KIND_LABEL[kind]} destination must be an absolute path`);
    }
    if (Object.keys(targets).length) settings.targets = targets;
  }

  if (input.move !== undefined) {
    if (typeof input.move === 'boolean') settings.move = input.move;
    else fail('"move" must be true or false');
  }

  if (input.language !== undefined) {
    try {
      const language = normalizeLanguage(input.language);
      if (language) settings.language = language;
    } catch (error) {
      fail(error.message);
    }
  }

  if (input.region !== undefined) {
    try {
      settings.region = normalizeRegion(input.region);
    } catch (error) {
      fail(error.message);
    }
  }

  if (input.filters !== undefined) {
    const filters = {};
    for (const key of ['videoOnly', 'excludeSamples']) {
      const value = input.filters?.[key];
      if (value === undefined) continue;
      if (typeof value === 'boolean') filters[key] = value;
      else fail(`"filters.${key}" must be true or false`);
    }
    if (Object.keys(filters).length) settings.filters = filters;
  }

  if (input.automation !== undefined) {
    const source = input.automation;
    const automation = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      fail('"automation" must be an object');
    } else {
      for (const key of ['enabled', 'includeWarnings', 'cleanupEmptyFolders']) {
        if (source[key] === undefined) continue;
        if (typeof source[key] === 'boolean') automation[key] = source[key];
        else fail(`"automation.${key}" must be true or false`);
      }
      if (source.audioFix !== undefined) {
        const audio = source.audioFix ?? {};
        const audioFix = {};
        for (const key of ['enabled', 'episodes']) {
          if (audio[key] === undefined) continue;
          if (typeof audio[key] === 'boolean') audioFix[key] = audio[key];
          else fail(`"automation.audioFix.${key}" must be true or false`);
        }
        if (audio.languages !== undefined) {
          const languages = Array.isArray(audio.languages) ? audio.languages.map((code) => String(code).trim().toLowerCase()).filter(Boolean) : csv(audio.languages);
          if (languages.length && languages.every((code) => AUDIO_LANGUAGE.test(code))) audioFix.languages = languages;
          else fail('Audio fix languages must be 2- or 3-letter codes, e.g. de, en');
        }
        if (audio.bitrate !== undefined) {
          const bitrate = validAudioBitrate(audio.bitrate);
          if (bitrate) audioFix.bitrate = bitrate;
          else fail('Audio fix bitrate must be between 192k and 1536k');
        }
        if (Object.keys(audioFix).length) automation.audioFix = audioFix;
      }
    }
    if (Object.keys(automation).length) settings.automation = automation;
  }

  return { settings, problems };
}

/** Saved values override the environment defaults, field by field. */
export function mergeSettings(base, saved = {}) {
  return {
    patterns: { ...base.patterns, ...saved.patterns },
    targets: { ...base.targets, ...saved.targets },
    move: saved.move ?? base.move,
    language: saved.language ?? base.language,
    region: saved.region !== undefined ? saved.region : base.region,
    filters: { ...base.filters, ...saved.filters },
    automation: {
      ...base.automation,
      ...saved.automation,
      audioFix: { ...base.automation.audioFix, ...saved.automation?.audioFix },
    },
  };
}

/** Destinations that apply: none when moving is switched off. */
export const activeTargets = (settings) => (settings.move ? { ...settings.targets } : { episode: null, movie: null });

/** Read saved settings; a missing file is fine, a broken one is reported and ignored. */
export async function readSavedSettings(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, settings: {}, savedAt: null, problems: [] };
    return { exists: false, settings: {}, savedAt: null, problems: [`Cannot read ${file}: ${error.message}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { exists: true, settings: {}, savedAt: null, problems: [`${file} is not valid JSON; using defaults`] };
  }
  const { settings, problems } = sanitizeSettings(parsed);
  return { exists: true, settings, savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : null, problems };
}

function notWritable(file, error) {
  return Object.assign(
    new InputError(
      `Cannot save settings to ${file} (${error.code ?? error.message}). ` +
        'Make the folder writable, or in Docker mount a writable folder at /config.',
    ),
    { status: 500 },
  );
}

/** Replace the saved settings (validated strictly) with an atomic write. */
export async function writeSavedSettings(file, input) {
  const { settings } = sanitizeSettings(input, { strict: true });
  const document = { version: 1, savedAt: new Date().toISOString(), ...settings };
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flush: true });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw notWritable(file, error);
  }
  return { settings, savedAt: document.savedAt };
}

export async function deleteSavedSettings(file) {
  try {
    await fs.rm(file, { force: true });
  } catch (error) {
    throw notWritable(file, error);
  }
}

/** Environment defaults merged with the saved file. */
export async function loadSettings(env = process.env, file = settingsFilePath(env)) {
  const defaults = envSettings(env);
  const saved = await readSavedSettings(file);
  return { file, defaults, saved, effective: mergeSettings(defaults, saved.settings) };
}
