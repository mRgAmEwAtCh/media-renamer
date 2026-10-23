import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** In-progress copies use this hidden prefix; scans ignore dot files and stale ones are swept. */
export const PARTIAL_PREFIX = '.media-renamer-partial-';
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const STALE_PARTIAL_MS = 5 * 60 * 1000;

export class CancelledError extends Error {
  code: string;

  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'ECANCELLED';
  }
}

export const isCancellation = (error: unknown): boolean =>
  (error as { code?: unknown } | null | undefined)?.code === 'ECANCELLED' || (error as { name?: unknown } | null | undefined)?.name === 'AbortError';

/** Hidden temporary path next to `to`, used while copying across filesystems. */
export function partialPathFor(to: string) {
  return path.join(path.dirname(to), `${PARTIAL_PREFIX}${randomUUID()}${path.extname(to)}`);
}

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new CancelledError();
}

/** Called with bytes copied so far and the total size. */
export type ByteProgress = (done: number, total: number) => void;

async function copyWithProgress(
  from: string,
  to: string,
  { size, signal, onProgress }: { size: number; signal?: AbortSignal; onProgress?: ByteProgress },
) {
  let done = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        onProgress(done, size);
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(from, { highWaterMark: COPY_CHUNK_BYTES }),
    counter,
    // flush: fsync before close, so a power cut cannot leave a "complete" but empty file.
    createWriteStream(to, { flags: 'wx', highWaterMark: COPY_CHUNK_BYTES, flush: true }),
    { signal },
  );
  onProgress?.(done, size);
}

/** Give `temp` its final name without ever replacing an existing file. */
export async function commitNoOverwrite(temp: string, to: string) {
  try {
    await fs.link(temp, to); // fails with EEXIST instead of overwriting
    await fs.unlink(temp);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    // Filesystems without hard links (some FUSE/SMB mounts): check, then rename.
  }
  if (await fs.lstat(to).then(() => true, () => false)) {
    throw Object.assign(new Error(`Target already exists: ${to}`), { code: 'EEXIST' });
  }
  await fs.rename(temp, to);
}

export interface MoveOptions {
  rename?: (from: string, to: string) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: ByteProgress;
  partialPath?: string;
}

/**
 * Move one file. A same-filesystem rename is instant. Across disks or mounts
 * (EXDEV) the file is copied to a hidden temporary name next to the target,
 * synced, size-checked, committed without overwriting, and only then is the
 * original deleted. Cancelling (signal) or any failure removes the partial copy
 * and leaves the original untouched.
 */
export async function moveFile(
  from: string,
  to: string,
  { rename = fs.rename, signal, onProgress, partialPath }: MoveOptions = {},
): Promise<'renamed' | 'copied'> {
  throwIfCancelled(signal);
  const source = await fs.stat(from);
  try {
    await rename(from, to);
    onProgress?.(source.size, source.size);
    return 'renamed';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }

  const temp = partialPath ?? partialPathFor(to);
  try {
    await copyWithProgress(from, temp, { size: source.size, signal, onProgress });
    const copied = await fs.stat(temp);
    if (copied.size !== source.size) throw new Error(`Incomplete copy of ${path.basename(from)}`);
    await fs.chmod(temp, source.mode & 0o7777).catch(() => {});
    await fs.utimes(temp, source.atime, source.mtime).catch(() => {});
    throwIfCancelled(signal); // last point to cancel before the copy becomes visible
    await commitNoOverwrite(temp, to);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if (isCancellation(error) || signal?.aborted) throw new CancelledError();
    throw error;
  }
  await fs.unlink(from);
  return 'copied';
}

/**
 * Remove partial copies left behind by a crash or `docker stop`. Only files older
 * than five minutes are removed; an active copy keeps updating its mtime.
 */
export async function sweepPartials(directories: Iterable<string>, { now = Date.now() }: { now?: number } = {}) {
  let removed = 0;
  for (const directory of new Set(directories)) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(PARTIAL_PREFIX)) continue;
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > STALE_PARTIAL_MS) {
        await fs.rm(file, { force: true }).catch(() => {});
        removed += 1;
      }
    }
  }
  return removed;
}
