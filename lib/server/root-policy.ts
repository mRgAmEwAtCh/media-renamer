import fs from 'node:fs/promises';
import path from 'node:path';
import { InputError } from '../errors.ts';
import { isWithin } from '../paths.ts';

export const forbidden = (message) => new InputError(message, { status: 403 });

/** Enforces MEDIA_RENAMER_ROOTS on real (symlink-resolved) paths. */
export function createRootPolicy(roots) {
  const realRoots = async () => (await Promise.all(roots.map((root) => fs.realpath(root).catch(() => null)))).filter(Boolean);

  return {
    restricted: roots.length > 0,
    realRoots,
    /** Resolve a folder and return it with the allowed root that contains it. */
    async check(input) {
      if (typeof input !== 'string' || !input.trim()) throw new InputError('A folder path is required');
      const real = await fs.realpath(path.resolve(input.trim())).catch(() => null);
      if (!real) throw new InputError(`Folder not found: ${input}`);
      if (!roots.length) return { real, root: null };
      const root = (await realRoots()).find((candidate) => isWithin(candidate, real));
      if (!root) throw forbidden(`Outside the allowed folders (${roots.join(', ')}): ${input}`);
      return { real, root };
    },
  };
}
