import path from 'node:path';
import { KINDS } from '../defaults.ts';
import { InputError } from '../errors.ts';
import { validatePattern } from '../format.ts';
import { normalizeLanguage, normalizeRegion } from '../metadata.ts';
import type { AudioFixSettings, Patterns, SavedSettings, Targets } from '../types.ts';
import { AUDIO_LANGUAGE, csv, KIND_LABEL, validAudioBitrate } from './values.ts';

// Each section sanitizer gets the raw value and `fail(message)`, and returns the
// valid part, or undefined when nothing valid is left.

type Fail = (message: string) => void;
type Fields = Record<string, unknown>;
type SavedAutomation = NonNullable<SavedSettings['automation']>;

const isPlainObject = (value: unknown): value is Fields => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = <T extends object>(object: T): T | undefined => (Object.keys(object).length ? object : undefined);
/** Property access on an unchecked value, as `value?.[key]`. */
const field = (value: unknown, key: string): unknown => (value as Fields | null | undefined)?.[key];

/** The listed boolean fields of `source`; `prefix` names them in error messages. */
function booleans<K extends string>(source: unknown, keys: readonly K[], prefix: string, fail: Fail): Partial<Record<K, boolean>> {
  const result: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    const value = field(source, key);
    if (value === undefined) continue;
    if (typeof value === 'boolean') result[key] = value;
    else fail(`"${prefix}.${key}" must be true or false`);
  }
  return result;
}

function patterns(input: unknown, fail: Fail): Partial<Patterns> | undefined {
  const result: Partial<Patterns> = {};
  for (const kind of KINDS) {
    const value = field(input, kind);
    if (value === undefined) continue;
    try {
      validatePattern(value);
      result[kind] = value;
    } catch (error) {
      fail(`${KIND_LABEL[kind]} pattern: ${(error as Error).message}`);
    }
  }
  return nonEmpty(result);
}

function targets(input: unknown, fail: Fail): Partial<Targets> | undefined {
  const result: Partial<Targets> = {};
  for (const kind of KINDS) {
    if (!input || !Object.hasOwn(input, kind)) continue;
    const value = field(input, kind);
    if (value === null || (typeof value === 'string' && !value.trim())) result[kind] = null;
    else if (typeof value === 'string' && path.isAbsolute(value.trim())) result[kind] = path.resolve(value.trim());
    else fail(`${KIND_LABEL[kind]} destination must be an absolute path`);
  }
  return nonEmpty(result);
}

function move(input: unknown, fail: Fail): boolean | undefined {
  if (typeof input === 'boolean') return input;
  fail('"move" must be true or false');
  return undefined;
}

function language(input: unknown, fail: Fail): string | undefined {
  try {
    return normalizeLanguage(input) ?? undefined;
  } catch (error) {
    fail((error as Error).message);
    return undefined;
  }
}

function region(input: unknown, fail: Fail): string | null | undefined {
  try {
    return normalizeRegion(input);
  } catch (error) {
    fail((error as Error).message);
    return undefined;
  }
}

const filters = (input: unknown, fail: Fail): SavedSettings['filters'] => nonEmpty(booleans(input, ['videoOnly', 'excludeSamples'], 'filters', fail));

function audioFix(input: unknown, fail: Fail): Partial<AudioFixSettings> | undefined {
  const source = (input ?? {}) as Fields;
  const result: Partial<AudioFixSettings> = booleans(source, ['enabled', 'episodes'], 'automation.audioFix', fail);
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

function automation(input: unknown, fail: Fail): SavedAutomation | undefined {
  if (!isPlainObject(input)) {
    fail('"automation" must be an object');
    return undefined;
  }
  const result: SavedAutomation = booleans(input, ['enabled', 'includeWarnings', 'cleanupEmptyFolders'], 'automation', fail);
  if (input.audioFix !== undefined) {
    const audio = audioFix(input.audioFix, fail);
    if (audio) result.audioFix = audio;
  }
  return nonEmpty(result);
}

type Sanitizer = (input: unknown, fail: Fail) => unknown;

const SECTIONS: Record<keyof SavedSettings, Sanitizer> = { patterns, targets, move, language, region, filters, automation };

/**
 * Validate a (partial) settings object. Strict mode throws on the first problem
 * (used when saving); lenient mode drops invalid fields and reports them
 * (used when reading a file that may have been edited by hand).
 */
export function sanitizeSettings(input: unknown, { strict = false }: { strict?: boolean } = {}): { settings: SavedSettings; problems: string[] } {
  const settings: SavedSettings = {};
  const problems: string[] = [];
  const fail = (message: string) => {
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
    if (value !== undefined) (settings as Fields)[key] = value;
  }
  return { settings, problems };
}
