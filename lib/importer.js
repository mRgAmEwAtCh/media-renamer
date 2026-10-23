import fs from 'node:fs/promises';
import path from 'node:path';
import { audioToolsAvailable, planAudioFix, probeFile } from './audio.js';
import { sleep } from './async.js';
import { InputError } from './errors.js';
import { CancelledError } from './mover.js';
import { toPosix } from './paths.js';
import { stopRequested } from './rename/progress.js';
import { applyRenames, buildPreview, filterReason, scanFolder } from './renamer.js';
import { activeTargets } from './settings.js';

export const IMPORT_STEPS = [
  { id: 'wait', label: 'Wait until the files stop changing' },
  { id: 'scan', label: 'Scan for media files' },
  { id: 'lookup', label: 'Look up metadata' },
  { id: 'audio', label: 'Check audio tracks' },
  { id: 'process', label: 'Convert and move' },
  { id: 'cleanup', label: 'Clean up empty folders' },
];

const POLL_MS = 2000;
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;

async function fingerprint(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) return `${stat.size}:${stat.mtimeMs}`;
  const entries = await fs.readdir(target, { withFileTypes: true, recursive: true });
  const parts = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const fileStat = await fs.stat(file).catch(() => null);
    if (fileStat) parts.push(`${file}:${fileStat.size}:${fileStat.mtimeMs}`);
  }
  return parts.sort().join('\n');
}

/** Wait until nothing under `target` has changed for `seconds`. */
export async function waitForStableFiles(target, { seconds, signal, pollMs = POLL_MS, timeoutMs = WAIT_TIMEOUT_MS } = {}) {
  if (!seconds) return;
  const started = Date.now();
  let last = await fingerprint(target);
  let stableSince = Date.now();
  while (Date.now() - stableSince < seconds * 1000) {
    if (Date.now() - started > timeoutMs) throw new Error(`Files were still changing after ${Math.round(timeoutMs / 60000)} minutes`);
    await sleep(Math.min(pollMs, seconds * 1000), signal);
    const current = await fingerprint(target);
    if (current !== last) {
      last = current;
      stableSince = Date.now();
    }
  }
}

/** Remove folders under `folder` (and `folder` itself) that are completely empty; never `root`. */
export async function removeEmptyFolders(folder, root) {
  let removed = 0;
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => null);
    if (!entries) return false;
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory() && (await visit(path.join(directory, entry.name)))) continue;
      empty = false;
    }
    if (!empty || directory === root) return false;
    await fs.rmdir(directory);
    removed += 1;
    return true;
  }
  await visit(folder);
  return removed;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const willChange = (item) => item.newRel && (item.target || item.newRel !== item.rel);

/**
 * Import one downloaded folder or file: wait for it to settle, scan, look up
 * metadata, add Dolby Digital Plus tracks where configured, then rename and
 * move with the normal (journalled, undoable) engine. Files that are not a
 * confident match stay where they are and are reported for review.
 *
 * `root` is the allowed folder that contains `target`; the undo journal lives there.
 */
