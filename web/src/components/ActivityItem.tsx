import { useState } from 'react';
import type { ImportResult, JobSnapshot, Step } from '../../../lib/types.ts';
import { formatBytes, formatDay, formatTime } from '../format.ts';
import { isActive } from '../hooks/useActivity.ts';
import { canDismiss } from '../../../lib/job-attention.ts';
import { useSwipeAway } from '../hooks/useSwipeAway.ts';
import { Breakable } from './Breakable.tsx';

const STATE_LABEL: Record<string, string> = {
  queued: 'Waiting',
  running: 'Running',
  cancelling: 'Cancelling',
  finished: 'Finished',
  cancelled: 'Cancelled',
  failed: 'Failed',
  interrupted: 'Interrupted',
};
const STEP_ICON: Record<string, string> = { pending: '○', running: '◐', done: '✓', skipped: '–', failed: '✗', stopped: '■' };
const OUTCOME_LABEL: Record<string, string> = {
  pending: 'Waiting',
  moved: 'Moved',
  converted: 'Audio added + moved',
  review: 'Needs review',
  unchanged: 'Already named correctly',
  failed: 'Failed',
  'not processed': 'Not processed',
};

export function title(job: JobSnapshot): string {
  if (job.kind === 'import') return `Import: ${job.label ?? job.params?.path ?? ''}`;
  return job.label ?? (job.kind === 'undo' ? 'Undo last batch' : 'Rename');
}

function summary(job: JobSnapshot): string {
  if (job.state === 'queued') return `Waiting in queue${job.queuePosition ? ` (position ${job.queuePosition})` : ''}`;
  if (job.state === 'failed') return job.error ?? 'Failed';
  if (!job.result) return job.note ?? '';
  if (job.kind === 'import') {
    const r = job.result as ImportResult;
    const parts = [`${r.imported} imported`];
    if (r.converted) parts.push(`${r.converted} with new audio`);
    if (r.review) parts.push(`${r.review} need review`);
    if (r.failed) parts.push(`${r.failed} failed`);
    return parts.join(' · ');
  }
  const r = job.result;
  if ('restored' in r) return `${r.restored} restored${r.skipped?.length ? ` · ${r.skipped.length} skipped` : ''}`;
  if ('renamed' in r) {
    const replaced = r.renames?.filter((rename) => rename.replaced).length;
    const parts = [`${r.renamed} renamed`, replaced && `${replaced} replaced`, r.removed?.length && `${r.removed.length} deleted`, r.failed?.length && `${r.failed.length} failed`];
    return parts.filter(Boolean).join(' · ');
  }
  return '';
}

