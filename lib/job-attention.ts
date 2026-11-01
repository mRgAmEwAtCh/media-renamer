// When a finished job still needs the user. Shared by push notifications, the
// job history and the web UI, so all three agree. No Node imports: web/ uses it too.
import type { JobSnapshot } from './types.ts';

export interface Attention {
  title: string;
  body: string;
  url: string;
}

/** The message for a finished job that needs the user, or null. */
export function actionNeeded(job: JobSnapshot): Attention | null {
  const name = job.label ?? (job.kind === 'import' ? 'Import' : 'Rename');
  if (job.state === 'failed') return { title: `Failed: ${name}`, body: job.error ?? 'The job failed.', url: '/#/activity' };
  const result = (job.result ?? {}) as { failed?: unknown[] | number; review?: number };
  const failed = Array.isArray(result.failed) ? result.failed.length : (result.failed ?? 0);
  const parts = [
    result.review ? `${result.review} file${result.review === 1 ? ' needs' : 's need'} review` : '',
    failed ? `${failed} file${failed === 1 ? '' : 's'} failed` : '',
  ].filter(Boolean);
  return parts.length ? { title: `Action needed: ${name}`, body: parts.join(' · '), url: result.review ? `/#/review/${encodeURIComponent(job.id)}` : '/#/activity' } : null;
}

/** History entries the user may remove one by one: finished, with nothing left to look at. */
export const canDismiss = (job: JobSnapshot): boolean => job.state === 'finished' && actionNeeded(job) === null;
