import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanResponse } from '../../../lib/api-types.ts';
import type { JobSnapshot, Targets } from '../../../lib/types.ts';
import { api, errorMessage, sleep } from '../api.ts';
import { itemsFromScan, selectedItems, type Item } from '../components/FileTable.tsx';
import { reportJob } from '../job-report.ts';
import { readLocal, saveLocal } from '../local.ts';
import { formFilters, previewOptions, requestedTargets, type SettingsForm } from '../settings-form.ts';
import { ACTIVE_STATES } from './useActivity.ts';
import type { SetStatus } from './useStatus.ts';

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
}

function describeExcluded(excluded: ScanResponse['excluded']): string {
  const parts = [];
  if (excluded.samples) parts.push(`${excluded.samples} sample`);
  if (excluded.nonVideo) parts.push(`${excluded.nonVideo} non-video`);
  return parts.length ? ` Skipped ${parts.join(' and ')} file(s).` : '';
}

/**
 * The rename workflow: scan a folder, preview new names, then rename (and
 * undo) as a job on the server, following its progress until it ends.
 */
export function useRenamer({ form, setStatus, onJobDone }: { form: SettingsForm; setStatus: SetStatus; onJobDone: () => void }) {
  const [root, setRoot] = useState(() => readLocal().root ?? '');
  const [recursive, setRecursive] = useState(() => readLocal().recursive ?? true);
  const [scan, setScan] = useState<ScanState>({ root: '', items: null, previewed: false, previewTargets: null, version: 0 });
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null);

  // Async work reads the latest values from here, not from the render it started in.
  const live = useRef({ root, recursive, scan, busy, form, onJobDone });
  useEffect(() => {
    live.current = { root, recursive, scan, busy, form, onJobDone };
  });

  const showScan = (data: ScanResponse) =>
    setScan((current) => ({ root: data.root, items: itemsFromScan(data.files), previewed: false, previewTargets: null, version: current.version + 1 }));

  /** Run a task with the buttons disabled; its error goes to the status line. */
  const run = async (message: string, task: () => Promise<void>) => {
    setBusy(true);
    setStatus(message);
    try {
      await task();
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  async function scanFolder({ folder = live.current.root, filters = formFilters(live.current.form) } = {}) {
    saveLocal(folder, live.current.recursive);
    await run('Scanning…', async () => {
      const data = await api('/api/scan', { root: folder.trim(), recursive: live.current.recursive, ...filters });
      showScan(data);
      setStatus(`Found ${data.files.length} media file(s)${data.truncated ? ' (list truncated)' : ''}.${describeExcluded(data.excluded)} Click “Preview names”.`);
    });
  }

  const rescan = async () => {
    const { scan: current, recursive: subfolders, form: latestForm } = live.current;
    showScan(await api('/api/scan', { root: current.root, recursive: subfolders, ...formFilters(latestForm) }));
  };

  async function preview() {
    const targets = requestedTargets(form);
    if (form.move && !targets.episode && !targets.movie) {
      setStatus('Choose a destination for TV shows and/or movies, or untick “Move renamed files”.', 'error');
      return;
    }
    await run('Looking up metadata…', async () => {
      const files = (scan.items ?? []).map((item) => item.rel);
      const data = await api('/api/preview', { root: scan.root, targets, files, ...previewOptions(form) });
      const items = data.items.map((item) => ({ ...item, selected: item.status === 'ok' }));
      setScan((current) => ({ ...current, previewTargets: targets, previewed: true, items, version: current.version + 1 }));
      const ready = items.filter((item) => item.selected);
      const moving = (['episode', 'movie'] as const)
        .map((kind) => [kind, ready.filter((item) => item.kind === kind && item.target).length] as const)
        .filter(([, count]) => count)
        .map(([kind, count]) => `${count} to ${data.targets[kind]}`);
      setStatus(`${ready.length} file(s) ready${moving.length ? ` (moving ${moving.join(', ')})` : ''}. Review warnings before selecting them.`);
    });
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
      if (current.result || current.state === 'failed') setStatus(...reportJob(current));
      else setStatus('The server restarted during the job. Completed moves are in the undo log.', 'error');
      if (live.current.scan.root) await rescan().catch(() => {});
      live.current.onJobDone();
    },
    // rescan reads everything it needs from `live`.
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
    const renames = selected.map((item) => ({ from: item.rel, to: item.newRel!, target: item.target ?? null }));
    const byTarget = Object.entries(Object.groupBy(selected, (item) => item.target ?? '')).map(([target, list]) =>
      target ? `${list!.length} into ${target}` : `${list!.length} in place`,
    );
    if (!renames.length || !confirm(`Rename ${renames.length} file(s): ${byTarget.join(', ')}?`)) return;
    await startJob(() => api('/api/apply', { root: scan.root, renames }));
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
        setScan((current) => ({ ...current, root: running.root }));
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
    /** Rescan the shown folder unless a scan or job is running (e.g. after an import moved files). */
    rescanIfIdle: () => {
      if (live.current.scan.root && !live.current.busy) rescan().catch(() => {});
    },
    preview,
    apply,
    undo,
    cancelJob,
  };
}
