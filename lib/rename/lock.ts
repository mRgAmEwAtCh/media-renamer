import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { InputError } from '../errors.ts';

const LOCK_FILE = '.media-renamer.lock';
const LOCK_HEARTBEAT_MS = 30 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
// Identifies this process instance; a restarted container may reuse the same hostname and PID.
const INSTANCE_ID = randomUUID();

/** The lock file's contents; all fields may be missing when it is unreadable. */
interface LockHolder {
  owner?: string;
  host?: string;
  pid?: number;
  instance?: string;
  startedAt?: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock is abandoned when its owner on this host is gone, or when it stopped heartbeating. */
function lockIsAbandoned(holder: LockHolder, stat: Stats | null): boolean {
  if (holder.host === os.hostname() && Number.isInteger(holder.pid)) {
    if (holder.pid === process.pid) return holder.instance !== INSTANCE_ID;
    return !processIsAlive(holder.pid as number);
  }
  return !stat || Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
}

async function readHolder(file: string): Promise<LockHolder> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {}; // Unreadable lock: judged by age only.
  }
}

/** Keep the lock's mtime fresh; returns the function that releases the lock. */
function holdLock(file: string): () => Promise<void> {
  const timer = setInterval(() => {
    const now = new Date();
    fs.utimes(file, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await fs.rm(file, { force: true }).catch(() => {});
  };
}

/**
 * Exclusive lock for one folder, so two jobs (web UI and CLI, or two browser
 * tabs) never move the same files. The owner refreshes the lock's mtime; a lock
 * left behind by a crash or container restart goes stale and is taken over.
 * Resolves to a `release()` function.
 */
export async function acquireLock(root: string, owner: string): Promise<() => Promise<void>> {
  const file = path.join(root, LOCK_FILE);
  const body = JSON.stringify({ owner, host: os.hostname(), pid: process.pid, instance: INSTANCE_ID, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(file, body, { flag: 'wx' });
      return holdLock(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(file).catch(() => null);
      const holder = await readHolder(file);
      if (!lockIsAbandoned(holder, stat)) {
        throw new InputError(`Another rename job is already running in this folder${holder.owner ? ` (${holder.owner})` : ''}`, { status: 409 });
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new InputError('Could not lock the folder');
}
