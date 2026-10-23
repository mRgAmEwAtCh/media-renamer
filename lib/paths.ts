import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './errors.ts';

export const toPosix = (value) => value.split(path.sep).join('/');

/** True when `target` is `root` itself or inside it. */
export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve an existing folder to its real (symlink-free) absolute path. */
export async function resolveRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw new InputError('A folder path is required');
  let root;
  try {
    root = await fs.realpath(path.resolve(input.trim()));
  } catch {
    throw new InputError(`Folder not found: ${input}`);
  }
  if (!(await fs.stat(root)).isDirectory()) throw new InputError(`Not a folder: ${input}`);
  return root;
}

/** Resolve an optional destination folder; null means "rename in place". */
export async function resolveTarget(root, input) {
  if (input === undefined || input === null || (typeof input === 'string' && !input.trim())) return null;
  const target = await resolveRoot(input);
  return target === root ? null : target;
}

/** Resolve a root-relative path and refuse anything that escapes the root. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new InputError('Empty file path');
  const absolute = path.resolve(root, rel);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InputError(`Path is outside the selected folder: ${rel}`);
  }
  return absolute;
}

/** Convert a caller path (absolute, or relative to root) into a normalized root-relative path. */
export function toRootRelative(root, input) {
  let absolute = path.resolve(root, input);
  if (path.isAbsolute(input) && path.relative(root, absolute).startsWith('..')) {
    try {
      absolute = path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      // Leave the path unchanged; resolveInside reports it as outside the root.
    }
  }
  return toPosix(path.relative(root, resolveInside(root, path.relative(root, absolute))));
}
