import type { JobSnapshot } from '../../lib/types.ts';
import type { Item } from './items.ts';

// Imports leave files they could not match confidently where they are, marked
// "review". This browser remembers which of those jobs the user has dealt with.

const DONE_KEY = 'media-renamer:reviewed';
const KEEP_DONE = 200;

/** The files of a finished job that still need a decision, relative to `job.root`. */
export const reviewFiles = (job: JobSnapshot): string[] =>
  job.state === 'finished' || job.state === 'cancelled' ? (job.files ?? []).filter((file) => file.outcome === 'review').map((file) => file.rel) : [];

/** Jobs with files to review that the user has not dealt with yet, newest first. */
export const jobsToReview = (jobs: JobSnapshot[], done: ReadonlySet<string>): JobSnapshot[] =>
  jobs.filter((job) => !done.has(job.id) && reviewFiles(job).length > 0);

export function readReviewed(): Set<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

export function saveReviewed(ids: ReadonlySet<string>): void {
  localStorage.setItem(DONE_KEY, JSON.stringify([...ids].slice(-KEEP_DONE)));
}

/** Whether every row of a review got a decision: selected for renaming, or skipped on purpose. */
export const allDecided = (items: Item[]): boolean =>
  items.every((item) => item.selected || item.resolution === 'skip' || item.resolution === 'remove' || item.status === 'error');

/** Rows the user has to look at: open conflicts, warnings and errors. */
export const needsAttention = (item: Item): boolean =>
  (item.status === 'conflict' && !item.resolution) || item.status === 'warning' || item.status === 'error';

/** Conflicts nobody has decided yet. */
export const openConflicts = (items: Item[]): Item[] => items.filter((item) => item.status === 'conflict' && !item.resolution);
