import path from 'node:path';
import { KINDS } from '../defaults.js';
import { InputError } from '../errors.js';
import { validatePattern } from '../format.js';
import { normalizeLanguage, normalizeRegion } from '../metadata.js';
import { AUDIO_LANGUAGE, csv, KIND_LABEL, validAudioBitrate } from './values.js';

// Each section sanitizer gets the raw value and `fail(message)`, and returns the
// valid part, or undefined when nothing valid is left.

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (object) => (Object.keys(object).length ? object : undefined);

/** The listed boolean fields of `source`; `prefix` names them in error messages. */
function booleans(source, keys, prefix, fail) {
  const result = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') result[key] = value;
    else fail(`"${prefix}.${key}" must be true or false`);
  }
  return result;
}

function patterns(input, fail) {
  const result = {};
  for (const kind of KINDS) {
    const value = input?.[kind];
    if (value === undefined) continue;
    try {
      validatePattern(value);
      result[kind] = value;
    } catch (error) {
      fail(`${KIND_LABEL[kind]} pattern: ${error.message}`);
    }
  }
  return nonEmpty(result);
}

function targets(input, fail) {
  const result = {};
  for (const kind of KINDS) {
    if (!input || !Object.hasOwn(input, kind)) continue;
    const value = input[kind];
    if (value === null || (typeof value === 'string' && !value.trim())) result[kind] = null;
    else if (typeof value === 'string' && path.isAbsolute(value.trim())) result[kind] = path.resolve(value.trim());
    else fail(`${KIND_LABEL[kind]} destination must be an absolute path`);
  }
  return nonEmpty(result);
}

function move(input, fail) {
  if (typeof input === 'boolean') return input;
  fail('"move" must be true or false');
  return undefined;
}

function language(input, fail) {
  try {
    return normalizeLanguage(input) ?? undefined;
  } catch (error) {
    fail(error.message);
    return undefined;
  }
}

function region(input, fail) {
  try {
    return normalizeRegion(input);
  } catch (error) {
    fail(error.message);
    return undefined;
  }
}

const filters = (input, fail) => nonEmpty(booleans(input, ['videoOnly', 'excludeSamples'], 'filters', fail));

function audioFix(input, fail) {
  const source = input ?? {};
  const result = booleans(source, ['enabled', 'episodes'], 'automation.audioFix', fail);
  if (source.languages !== undefined) {
    const languages = Array.isArray(source.languages)
      ? source.languages.map((code) => String(code).trim().toLowerCase()).filter(Boolean)
      : csv(source.languages);
    if (languages.length && languages.every((code) => AUDIO_LANGUAGE.test(code))) result.languages = languages;
    else fail('Audio fix languages must be 2- or 3-letter codes, e.g. de, en');
  }
  if (source.bitrate !== undefined) {
    const bitrate = validAudioBitrate(source.bitrate);
    if (bitrate) result.bitrate = bitrate;
    else fail('Audio fix bitrate must be between 192k and 1536k');
  }
  return nonEmpty(result);
}

function automation(input, fail) {
  if (!isPlainObject(input)) {
    fail('"automation" must be an object');
    return undefined;
  }
  const result = booleans(input, ['enabled', 'includeWarnings', 'cleanupEmptyFolders'], 'automation', fail);
  if (input.audioFix !== undefined) {
    const audio = audioFix(input.audioFix, fail);
    if (audio) result.audioFix = audio;
  }
  return nonEmpty(result);
}

const SECTIONS = { patterns, targets, move, language, region, filters, automation };

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
  if (!isPlainObject(input)) {
    fail('Settings must be an object');
    return { settings, problems };
  }
  for (const [key, sanitize] of Object.entries(SECTIONS)) {
    if (input[key] === undefined) continue;
    const value = sanitize(input[key], fail);
    if (value !== undefined) settings[key] = value;
  }
  return { settings, problems };
}
