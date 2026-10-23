import fs from 'node:fs/promises';
import path from 'node:path';
import { InputError } from '../errors.ts';
import { exists } from '../fs-utils.ts';
import { isCancellation, moveFile } from '../mover.ts';
import { resolveInside } from '../paths.ts';
import type { DoneRename, FailedRename, JournalBatch, JournalEntry, ProgressListener, UndoResult } from '../types.ts';
import { entryDestination, readUndoLog, recoverInterrupted, sharedTarget, writeUndoLog } from './journal.ts';
import { acquireLock } from './lock.ts';
import { createProgress, stopRequested } from './progress.ts';

export interface UndoOptions {
  /** Rejects (throws) for a recorded destination the caller may not touch. */
  checkTarget?: (target: string) => unknown;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
  onProgress?: ProgressListener;
  /** Shown to other jobs that find the folder locked. */
  owner?: string;
}

/** One file to move back, with absolute paths. */
interface UndoMove {
  entry: JournalEntry;
  from: string;
  to: string;
  target: string | null;
  fromAbsolute: string;
  toAbsolute: string;
  size: number;
}

async function fileSize(file: string): Promise<number> {
  return (await fs.stat(file).catch(() => null))?.size ?? 0;
}

/** Destination folders (other than root) of a batch's remaining entries. */
const pendingDestinations = (root: string, batch: JournalBatch): string[] =>
  [...new Set(batch.renames.filter((entry) => entry.state !== 'undone').map((entry) => entryDestination(root, batch, entry)))].filter((d) => d !== root);

/** The moves that reverse a batch's remaining entries, newest first. */
async function planUndo(root: string, batch: JournalBatch): Promise<UndoMove[]> {
  const moves: UndoMove[] = [];
  for (const entry of batch.renames.filter((e) => e.state !== 'undone').reverse()) {
    const destination = entryDestination(root, batch, entry);
    const renamed = resolveInside(destination, entry.to);
    moves.push({
      entry,
      from: entry.to,
      to: entry.from,
      target: destination === root ? null : destination,
      fromAbsolute: renamed,
      toAbsolute: resolveInside(root, entry.from),
      size: await fileSize(renamed),
    });
  }
  return moves;
}

/**
 * Move one file back. Resolves 'restored', or 'dropped' for a pending entry
 * whose move never happened; throws with the reason the file was skipped.
 */
async function restore(move: UndoMove, { signal, onBytes }: { signal?: AbortSignal; onBytes: (bytes: number) => void }): Promise<'restored' | 'dropped'> {
  const caseOnly = !move.target && move.from.toLowerCase() === move.to.toLowerCase();
  if (!(await exists(move.fromAbsolute))) {
    if (move.entry.state === 'pending' && (await exists(move.toAbsolute))) return 'dropped';
    throw new Error('renamed file no longer exists');
  }
  if (!caseOnly && (await exists(move.toAbsolute))) throw new Error('original name is taken');
  await fs.mkdir(path.dirname(move.toAbsolute), { recursive: true });
  await moveFile(move.fromAbsolute, move.toAbsolute, { signal, onProgress: onBytes });
  return 'restored';
}

/**
 * Reverse the most recent batch recorded in the folder's undo log, including
 * batches that were cancelled or interrupted. checkTarget may reject a recorded
 * destination (e.g. outside allowed folders). Cancelling keeps the remaining
 * entries so a later undo continues where this one stopped.
 */
export async function undoLast(
  root: string,
  { checkTarget, signal, stopSignal, onProgress, owner = 'media-renamer' }: UndoOptions = {},
): Promise<UndoResult> {
  const release = await acquireLock(root, owner);
  try {
    const log = await readUndoLog(root);
    if (await recoverInterrupted(root, log)) await writeUndoLog(root, log);
    const batch = log.at(-1);
    if (!batch) throw new InputError('Nothing to undo in this folder');
    // Check recorded destinations against the allowed folders before touching any of them.
    const destinations = pendingDestinations(root, batch);
    if (checkTarget) for (const destination of destinations) await checkTarget(destination);
    const moves = await planUndo(root, batch);

    const progress = createProgress(moves, onProgress);
    const restored: DoneRename[] = [];
    const skipped: FailedRename[] = [];
    let cancelled = false;
    for (const move of moves) {
      if (stopRequested({ signal, stopSignal })) {
        cancelled = true;
        break;
      }
      progress.start(move);
      try {
        const outcome = await restore(move, { signal, onBytes: (bytes) => progress.bytes(bytes) });
        if (outcome === 'restored') restored.push({ from: move.from, to: move.to, target: move.target });
      } catch (error) {
        if (isCancellation(error)) {
          cancelled = true;
          break;
        }
        skipped.push({ from: move.from, to: move.to, target: move.target, reason: (error as Error).message });
      }
      move.entry.state = 'undone';
      await writeUndoLog(root, log);
      progress.finish(move);
    }

    const remaining = batch.renames.filter((entry) => entry.state !== 'undone').length;
    if (!remaining) log.pop();
    await writeUndoLog(root, log);
    return {
      restored: restored.length,
      skipped,
      cancelled,
      remaining,
      renames: restored,
      batchAt: batch.at,
      target: batch.target ?? sharedTarget(root, moves.map((move) => move.target ?? root)),
      targets: destinations,
    };
  } finally {
    await release();
  }
}
