import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobSnapshot } from '../../../lib/types.ts';
import { api } from '../api.ts';

export const ACTIVE_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'cancelling']);
export const isActive = (job: JobSnapshot): boolean => ACTIVE_STATES.has(job.state);

/**
 * Queued, running and recent jobs, polled from the server: often while a job
 * runs, rarely when idle or when the page is hidden. `onSettled` runs when the
 * last active job ends (an import may have moved files out of the shown folder).
 */
export function useActivity(onSettled: () => void) {
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [clearing, setClearing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastActive = useRef(false);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  const refresh = useCallback(async (): Promise<void> => {
    const schedule = (ms: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, document.hidden ? Math.max(ms, 10000) : ms);
    };
    try {
      const { jobs: latest } = await api('/api/jobs', {});
      setJobs(latest);
      const active = latest.some(isActive);
      if (lastActive.current && !active) settled.current();
      lastActive.current = active;
      schedule(active ? 1500 : 8000);
    } catch {
      schedule(10000);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const clear = useCallback(async () => {
    if (!confirm('Clear the finished jobs from the history? Waiting and running jobs stay. Undo is not affected.')) return;
    setClearing(true);
    await api('/api/jobs/clear', {}).catch(() => {});
    setClearing(false);
    refresh();
  }, [refresh]);

  const cancel = useCallback(
    async (job: JobSnapshot) => {
      const message =
        job.state === 'queued' ? 'Remove this job from the queue?' : 'Cancel? The file in progress stays where it was; finished files can be undone.';
      if (confirm(message)) await api('/api/job/cancel', { id: job.id }).then(refresh, () => {});
    },
    [refresh],
  );

  return { jobs, refresh, clear, clearing, cancel };
}
