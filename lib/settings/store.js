import fs from 'node:fs/promises';
import { InputError } from '../errors.js';
import { writeFileAtomic } from '../fs-utils.js';
import { envSettings, settingsFilePath } from './env.js';
import { sanitizeSettings } from './validate.js';

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
  return new InputError(
    `Cannot save settings to ${file} (${error.code ?? error.message}). ` +
      'Make the folder writable, or in Docker mount a writable folder at /config.',
    { status: 500 },
  );
}

/** Replace the saved settings (validated strictly) with an atomic write. */
export async function writeSavedSettings(file, input) {
  const { settings } = sanitizeSettings(input, { strict: true });
  const document = { version: 1, savedAt: new Date().toISOString(), ...settings };
  try {
    await writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`, { mkdir: true, flush: true });
  } catch (error) {
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
