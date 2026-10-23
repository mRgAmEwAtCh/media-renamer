import path from 'node:path';
import { InputError } from '../errors.ts';
import { exists } from '../fs-utils.ts';
import { SUBTITLE_EXTENSIONS } from '../parse.ts';
import { resolveInside, toRootRelative } from '../paths.ts';

const MAX_TRIES = 999;

/** "Movie (1999).de.srt" → ["Movie (1999)", ".de.srt"]: the number goes before a subtitle's language. */
function splitName(fileName: string): [string, string] {
  const extension = path.extname(fileName);
  let stem = fileName.slice(0, fileName.length - extension.length);
  let suffix = extension;
  const language = SUBTITLE_EXTENSIONS.has(extension.toLowerCase()) ? stem.match(/\.[a-z]{2,3}$/i) : null;
  if (language) {
    stem = stem.slice(0, -language[0].length);
    suffix = `${language[0]}${extension}`;
  }
  return [stem, suffix];
}

/**
 * The first of "Name (2).ext", "Name (3).ext", … that neither exists in
 * `destination` nor is in `taken` (other names planned for the same folder),
 * so a new file can be kept next to one that already has its name.
 */
export async function freeName(destination: string, rel: string, taken: Iterable<string> = []): Promise<string> {
  const wanted = toRootRelative(destination, rel);
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const directory = path.posix.dirname(wanted);
  const [stem, suffix] = splitName(path.posix.basename(wanted));
  for (let number = 2; number <= MAX_TRIES; number += 1) {
    const fileName = `${stem} (${number})${suffix}`;
    const candidate = directory === '.' ? fileName : `${directory}/${fileName}`;
    if (used.has(candidate.toLowerCase())) continue;
    if (!(await exists(resolveInside(destination, candidate)))) return candidate;
  }
  throw new InputError(`No free name found for ${wanted}`);
}
