import { useState } from 'react';
import type { JobSnapshot } from '../../../lib/types.ts';
import { isActive } from '../hooks/useActivity.ts';
import { useNotifications } from '../hooks/useNotifications.ts';
import { reviewFiles } from '../review.ts';
import { ActivityItem, title } from './ActivityItem.tsx';

const PAGE = 10;

type Filter = 'all' | 'review' | 'failed';

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['review', 'Needs review'],
  ['failed', 'Failed'],
];

const failed = (job: JobSnapshot) =>
  job.state === 'failed' || job.state === 'interrupted' || job.files?.some((file) => file.outcome === 'failed') || Boolean((job.result as { failed?: unknown[] } | null)?.failed?.length);

function NotifyButton() {
  const { available, enabled, pending, toggle } = useNotifications();
  if (!available) return null;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={toggle}
      title={enabled ? 'Click to stop notifications on this device' : 'Get a notification on this device when files need review or a job fails'}
    >
      {enabled ? '🔔 Notifications on' : '🔕 Notify me'}
    </button>
  );
}

interface ActivityPanelProps {
  jobs: JobSnapshot[];
  /** Jobs this browser has finished reviewing. */
  reviewed: ReadonlySet<string>;
  clearing: boolean;
  onClear: () => void;
  onCancel: (job: JobSnapshot) => void;
  onRemove: (job: JobSnapshot) => void;
  removed: JobSnapshot | null;
  onUndoRemove: () => void;
  onOpenFolder: (folder: string) => void;
  onReview: (job: JobSnapshot) => void;
}

/** Queued, running and recent jobs: renames started here and imports started by the downloader. */
export function ActivityPanel({ jobs, reviewed, clearing, onClear, onCancel, onRemove, removed, onUndoRemove, onOpenFolder, onReview }: ActivityPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE);
  const toReview = (job: JobSnapshot) => (reviewed.has(job.id) ? 0 : reviewFiles(job).length);
  const counts: Record<Filter, number> = { all: jobs.length, review: jobs.filter((job) => toReview(job) > 0).length, failed: jobs.filter(failed).length };
  const matching = jobs.filter((job) => filter === 'all' || (filter === 'review' ? toReview(job) > 0 : failed(job)));
  const shown = matching.slice(0, limit);
  return (
    <section className="panel" aria-labelledby="activity-heading">
      <div className="job-head activity-header">
        <h2 id="activity-heading">Activity</h2>
        <span className="row">
          <NotifyButton />
          {jobs.some((job) => !isActive(job)) && (
            <button type="button" disabled={clearing} onClick={onClear}>
              Clear history
            </button>
          )}
        </span>
      </div>
      {jobs.length === 0 && <p className="hint">No jobs yet. Renames you start here and imports started by the downloader appear in this list.</p>}
      {jobs.length > 0 && (
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setLimit(PAGE);
              }}
            >
              {`${label} (${counts[value]})`}
            </button>
          ))}
        </div>
      )}
      {jobs.length > 0 && matching.length === 0 && <p className="hint">Nothing here.</p>}
      <ul className="activity">
        {shown.map((job) => (
          <ActivityItem
            key={job.id}
            job={job}
            toReview={toReview(job)}
            onCancel={() => onCancel(job)}
            onRemove={() => onRemove(job)}
            onOpenFolder={onOpenFolder}
            onReview={() => onReview(job)}
          />
        ))}
      </ul>
      {removed && (
        <div className="snackbar" role="status">
          <span>{`Removed “${title(removed)}” from the history.`}</span>
          <button type="button" className="link" onClick={onUndoRemove}>Undo</button>
        </div>
      )}
      {matching.length > shown.length && (
        <button type="button" className="show-more" onClick={() => setLimit(limit + PAGE)}>
          {`Show ${Math.min(PAGE, matching.length - shown.length)} more of ${matching.length - shown.length}`}
        </button>
      )}
    </section>
  );
}
