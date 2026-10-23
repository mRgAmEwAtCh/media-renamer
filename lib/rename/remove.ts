import fs from 'node:fs/promises';
import { InputError } from '../errors.ts';
import { lstatIfExists } from '../fs-utils.ts';
import { resolveInside, toRootRelative } from '../paths.ts';
import type { FailedRename } from '../types.ts';

export interface PlannedRemoval {
  rel: string;
  absolute: string;
}

/**
 * Validate files to delete (e.g. an extracted copy of something already in the
 * library): each must be a regular file inside `root`, and neither the source
 * nor the new name of a rename in the same batch (`inUse`, absolute paths).
 */
export async function planRemovals(root: string, files: readonly unknown[], inUse: Iterable<string>): Promise<PlannedRemoval[]> {
  // Lower case, so a case-insensitive disk cannot sneak the same file past the check.
  const listed = new Set([...inUse].map((file) => file.toLowerCase()));
  const planned: PlannedRemoval[] = [];
  for (const input of files) {
    const rel = toRootRelative(root, String(input ?? ''));
    const absolute = resolveInside(root, rel);
    if (listed.has(absolute.toLowerCase())) throw new InputError(`File listed twice: ${rel}`);
    listed.add(absolute.toLowerCase());
    if (!(await lstatIfExists(absolute))?.isFile()) throw new InputError(`Not a regular file: ${rel}`);
    planned.push({ rel, absolute });
  }
  return planned;
}

/** Delete the planned files; returns what was deleted and adds failures to `failed`. Not undoable. */
export async function removeFiles(planned: readonly PlannedRemoval[], failed: FailedRename[]): Promise<string[]> {
  const removed: string[] = [];
  for (const { rel, absolute } of planned) {
    try {
      await fs.unlink(absolute);
      removed.push(rel);
    } catch (error) {
      failed.push({ from: rel, to: '', target: null, reason: `not deleted: ${(error as Error).message}` });
    }
  }
  return removed;
}
