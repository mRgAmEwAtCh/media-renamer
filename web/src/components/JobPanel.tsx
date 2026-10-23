import { useRef } from 'react';
import type { JobSnapshot } from '../../../lib/types.ts';
import { formatBytes, formatDuration } from '../format.ts';

function jobTitle(job: JobSnapshot): string {
  if (job.state === 'cancelling') return 'Cancelling…';
  if (job.state === 'queued') return `Waiting for another job to finish${job.queuePosition ? ` (position ${job.queuePosition})` : ''}…`;
  const verb = job.kind === 'apply' ? (job.targets?.length ? 'Moving' : 'Renaming') : 'Undoing';
  return `${verb} files…`;
}

/** Progress of a rename or undo started from this page, with speed and time left. */
export function JobPanel({ job, connectionProblem, onCancel }: { job: JobSnapshot; connectionProblem: string | null; onCancel: () => void }) {
  // Transfer speed since this job was first shown, for the time-left estimate.
  const rate = useRef({ id: '', since: 0, bytes: 0 });
  const p = job.progress;
  const doneBytes = p.bytesDone + (p.current?.bytesDone ?? 0);
  const now = Date.now();
  if (rate.current.id !== job.id) rate.current = { id: job.id, since: now, bytes: doneBytes };
  const seconds = (now - rate.current.since) / 1000;
  const speed = seconds > 2 ? (doneBytes - rate.current.bytes) / seconds : 0;
  const eta = speed > 0 ? formatDuration((p.bytesTotal - doneBytes) / speed) : '';

  const parts = [`${p.filesDone} of ${p.filesTotal} file(s)`];
  if (p.bytesTotal) parts.push(`${formatBytes(doneBytes)} of ${formatBytes(p.bytesTotal)}`);
  if (speed > 0) parts.push(`${formatBytes(speed)}/s`);
  if (eta) parts.push(`about ${eta} left`);

  return (
    <section className="panel job" aria-labelledby="jobTitle">
      <div className="job-head">
        <h2 id="jobTitle">{jobTitle(job)}</h2>
        <button type="button" disabled={!['running', 'queued'].includes(job.state)} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <label htmlFor="jobOverall" id="jobOverallLabel" className="hint">
        {connectionProblem ? `Lost contact with the server (${connectionProblem}); retrying…` : parts.join(' · ')}
      </label>
      <progress id="jobOverall" max={p.bytesTotal || p.filesTotal || 1} value={p.bytesTotal ? doneBytes : p.filesDone} />
      <p className="path job-current">{p.current ? `${p.current.from} → ${p.current.to}` : ''}</p>
      {p.current && <progress max={p.current.bytesTotal || 1} value={p.current.bytesDone} aria-label="Current file" />}
      <p className="hint">This runs on the server. You can close this page; reopen it to see the progress.</p>
    </section>
  );
}
