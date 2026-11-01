import type { JobSnapshot } from '../../../lib/types.ts';
import { formatDay, formatTime } from '../format.ts';
import { reviewFiles } from '../review.ts';
import { title } from './ActivityItem.tsx';
import { Breakable } from './Breakable.tsx';

interface ReviewInboxProps {
  jobs: JobSnapshot[];
  busy: boolean;
  /** The job being reviewed in the table, if any, and how many of its files are left. */
  current: { jobId: string; files: number } | null;
  onReview: (job: JobSnapshot) => void;
  onDismiss: (job: JobSnapshot) => void;
}

/** Imports with files that need a decision: one click opens them, already previewed. */
export function ReviewInbox({ jobs, busy, current, onReview, onDismiss }: ReviewInboxProps) {
  if (!jobs.length) return null;
  return (
    <section className="panel inbox" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading">{`Needs review (${jobs.length})`}</h2>
      <ul>
        {jobs.map((job) => {
          const isCurrent = job.id === current?.jobId;
          const count = isCurrent ? current!.files : reviewFiles(job).length;
          return (
            <li key={job.id} aria-current={isCurrent || undefined}>
              <span className="inbox-text">
                <strong>
                  <Breakable text={title(job)} />
                </strong>
                <span className="hint">{`${count} file${count === 1 ? '' : 's'}${isCurrent ? ' left' : ''} · ${formatDay(job.finishedAt ?? job.queuedAt)} ${formatTime(job.finishedAt ?? job.queuedAt)}`}</span>
              </span>
              <span className="row">
                <button type="button" className="primary" disabled={busy} onClick={() => onReview(job)}>
                  {isCurrent ? 'Reload' : 'Resolve'}
                </button>
                <button type="button" disabled={busy} onClick={() => onDismiss(job)} title="Hide this import from the list without renaming its files">
                  Dismiss
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
