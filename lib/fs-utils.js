import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** True when something (file, folder or dangling symlink) exists at `target`. */
export async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Write through a temporary file and rename it into place, so readers never
 * see a half-written file. `mkdir` creates the parent folder first; other
 * options (e.g. `flush`, `mode`) go to fs.writeFile.
 */
export async function writeFileAtomic(file, data, { mkdir = false, ...options } = {}) {
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
