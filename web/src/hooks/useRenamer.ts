import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanResponse } from '../../../lib/api-types.ts';
import type { JobSnapshot, PreviewItem, Targets } from '../../../lib/types.ts';
import { api, errorMessage, sleep } from '../api.ts';
import { resolveConflict } from '../conflicts.ts';
import { itemsFromPreview, itemsFromScan, selectedItems, type Item } from '../items.ts';
import { reportJob } from '../job-report.ts';
import { readLocal, saveLocal } from '../local.ts';
import { allDecided, openConflicts, reviewFiles } from '../review.ts';
import { formFilters, previewOptions, requestedTargets, type SettingsForm } from '../settings-form.ts';
import { ACTIVE_STATES } from './useActivity.ts';
import type { SetStatus } from './useStatus.ts';

/** The files of an import that need a decision, shown instead of a scanned folder. */
export interface Review {
  jobId: string;
  label: string;
  files: string[];
}

interface ScanState {
  /** The scanned folder, as the server resolved it; '' before the first scan. */
  root: string;
  /** null before the first scan. */
  items: Item[] | null;
  previewed: boolean;
  /** Destinations requested for the current preview. */
  previewTargets: Targets | null;
  /** Changes with every scan and preview. */
  version: number;
  review: Review | null;
}

/** What to do after a rename started while reviewing an import. */
interface AfterReview {
  review: Review;
  /** Every row got a decision, so the import is done once the rename succeeds. */
  decided: boolean;
  /** Files of the review that the rename leaves where they are. */
  remaining: string[];
}

const isMissing = (item: PreviewItem) => item.status === 'error' && item.message === 'File not found';

export function describeScan(data: ScanResponse): string {
  const { excluded } = data;
  const parts = [];
  if (excluded.samples) parts.push(`${excluded.samples} sample`);
  if (excluded.nonVideo) parts.push(`${excluded.nonVideo} non-video`);
  return `Found ${data.files.length} media file(s)${data.truncated ? ' (list truncated)' : ''}.${parts.length ? ` Skipped ${parts.join(' and ')} file(s).` : ''}`;
}

/**
 * The rename workflow: scan a folder, preview new names, then rename (and
 * undo) as a job on the server, following its progress until it ends.
 */
interface RenamerOptions {
  form: SettingsForm;
  setStatus: SetStatus;
  onJobDone: () => void;
  /** An import's files to review were all dealt with. */
  onReviewed: (jobId: string) => void;
}

