import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { convertAndMove } from '../audio.ts';
import { InputError } from '../errors.ts';
import { exists } from '../fs-utils.ts';
import { isCancellation, moveFile, partialPathFor } from '../mover.ts';
import { resolveInside, toRootRelative } from '../paths.ts';
import type {
  ApplyResult,
  AudioPlan,
  AudioTools,
  DoneRename,
  FailedRename,
  JournalBatch,
  JournalEntry,
  ProgressListener,
  RenameRequest,
} from '../types.ts';
import { readUndoLog, recoverInterrupted, sharedTarget, writeUndoLog } from './journal.ts';
import { acquireLock } from './lock.ts';
import { createProgress, stopRequested } from './progress.ts';

/** How audio conversions run: the ffmpeg/ffprobe binaries and the target bitrate. */
export interface ApplyAudioOptions {
  tools?: Partial<AudioTools>;
  bitrate?: string;
}

export interface ApplyOptions {
  /** Destination for renames that do not name their own `target`. */
  target?: string | null;
  audio?: ApplyAudioOptions;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
  onProgress?: ProgressListener;
  /** Shown to other jobs that find the folder locked. */
  owner?: string;
}

/** A validated rename with absolute paths. */
interface PlannedRename {
  from: string;
  to: string;
  target: string | null;
  fromAbsolute: string;
  toAbsolute: string;
  caseOnly: boolean;
  size: number;
  audio: AudioPlan | null;
}

/** The absolute destination folder of one rename: its own `target`, else `fallback`, else root. */
function destinationOf(root: string, rename: RenameRequest, fallback: string | null | undefined): string {
  const requested = rename && Object.hasOwn(rename, 'target') ? rename.target : fallback;
  if (requested !== null && requested !== undefined && (typeof requested !== 'string' || !path.isAbsolute(requested))) {
    throw new InputError(`Destination must be an absolute folder: ${requested}`);
  }
  return requested ? path.resolve(requested) : root;
}

/** Validate every rename up front; nothing moves unless the whole list is sound. */
async function planRenames(root: string, renames: readonly RenameRequest[], fallbackTarget: string | null): Promise<PlannedRename[]> {
  const planned: PlannedRename[] = [];
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const rename of renames) {
    const destination = destinationOf(root, rename, fallbackTarget);
    const sameRoot = destination === root;
    const from = toRootRelative(root, String(rename?.from ?? ''));
    const to = toRootRelative(destination, String(rename?.to ?? ''));
    if (sameRoot && from === to) continue;
    if (path.posix.basename(to).startsWith('.')) throw new InputError(`Refusing to create a hidden file: ${to}`);
    if (sources.has(from)) throw new InputError(`File listed twice: ${from}`);
    const key = `${destination}\0${to.toLowerCase()}`;
    if (targets.has(key)) throw new InputError(`Two files map to: ${to}`);
    sources.add(from);
    targets.add(key);

    const fromAbsolute = resolveInside(root, from);
    const toAbsolute = resolveInside(destination, to);
    const caseOnly = sameRoot && from.toLowerCase() === to.toLowerCase();
    const stat = await fs.lstat(fromAbsolute).catch(() => null);
    if (!stat?.isFile()) throw new InputError(`Source is not a regular file: ${from}`);
    if (!caseOnly && (await exists(toAbsolute))) throw new InputError(`Target already exists: ${to}`);
    planned.push({
      from,
      to,
      target: sameRoot ? null : destination,
      fromAbsolute,
      toAbsolute,
      caseOnly,
      size: stat.size,
      audio: rename.audio?.conversions?.length ? rename.audio : null,
    });
  }
  return planned;
}

