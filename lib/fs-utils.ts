import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Mode, ObjectEncodingOptions } from 'node:fs';

/** Options for writeFileAtomic; everything but `mkdir` goes to fs.writeFile. */
export interface WriteFileAtomicOptions extends ObjectEncodingOptions {
  mkdir?: boolean;
  mode?: Mode;
  flush?: boolean;
}

/** What is at `target` (without following symlinks), or null when nothing is there. */
export async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** True when something (file, folder or dangling symlink) exists at `target`. */
export async function exists(target: string): Promise<boolean> {
  return (await lstatIfExists(target)) !== null;
}

/**
 * Write through a temporary file and rename it into place, so readers never
 * see a half-written file. `mkdir` creates the parent folder first; other
 * options (e.g. `flush`, `mode`) go to fs.writeFile.
 */
export async function writeFileAtomic(file: string, data: string | NodeJS.ArrayBufferView, { mkdir = false, ...options }: WriteFileAtomicOptions = {}): Promise<void> {
  if (mkdir) await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, options);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
