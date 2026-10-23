import type { JobSnapshot } from '../../../lib/types.ts';
import { isActive } from '../hooks/useActivity.ts';
import { useNotifications } from '../hooks/useNotifications.ts';
import { ActivityItem } from './ActivityItem.tsx';

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
  clearing: boolean;
  onClear: () => void;
  onCancel: (job: JobSnapshot) => void;
  onOpenFolder: (folder: string) => void;
}

/** Queued, running and recent jobs: renames started here and imports started by the downloader. */
export function ActivityPanel({ jobs, clearing, onClear, onCancel, onOpenFolder }: ActivityPanelProps) {
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
      <ul className="activity">
        {jobs.map((job) => (
          <ActivityItem key={job.id} job={job} onCancel={() => onCancel(job)} onOpenFolder={onOpenFolder} />
        ))}
      </ul>
    </section>
  );
}