function Progress({ job }: { job: JobSnapshot }) {
  const p = job.progress;
  if (job.state !== 'running' || !p?.current) return null;
  const done = p.bytesDone + p.current.bytesDone;
  const percent = p.bytesTotal ? Math.floor((done / p.bytesTotal) * 100) : 0;
  const phase = p.current.phase === 'converting' ? 'Converting audio' : 'Moving';
  return (
    <div className="activity-progress">
      <progress max={p.bytesTotal || 1} value={done} />
      <p className="hint">{`${phase}: file ${p.filesDone + 1} of ${p.filesTotal} · ${percent}% · ${formatBytes(done)} of ${formatBytes(p.bytesTotal)}`}</p>
      <p className="path job-current">
        <Breakable text={`${p.current.from} → ${p.current.to}`} />
      </p>
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  if (!steps?.length) return null;
  return (
    <ol className="steps">
      {steps.map((step) => (
        <li key={step.id} className={`step step-${step.state}`}>
          <span className="step-icon" aria-hidden="true">
            {STEP_ICON[step.state] ?? '○'}
          </span>
          <span>
            <span className="step-label">{step.label}</span>
            {step.detail && <span className="step-detail">{` — ${step.detail}`}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Files({ job, onOpenFolder }: { job: JobSnapshot; onOpenFolder: (folder: string) => void }) {
  if (!job.files?.length) return null;
  const reviewFolders = [...new Set(job.files.filter((f) => f.outcome === 'review').map((f) => `${job.root}/${f.rel}`.replace(/\/[^/]*$/, '')))];
  const count = job.fileCount ?? job.files.length;
  return (
    <div className="activity-files">
      <p className="activity-files-heading">{`${count} file${count === 1 ? '' : 's'}`}</p>
      <ul>
        {job.files.map((file) => (
          <li key={file.rel} className={`outcome-${file.outcome.replace(' ', '-')}`}>
            <span className="outcome">{OUTCOME_LABEL[file.outcome] ?? file.outcome}</span>
            <span className="path">
              <Breakable text={file.rel} />
            </span>
            {file.newRel && ['moved', 'converted', 'pending'].includes(file.outcome) && (
              <span className="path hint">
                <Breakable text={`→ ${file.target ? `${file.target}/` : ''}${file.newRel}`} />
              </span>
            )}
            {(file.match || file.message) && <span className="hint">{[file.match, file.message].filter(Boolean).join(' — ')}</span>}
            {file.audio && <span className="hint">{`Audio: ${file.audio}`}</span>}
          </li>
        ))}
      </ul>
      {reviewFolders.map((folder) => (
        <button key={folder} type="button" className="link" onClick={() => onOpenFolder(folder)}>
          <Breakable text={`Open ${folder} in the renamer`} />
        </button>
      ))}
    </div>
  );
}

interface ActivityItemProps {
  job: JobSnapshot;
  /** Number of files still to review here (0 once dealt with). */
  toReview: number;
  onCancel: () => void;
  onRemove: () => void;
  onOpenFolder: (folder: string) => void;
  onReview: () => void;
}

/**
 * One job in the Activity list. Running jobs start expanded; finished ones
 * show their outcome until expanded.
 */
export function ActivityItem({ job, toReview, onCancel, onRemove, onOpenFolder, onReview }: ActivityItemProps) {
  const active = isActive(job);
  const [expanded, setExpanded] = useState(active);
  const hasDetails = Boolean(
    (job.note && job.state !== 'queued') ||
    (job.state === 'running' && job.progress?.current) ||
    job.steps?.length ||
    job.files?.length,
  );
  const source = job.source === 'hook' ? 'via hook' : (job.source ?? '');
  const detailsId = `job-${job.id}`;
  const dismissable = canDismiss(job);
  const swipe = useSwipeAway(onRemove, dismissable);
  return (
    <li className={`activity-row${dismissable ? ' dismissable' : ''}`}>
      {dismissable && <div className="activity-remove-hint" aria-hidden="true"><span>Remove</span><span>Remove</span></div>}
    <div
      style={swipe.style}
      {...swipe.handlers}
      className={`activity-item state-${job.state}${toReview ? ' to-review' : ''}${hasDetails ? ' expandable' : ''}${swipe.dragging ? ' dragging' : ''}`}
    >
      <div className="activity-head" onClick={(event) => {
        if (!hasDetails) return;
        if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select')) return;
        if (swipe.dragging || window.getSelection()?.toString()) return;
        setExpanded((current) => !current);
      }}>
        <div className="activity-title-row">
          <h3>
            {hasDetails ? (
              <button
                type="button"
                className="activity-heading-toggle"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title(job)}`}
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded((current) => !current)}
              >
                <span><Breakable text={title(job)} /></span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            ) : <span className="activity-title"><Breakable text={title(job)} /></span>}
          </h3>
          {dismissable && (
            <button type="button" className="activity-dismiss" aria-label={`Remove “${title(job)}” from the history`} title="Remove from the history" onClick={onRemove}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>
        <span className={`badge badge-${job.state}`}>{STATE_LABEL[job.state] ?? job.state}</span>
        {toReview > 0 && <span className="badge badge-review">{`${toReview} to review`}</span>}
        <span className="hint">{`${source} · ${formatDay(job.queuedAt)} ${formatTime(job.startedAt ?? job.queuedAt)}`}</span>
        {(toReview > 0 || (active && job.state !== 'cancelling')) && <span className="activity-actions">
          {toReview > 0 && (
            <button type="button" className="primary" onClick={onReview}>
              Resolve
            </button>
          )}
          {active && job.state !== 'cancelling' && (
            <button type="button" onClick={onCancel}>
              {job.state === 'queued' ? 'Remove' : 'Cancel'}
            </button>
          )}
        </span>}
      <p className="activity-summary">{summary(job)}</p>
      </div>
      <div id={detailsId} hidden={!expanded}>
        {job.note && job.state !== 'queued' && <p className="hint">{job.note}</p>}
        <Progress job={job} />
        <Steps steps={job.steps} />
        <Files job={job} onOpenFolder={onOpenFolder} />
      </div>
      </div>
    </li>
  );
}