/** Move (or convert and move) one planned file; marks `entry.converted` for audio conversions. */
async function transfer(
  item: PlannedRename,
  entry: JournalEntry,
  { audio, signal, partialPath, onBytes }: { audio: ApplyAudioOptions; signal?: AbortSignal; partialPath: string; onBytes: (bytes: number) => void },
): Promise<void> {
  await fs.mkdir(path.dirname(item.toAbsolute), { recursive: true });
  if (!item.caseOnly && (await exists(item.toAbsolute))) throw new Error('Target appeared after the preview');
  if (item.audio) {
    await convertAndMove(item.fromAbsolute, item.toAbsolute, { plan: item.audio, partialPath, tools: audio.tools, bitrate: audio.bitrate, signal, onProgress: onBytes });
    entry.converted = true;
  } else {
    await moveFile(item.fromAbsolute, item.toAbsolute, { signal, partialPath, onProgress: onBytes });
  }
}

/** Run the planned moves as one journalled batch; the caller holds the folder lock. */
async function runBatch(
  root: string,
  planned: PlannedRename[],
  { audio, signal, stopSignal, onProgress }: { audio: ApplyAudioOptions; signal?: AbortSignal; stopSignal?: AbortSignal; onProgress?: ProgressListener },
): Promise<{ done: DoneRename[]; failed: FailedRename[]; cancelled: boolean }> {
  const log = await readUndoLog(root);
  await recoverInterrupted(root, log);
  const batch: JournalBatch = { id: randomUUID(), at: new Date().toISOString(), status: 'running', renames: [] };
  log.push(batch);
  await writeUndoLog(root, log);

  const progress = createProgress(planned, onProgress);
  const done: DoneRename[] = [];
  const failed: FailedRename[] = [];
  let cancelled = false;
  for (const item of planned) {
    if (stopRequested({ signal, stopSignal })) {
      cancelled = true;
      break;
    }
    progress.start(item);
    const partialPath = partialPathFor(item.toAbsolute);
    const entry: JournalEntry = { from: item.from, to: item.to, ...(item.target && { target: item.target }), state: 'pending', partial: path.basename(partialPath) };
    batch.renames.push(entry);
    await writeUndoLog(root, log);
    try {
      await transfer(item, entry, { audio, signal, partialPath, onBytes: (bytes) => progress.bytes(bytes) });
      entry.state = 'done';
      delete entry.partial;
      done.push({ from: item.from, to: item.to, target: item.target, ...(item.audio && { converted: true }) });
    } catch (error) {
      batch.renames.pop();
      if (isCancellation(error)) {
        cancelled = true;
        await writeUndoLog(root, log);
        break;
      }
      failed.push({ from: item.from, to: item.to, target: item.target, reason: (error as Error).message });
    }
    await writeUndoLog(root, log);
    progress.finish(item);
  }

  batch.status = cancelled ? 'cancelled' : failed.length ? 'partial' : 'complete';
  if (!batch.renames.length) log.pop();
  await writeUndoLog(root, log);
  return { done, failed, cancelled };
}

/**
 * Validate every rename, then move files one by one.
 * `from` paths are relative to root; each `to` is relative to that rename's
 * `target` (an absolute folder, already validated by the caller), falling back
 * to the `target` option and then to root.
 *
 * Each file is journalled as pending before it moves and as done right after,
 * so an interrupted batch (crash, container stop, cancel) can still be undone.
 * A failing file is reported and the remaining files continue. Cancelling via
 * `signal` stops during the current file (its partial copy is removed and the
 * original stays in place); `stopSignal` stops only between files.
 */
export async function applyRenames(
  root: string,
  renames: readonly RenameRequest[],
  { target = null, audio = {}, signal, stopSignal, onProgress, owner = 'media-renamer' }: ApplyOptions = {},
): Promise<ApplyResult> {
  if (!Array.isArray(renames) || renames.length === 0) throw new InputError('Nothing to rename');
  const planned = await planRenames(root, renames, target);
  const destinations = [...new Set(planned.map((item) => item.target).filter(Boolean) as string[])];
  const summary = { target: sharedTarget(root, planned.map((item) => item.target ?? root)), targets: destinations };
  if (planned.length === 0) return { renamed: 0, failed: [], cancelled: false, ...summary, renames: [] };

  const release = await acquireLock(root, owner);
  try {
    const { done, failed, cancelled } = await runBatch(root, planned, { audio, signal, stopSignal, onProgress });
    return { renamed: done.length, failed, cancelled, ...summary, renames: done };
  } finally {
    await release();
  }
}