export function useRenamer({ form, setStatus, onJobDone, onReviewed }: RenamerOptions) {
  const [root, setRoot] = useState(() => readLocal().root ?? '');
  const [recursive, setRecursive] = useState(() => readLocal().recursive ?? true);
  const [scan, setScan] = useState<ScanState>({ root: '', items: null, previewed: false, previewTargets: null, version: 0, review: null });
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null);

  // Async work reads the latest values from here, not from the render it started in.
  const live = useRef({ root, recursive, scan, busy, form, onJobDone, onReviewed });
  useEffect(() => {
    live.current = { root, recursive, scan, busy, form, onJobDone, onReviewed };
  });
  const afterReview = useRef<AfterReview | null>(null);
  const originalItems = useRef<Item[] | null>(null);
  const scanSummary = useRef('');
  const hasPendingEdits = () => JSON.stringify(live.current.scan.items) !== JSON.stringify(originalItems.current);

  const showScan = (data: ScanResponse) => {
    const items = itemsFromScan(data.files);
    originalItems.current = items;
    scanSummary.current = describeScan(data);
    setScan((current) => ({ root: data.root, items, previewed: false, previewTargets: null, version: current.version + 1, review: null }));
  };

  /** Run a task with the buttons disabled; its error goes to the status line. */
  const run = async (message: string, task: () => Promise<void>) => {
    live.current.busy = true;
    setBusy(true);
    setStatus(message);
    try {
      await task();
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      live.current.busy = false;
      setBusy(false);
    }
  };

  async function scanFolder({ folder = live.current.root, settings = live.current.form } = {}) {
    if (live.current.busy) return;
    saveLocal(folder, live.current.recursive);
    await run('Scanning…', async () => {
      const data = await api('/api/scan', { root: folder.trim(), recursive: live.current.recursive, ...formFilters(settings) });
      showScan(data);
      const summary = describeScan(data);
      if (!data.files.length) {
        setStatus(summary);
        return;
      }
      setStatus(`${summary} Looking up metadata…`);
      try {
        await loadPreview({ folder: data.root, files: data.files.map((file) => file.rel), settings, review: null, prefix: `${summary} ` });
      } catch (error) {
        setStatus(`${summary} Preview failed: ${errorMessage(error)} Use “Retry preview”.`, 'error');
      }
    });
  }

  const rescan = async (preserveEdits = false) => {
    const { scan: current, recursive: subfolders, form: latestForm } = live.current;
    const data = await api('/api/scan', { root: current.root, recursive: subfolders, ...formFilters(latestForm) });
    if (preserveEdits && (live.current.busy || live.current.scan.version !== current.version || hasPendingEdits())) return;
    showScan(data);
  };

  /** Look up names for `files` in `folder`; with `review`, the rows are an import's files to review. */
  async function loadPreview({ folder, files, settings, review, prefix = '' }: { folder: string; files: string[]; settings: SettingsForm; review: Review | null; prefix?: string }) {
    const targets = requestedTargets(settings);
    if (settings.move && !targets.episode && !targets.movie) {
      setStatus(`${prefix}Choose a destination for TV shows and/or movies in Settings, or untick “Move renamed files”, then retry preview.`, 'error');
      return false;
    }
    const data = await api('/api/preview', { root: folder, targets, files, ...previewOptions(settings) });
    // Files of an import that were renamed or deleted since (maybe on another device) are done.
    const found = review ? data.items.filter((item) => !isMissing(item)) : data.items;
    if (review && !found.length) {
      live.current.onReviewed(review.jobId);
      originalItems.current = null;
      setScan((current) => ({ ...current, items: null, previewed: false, previewTargets: null, review: null, version: current.version + 1 }));
      setStatus(`${prefix}Nothing left to review from “${review.label}”: its files were already moved.`, 'success');
      return true;
    }
    if (review) review = { ...review, files: found.map((item) => item.rel) };
    const items = itemsFromPreview(found);
    originalItems.current = items;
    setScan((current) => ({ root: data.root, items, previewed: true, previewTargets: targets, review, version: current.version + 1 }));
    const ready = items.filter((item) => item.selected);
    const moving = (['episode', 'movie'] as const)
      .map((kind) => [kind, ready.filter((item) => item.kind === kind && item.target).length] as const)
      .filter(([, count]) => count)
      .map(([kind, count]) => `${count} to ${data.targets[kind]}`);
    const conflicts = openConflicts(items).length;
    const decide = conflicts ? ` ${conflicts} conflict(s): choose Keep both, Overwrite or Skip.` : '';
    setStatus(`${prefix}${ready.length} file(s) ready${moving.length ? ` (moving ${moving.join(', ')})` : ''}. Review warnings before selecting them.${decide}`);
    return true;
  }

  async function runPreview(options: Parameters<typeof loadPreview>[0]) {
    let ok = false;
    await run('Looking up metadata…', async () => {
      ok = await loadPreview(options);
    });
    return ok;
  }

  /** Preview the shown rows; `settings` replaces the form when it was just saved or reverted. */
  async function preview(settings: SettingsForm = live.current.form) {
    const { scan: current } = live.current;
    await runPreview({ folder: current.root, files: (current.items ?? []).map((item) => item.rel), settings, review: current.review, prefix: current.review ? '' : `${scanSummary.current} ` });
  }

  /** Show the files of an import that need review, already previewed. */
  async function reviewJob(job: JobSnapshot, settings: SettingsForm = live.current.form): Promise<boolean> {
    const files = reviewFiles(job);
    if (!files.length) {
      setStatus('Nothing in this job needs review any more.');
      return false;
    }
    setRoot(job.root);
    saveLocal(job.root, live.current.recursive);
    const label = job.label ?? job.params?.path ?? 'Import';
    return runPreview({ folder: job.root, files, settings, review: { jobId: job.id, label, files } });
  }

  /** Leave review mode; `done` also marks the import as dealt with. */
  function closeReview(done: boolean) {
    const { review } = live.current.scan;
    if (!review) return;
    if (done) live.current.onReviewed(review.jobId);
    originalItems.current = null;
    setScan((current) => ({ ...current, items: null, previewed: false, previewTargets: null, review: null, version: current.version + 1 }));
    setStatus(done ? `Marked “${review.label}” as reviewed.` : '');
  }

  /** After a rename or undo: show what is left to review, or the folder again. */
  async function refreshAfterJob(finished: JobSnapshot, report: string) {
    const pending = afterReview.current;
    afterReview.current = null;
    const { review } = live.current.scan;
    if (pending && review?.jobId === pending.review.jobId && finished.state === 'finished') {
      if (pending.decided || !pending.remaining.length) {
        live.current.onReviewed(review.jobId);
        originalItems.current = null;
        setScan((current) => ({ ...current, items: null, previewed: false, previewTargets: null, review: null, version: current.version + 1 }));
        setStatus(`${report} Review of “${review.label}” done.`, 'success');
        return;
      }
      const left = { ...review, files: pending.remaining };
      await runPreview({ folder: live.current.scan.root, files: left.files, settings: live.current.form, review: left, prefix: `${report} ` });
      return;
    }
    if (review && finished.kind === 'apply') {
      await runPreview({ folder: live.current.scan.root, files: review.files, settings: live.current.form, review, prefix: `${report} ` });
      return;
    }
    if (live.current.scan.root) await rescan().catch(() => {});
  }

  /** Show a server-side job until it ends; survives page reloads and brief disconnects. */
  const follow = useCallback(
    async (started: JobSnapshot) => {
      setBusy(true);
      setJob(started);
      setConnectionProblem(null);
      setStatus('');
      let current = started;
      while (ACTIVE_STATES.has(current.state)) {
        await sleep(700);
        try {
          const latest = (await api('/api/job', { id: current.id })).job;
          if (!latest) break; // The server restarted; the undo log keeps what was done.
          current = latest;
          setJob(latest);
          setConnectionProblem(null);
        } catch (error) {
          setConnectionProblem(errorMessage(error));
          await sleep(2000);
        }
      }
      setJob(null);
      setBusy(false);
      const [report, kind] = current.result || current.state === 'failed' ? reportJob(current) : (['The server restarted during the job. Completed moves are in the undo log.', 'error'] as const);
      setStatus(report, kind);
      if (kind === 'error') afterReview.current = null;
      await refreshAfterJob(current, report);
      live.current.onJobDone();
    },
    // refreshAfterJob reads everything it needs from `live`.
    [setStatus],
  );

  async function startJob(start: () => Promise<JobSnapshot>) {
    try {
      await follow(await start());
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    }
  }

  async function apply() {
    const selected = selectedItems(scan.items ?? []);
    const moving = selected.filter((item) => item.resolution !== 'remove');
    const renames = moving.map((item) => ({
      from: item.rel,
      to: item.newRel!,
      target: item.target ?? null,
      ...(item.resolution === 'overwrite' && { overwrite: true }),
    }));
    const remove = selected.filter((item) => item.resolution === 'remove').map((item) => item.rel);
    const replacing = renames.filter((rename) => rename.overwrite).length;
    const byTarget = Object.entries(Object.groupBy(moving, (item) => item.target ?? '')).map(([target, list]) =>
      target ? `${list!.length} into ${target}` : `${list!.length} in place`,
    );
    const parts = [
      renames.length && `Rename ${renames.length} file(s): ${byTarget.join(', ')}`,
      replacing && `replace ${replacing} existing file(s)`,
      remove.length && `delete ${remove.length} extracted file(s)`,
    ].filter(Boolean);
    const warning = replacing || remove.length ? '\n\nReplaced and deleted files cannot be restored with “Undo last batch”.' : '';
    if (!parts.length || !confirm(`${parts.join('; ')}?${warning}`)) return;
    if (scan.review) {
      const handled = new Set([...renames.map((rename) => rename.from), ...remove]);
      afterReview.current = { review: scan.review, decided: allDecided(scan.items ?? []), remaining: scan.review.files.filter((rel) => !handled.has(rel)) };
    }
    await startJob(() => api('/api/apply', { root: scan.root, renames, ...(remove.length && { remove }) }));
  }

  /** Settle a conflict by keeping both files: the new one gets the next free name. */
  async function keepBoth(index: number) {
    const { version, root: folder } = scan;
    const items = scan.items ?? [];
    const item = items[index];
    const wanted = item.originalNewRel ?? item.newRel!;
    const taken = items.filter((other) => other !== item && other.newRel && (other.target ?? null) === (item.target ?? null)).map((other) => other.newRel!);
    try {
      const { newRel } = await api('/api/free-name', { root: folder, target: item.target, rel: wanted, taken });
      // A rescan or new preview while waiting replaces the rows; then this answer is stale.
      setScan((current) => {
        const at = current.version === version ? (current.items ?? []).findIndex((row) => row.rel === item.rel) : -1;
        return at < 0 ? current : { ...current, items: resolveConflict(current.items!, at, 'keep-both', newRel) };
      });
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    }
  }

  /** "Keep both" for every open conflict, one after the other, so each gets its own free name. */
  async function keepBothAll() {
    const { version, root: folder } = live.current.scan;
    let items = live.current.scan.items ?? [];
    await run('Finding free names…', async () => {
      for (;;) {
        const index = items.findIndex((item) => item.status === 'conflict' && !item.resolution);
        if (index < 0) break;
        const item = items[index];
        const wanted = item.originalNewRel ?? item.newRel!;
        const taken = items.filter((other) => other !== item && other.newRel && (other.target ?? null) === (item.target ?? null)).map((other) => other.newRel!);
        const { newRel } = await api('/api/free-name', { root: folder, target: item.target, rel: wanted, taken });
        items = resolveConflict(items, index, 'keep-both', newRel);
      }
      setScan((current) => (current.version === version ? { ...current, items } : current));
      setStatus('Every conflicting file keeps its own name now. Check the names, then rename.');
    });
  }

  async function undo() {
    if (!confirm('Undo the last rename batch in this folder?')) return;
    await startJob(() => api('/api/undo', { root: scan.root }));
  }

  async function cancelJob() {
    if (!job || !confirm('Cancel? The file being copied stays where it was; completed files can be undone.')) return;
    try {
      const cancelled = (await api('/api/job/cancel', { id: job.id })).job;
      // The job may have ended while the request was under way; don't bring its panel back.
      setJob((current) => (current?.id === cancelled.id ? cancelled : current));
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    }
  }

  // Re-attach to a rename/undo started from this UI before a reload; imports show in Activity.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    api('/api/job', {})
      .then(({ job: running }) => {
        if (!running || running.source !== 'web UI' || !ACTIVE_STATES.has(running.state)) return;
        setScan((current) => ({ ...current, root: running.root, review: null }));
        return follow(running);
      })
      .catch(() => {});
  }, [follow]);

  const stale = scan.previewed && JSON.stringify(requestedTargets(form)) !== JSON.stringify(scan.previewTargets);
  useEffect(() => {
    if (stale && !busy) setStatus('Destinations changed — preview again before renaming.', 'error');
  }, [stale, busy, setStatus]);

  return {
    root,
    setRoot,
    recursive,
    setRecursive: (value: boolean) => {
      setRecursive(value);
      saveLocal(root, value);
    },
    scan,
    setItems: (items: Item[]) => setScan((current) => ({ ...current, items })),
    busy,
    stale,
    job,
    connectionProblem,
    scanFolder,
    hasPendingEdits,
    /** Rescan the shown folder unless a scan or job is running (e.g. after an import moved files). */
    rescanIfIdle: () => {
      if (live.current.scan.root && !live.current.scan.review && !live.current.busy && !hasPendingEdits()) {
        rescan(true).catch((error: unknown) => setStatus(errorMessage(error), 'error'));
      }
    },
    preview,
    reviewJob,
    closeReview,
    keepBoth,
    keepBothAll,
    apply,
    undo,
    cancelJob,
  };
}
