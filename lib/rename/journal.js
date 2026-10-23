import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../fs-utils.js';
import { sweepPartials } from '../mover.js';
import { resolveInside } from '../paths.js';

/**
 * The undo journal: a JSON array of batches stored in the renamed folder.
 * A batch is { id, at, status, renames: [{ from, to, target?, state, partial?, converted? }] }
 * with status running | complete | partial | cancelled | interrupted and entry
 * state pending | done | undone.
 */
export const UNDO_LOG = '.media-renamer-undo.json';
const MAX_LOG_BATCHES = 50;

export async function readUndoLog(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, UNDO_LOG), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Undo log is unreadable: ${error.message}`);
  }
}

export async function writeUndoLog(root, batches) {
  await writeFileAtomic(path.join(root, UNDO_LOG), `${JSON.stringify(batches.slice(-MAX_LOG_BATCHES), null, 2)}\n`, { flush: true });
}

/** Destination root of one journal entry (entries record their own; older batches one per batch). */
export const entryDestination = (root, batch, entry) => entry.target ?? batch.target ?? root;

/** The single destination shared by all moves, or null when renamed in place or spread over several. */
export function sharedTarget(root, destinations) {
  const distinct = [...new Set(destinations)];
  return distinct.length === 1 && distinct[0] !== root ? distinct[0] : null;
}

/** Mark batches left "running" by a crash as interrupted and remove their partial copies. */
export async function recoverInterrupted(root, log) {
  const stale = log.filter((batch) => batch.status === 'running');
  if (!stale.length) return false;
  const directories = [];
  for (const batch of stale) {
    batch.status = 'interrupted';
    for (const entry of batch.renames) {
      if (entry.state !== 'pending') continue;
      const target = resolveInside(entryDestination(root, batch, entry), entry.to);
      directories.push(path.dirname(target));
      // The journal names the exact partial file, so it can go immediately.
      if (entry.partial) await fs.rm(path.join(path.dirname(target), path.basename(entry.partial)), { force: true }).catch(() => {});
    }
  }
  await sweepPartials(directories);
  return true;
}