export async function runImport({ root, target, settings, metadata, audioTools = {}, stableSeconds = 10, dryRun = false, control, owner = 'automatic import' }) {
  const { defineSteps, step, setFiles, signal, stopSignal, onProgress } = control;
  const automation = settings.automation;
  defineSteps(IMPORT_STEPS);
  const skipRest = (from, detail) => {
    for (const { id } of IMPORT_STEPS.slice(IMPORT_STEPS.findIndex((s) => s.id === from))) step(id, { state: 'skipped', detail });
  };
  const checkCancel = () => {
    if (stopRequested({ signal, stopSignal })) throw new CancelledError();
  };

  try {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new InputError(`Not found: ${target}`);

    step('wait', { state: 'running' });
    await waitForStableFiles(target, { seconds: stableSeconds, signal });
    step('wait', { state: 'done', detail: stableSeconds ? `No changes for ${stableSeconds}s` : null });
    checkCancel();

    step('scan', { state: 'running' });
    let files;
    let excluded = { samples: 0, nonVideo: 0 };
    if (stat.isFile()) {
      const rel = toPosix(path.relative(root, target));
      const reason = filterReason(rel, settings.filters);
      files = reason ? [] : [rel];
      if (reason) excluded = reason.startsWith('Sample') ? { samples: 1, nonVideo: 0 } : { samples: 0, nonVideo: 1 };
    } else {
      const prefix = toPosix(path.relative(root, target));
      const scanned = await scanFolder(target, { recursive: true, ...settings.filters });
      files = scanned.files.map((rel) => (prefix ? `${prefix}/${rel}` : rel));
      excluded = scanned.excluded;
    }
    const skippedNote = [excluded.samples && plural(excluded.samples, 'sample'), excluded.nonVideo && `${excluded.nonVideo} non-video`].filter(Boolean);
    step('scan', { state: 'done', detail: `${plural(files.length, 'media file')}${skippedNote.length ? `; skipped ${skippedNote.join(' and ')}` : ''}` });
    if (!files.length) {
      skipRest('lookup', 'Nothing to import');
      return { imported: 0, converted: 0, review: 0, failed: 0, cancelled: false, targets: [] };
    }
    checkCancel();

    step('lookup', { state: 'running', detail: `${plural(files.length, 'file')}` });
    const items = await buildPreview({ root, targets: activeTargets(settings), files, patterns: settings.patterns, filters: settings.filters, metadata });
    checkCancel();
    const accepted = new Set(automation.includeWarnings ? ['ok', 'warning'] : ['ok']);
    const rows = items.map((item) => {
      const selected = accepted.has(item.status) && willChange(item);
      return {
        rel: item.rel,
        kind: item.kind,
        status: item.status,
        newRel: item.newRel,
        target: item.target,
        match: item.match,
        message: item.message,
        audio: null,
        outcome: selected ? 'pending' : item.status === 'unchanged' ? 'unchanged' : 'review',
      };
    });
    const selected = rows.filter((row) => row.outcome === 'pending');
    const reviewCount = rows.filter((row) => row.outcome === 'review').length;
    setFiles(rows);
    step('lookup', { state: 'done', detail: `${selected.length} to import${reviewCount ? `, ${reviewCount} need review` : ''}` });
    if (!selected.length) {
      skipRest('audio', 'Nothing to import automatically');
      return { imported: 0, converted: 0, review: reviewCount, failed: 0, cancelled: false, targets: [] };
    }

    const plans = new Map();
    const audioFix = automation.audioFix;
    if (!audioFix.enabled) {
      step('audio', { state: 'skipped', detail: 'Audio fix is switched off' });
    } else if (!(await audioToolsAvailable(audioTools))) {
      step('audio', { state: 'skipped', detail: 'ffmpeg/ffprobe not found; files are moved without conversion' });
    } else {
      step('audio', { state: 'running' });
      for (const row of selected) {
        checkCancel();
        const eligible = row.kind === 'movie' || (row.kind === 'episode' && audioFix.episodes);
        if (!eligible) continue;
        if (path.extname(row.rel).toLowerCase() !== '.mkv') {
          row.audio = 'Not an .mkv file; left as is';
          continue;
        }
        try {
          const plan = planAudioFix(await probeFile(path.join(root, row.rel), { ffprobe: audioTools.ffprobe, signal }), { languages: audioFix.languages });
          if (plan.action === 'convert') {
            plans.set(row.rel, plan);
            row.audio = `Adds Dolby Digital Plus (${plan.conversions.map((c) => `${c.language}, from ${c.source}`).join('; ')})`;
          } else {
            row.audio = `No conversion: ${plan.reason}`;
          }
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          row.audio = `Could not read audio tracks (${error.message}); moved without conversion`;
        }
      }
      setFiles(rows);
      step('audio', { state: 'done', detail: `${plural(plans.size, 'file')} ${plans.size === 1 ? 'gets' : 'get'} a Dolby Digital Plus track` });
    }
    checkCancel();

    if (dryRun) {
      skipRest('process', 'Dry run: nothing was changed');
      return { imported: 0, converted: 0, review: reviewCount, failed: 0, cancelled: false, dryRun: true, planned: selected.length, toConvert: plans.size, targets: [] };
    }

    step('process', { state: 'running' });
    const result = await applyRenames(
      root,
      selected.map((row) => ({ from: row.rel, to: row.newRel, target: row.target, audio: plans.get(row.rel) })),
      { audio: { tools: audioTools, bitrate: audioFix.bitrate }, signal, stopSignal, onProgress, owner },
    );
    const done = new Map(result.renames.map((rename) => [rename.from, rename]));
    const failed = new Map(result.failed.map((failure) => [failure.from, failure]));
    for (const row of selected) {
      if (done.has(row.rel)) row.outcome = done.get(row.rel).converted ? 'converted' : 'moved';
      else if (failed.has(row.rel)) Object.assign(row, { outcome: 'failed', message: failed.get(row.rel).reason });
      else row.outcome = 'not processed';
    }
    setFiles(rows);
    const converted = result.renames.filter((rename) => rename.converted).length;
    const processDetail = [
      `${plural(result.renamed, 'file')} imported`,
      converted && `${converted} with a new audio track`,
      result.failed.length && `${result.failed.length} failed`,
    ].filter(Boolean);
    step('process', { state: result.cancelled ? 'stopped' : result.failed.length ? 'failed' : 'done', detail: processDetail.join(', ') });
    if (result.cancelled) {
      step('cleanup', { state: 'skipped', detail: 'Cancelled' });
      return { imported: result.renamed, converted, review: reviewCount, failed: result.failed.length, cancelled: true, targets: result.targets };
    }

    if (automation.cleanupEmptyFolders && stat.isDirectory()) {
      const removed = await removeEmptyFolders(target, root);
      step('cleanup', { state: 'done', detail: removed ? `Removed ${plural(removed, 'empty folder')}` : 'No empty folders' });
    } else {
      step('cleanup', { state: 'skipped', detail: automation.cleanupEmptyFolders ? null : 'Switched off' });
    }
    return { imported: result.renamed, converted, review: reviewCount, failed: result.failed.length, cancelled: false, targets: result.targets };
  } catch (error) {
    if (error instanceof CancelledError) return { imported: 0, converted: 0, review: 0, failed: 0, cancelled: true, targets: [] };
    throw error;
  }
}
