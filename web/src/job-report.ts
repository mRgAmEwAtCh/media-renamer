import type { ApplyResult, JobSnapshot, UndoResult } from '../../lib/types.ts';
import type { StatusKind } from './hooks/useStatus.ts';

const listTargets = (targets: string[] | undefined) => (targets?.length ? targets.join(' and ') : '');

function reportApply(r: ApplyResult): [string, StatusKind] {
  const verb = r.targets?.length ? `Moved ${r.renamed} file(s) to ${listTargets(r.targets)}` : `Renamed ${r.renamed} file(s)`;
  const failed = r.failed?.length ? ` ${r.failed.length} failed: ${r.failed.map((f) => `${f.from} (${f.reason})`).join('; ')}.` : '';
  if (r.cancelled) {
    return [`Cancelled. ${verb}; the file in progress was left where it was.${failed} “Undo last batch” reverts the completed ones.`, 'error'];
  }
  return [`${verb}.${failed} Use “Undo last batch” to revert.`, failed ? 'error' : 'success'];
}

function reportUndo(r: UndoResult): [string, StatusKind] {
  const from = r.targets?.length ? ` from ${listTargets(r.targets)}` : '';
  const skipped = r.skipped?.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.from} (${s.reason})`).join('; ')}.` : '';
  const remaining = r.remaining ? ` ${r.remaining} file(s) still to restore — run “Undo last batch” again.` : '';
  return [`${r.cancelled ? 'Undo cancelled. ' : ''}Restored ${r.restored} file(s)${from}.${skipped}${remaining}`, skipped || remaining ? 'error' : 'success'];
}

/** The status line for a finished rename or undo job. */
export function reportJob(job: JobSnapshot): [string, StatusKind] {
  if (job.state === 'failed') return [job.error ?? 'The job failed.', 'error'];
  return job.kind === 'apply' ? reportApply(job.result as ApplyResult) : reportUndo(job.result as UndoResult);
}
