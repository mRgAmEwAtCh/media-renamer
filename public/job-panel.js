import { $, setStatus } from './dom.js';
import { formatBytes, formatDuration } from './format.js';

// Transfer speed since the panel was opened, for the time-left estimate.
const rate = { since: 0, bytes: 0 };
const listTargets = (targets) => (targets?.length ? targets.join(' and ') : '');

function jobTitle(job) {
  if (job.state === 'cancelling') return 'Cancelling…';
  if (job.state === 'queued') return `Waiting for another job to finish${job.queuePosition ? ` (position ${job.queuePosition})` : ''}…`;
  const verb = job.kind === 'apply' ? (job.targets?.length ? 'Moving' : 'Renaming') : 'Undoing';
  return `${verb} files…`;
}

/** Open the progress panel for a new job. */
export function openJobPanel() {
  Object.assign(rate, { since: 0, bytes: 0 });
  for (const bar of ['jobOverall', 'jobFile']) $(bar).value = 0;
  $('jobOverallLabel').textContent = 'Starting…';
  $('jobCurrent').textContent = '';
  $('jobPanel').hidden = false;
}

export const closeJobPanel = () => {
  $('jobPanel').hidden = true;
};

export const showConnectionProblem = (error) => {
  $('jobOverallLabel').textContent = `Lost contact with the server (${error.message}); retrying…`;
};

/** Update the panel with the job's progress, speed and time left. */
export function showJob(job) {
  const p = job.progress;
  $('jobTitle').textContent = jobTitle(job);
  $('jobCancel').disabled = !['running', 'queued'].includes(job.state);

  const doneBytes = p.bytesDone + (p.current?.bytesDone ?? 0);
  const now = Date.now();
  if (!rate.since) Object.assign(rate, { since: now, bytes: doneBytes });
  const seconds = (now - rate.since) / 1000;
  const speed = seconds > 2 ? (doneBytes - rate.bytes) / seconds : 0;
  const eta = speed > 0 ? formatDuration((p.bytesTotal - doneBytes) / speed) : '';

  const parts = [`${p.filesDone} of ${p.filesTotal} file(s)`];
  if (p.bytesTotal) parts.push(`${formatBytes(doneBytes)} of ${formatBytes(p.bytesTotal)}`);
  if (speed > 0) parts.push(`${formatBytes(speed)}/s`);
  if (eta) parts.push(`about ${eta} left`);
  $('jobOverallLabel').textContent = parts.join(' · ');
  $('jobOverall').max = p.bytesTotal || p.filesTotal || 1;
  $('jobOverall').value = p.bytesTotal ? doneBytes : p.filesDone;

  $('jobCurrent').textContent = p.current ? `${p.current.from} → ${p.current.to}` : '';
  $('jobFile').hidden = !p.current;
  if (p.current) {
    $('jobFile').max = p.current.bytesTotal || 1;
    $('jobFile').value = p.current.bytesDone;
  }
}

function reportApply(r) {
  const verb = r.targets?.length ? `Moved ${r.renamed} file(s) to ${listTargets(r.targets)}` : `Renamed ${r.renamed} file(s)`;
  const failed = r.failed?.length ? ` ${r.failed.length} failed: ${r.failed.map((f) => `${f.from} (${f.reason})`).join('; ')}.` : '';
  if (r.cancelled) {
    return setStatus(`Cancelled. ${verb}; the file in progress was left where it was.${failed} “Undo last batch” reverts the completed ones.`, 'error');
  }
  return setStatus(`${verb}.${failed} Use “Undo last batch” to revert.`, failed ? 'error' : 'success');
}

function reportUndo(r) {
  const from = r.targets?.length ? ` from ${listTargets(r.targets)}` : '';
  const skipped = r.skipped?.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.from} (${s.reason})`).join('; ')}.` : '';
  const remaining = r.remaining ? ` ${r.remaining} file(s) still to restore — run “Undo last batch” again.` : '';
  return setStatus(`${r.cancelled ? 'Undo cancelled. ' : ''}Restored ${r.restored} file(s)${from}.${skipped}${remaining}`, skipped || remaining ? 'error' : 'success');
}

/** Put the outcome of a finished job in the status line. */
export function reportJob(job) {
  if (job.state === 'failed') return setStatus(job.error ?? 'The job failed.', 'error');
  return job.kind === 'apply' ? reportApply(job.result) : reportUndo(job.result);
}
