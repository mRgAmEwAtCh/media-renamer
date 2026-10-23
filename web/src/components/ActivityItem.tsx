import type { ImportResult, JobSnapshot, Step } from '../../../lib/types.ts';
import { formatBytes, formatDay, formatTime } from '../format.ts';
import { isActive } from '../hooks/useActivity.ts';
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

function title(job: JobSnapshot): string {
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
  if ('renamed' in r) return `${r.renamed} renamed${r.failed?.length ? ` · ${r.failed.length} failed` : ''}`;
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
          <span className="step-label">{step.label}</span>
          {step.detail && <span className="step-detail">{` — ${step.detail}`}</span>}
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
    <details className="activity-files" open={job.files.some((f) => f.outcome === 'review' || f.outcome === 'failed')}>
      <summary>{`${count} file${count === 1 ? '' : 's'}`}</summary>
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
          {`Open ${folder} in the renamer`}
        </button>
      ))}
    </details>
  );
}

/** One job in the Activity list: state, summary, progress, steps and per-file results. */
export function ActivityItem({ job, onCancel, onOpenFolder }: { job: JobSnapshot; onCancel: () => void; onOpenFolder: (folder: string) => void }) {
  const source = job.source === 'hook' ? 'via hook' : (job.source ?? '');
  return (
    <li className={`activity-item state-${job.state}`}>
      <div className="activity-head">
        <strong>{title(job)}</strong>
        <span className={`badge badge-${job.state}`}>{STATE_LABEL[job.state] ?? job.state}</span>
        <span className="hint">{`${source} · ${formatDay(job.queuedAt)} ${formatTime(job.startedAt ?? job.queuedAt)}`}</span>
        {isActive(job) && job.state !== 'cancelling' && (
          <button type="button" onClick={onCancel}>
            {job.state === 'queued' ? 'Remove' : 'Cancel'}
          </button>
        )}
      </div>
      <p className="activity-summary">{summary(job)}</p>
      {job.note && job.state !== 'queued' && <p className="hint">{job.note}</p>}
      <Progress job={job} />
      <Steps steps={job.steps} />
      <Files job={job} onOpenFolder={onOpenFolder} />
    </li>
  );
}
