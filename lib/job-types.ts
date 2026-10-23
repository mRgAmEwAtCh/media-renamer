// Background jobs (rename, undo, automatic import) as the job queue, the web UI
// and the CLI see them. Type-only module; types.ts re-exports everything.
import type { ApplyResult, ItemStatus, ParsedKind, Progress, ProgressListener, UndoResult } from './types.ts';

export type JobKind = 'apply' | 'undo' | 'import';
export type JobState = 'queued' | 'running' | 'cancelling' | 'finished' | 'cancelled' | 'failed' | 'interrupted';
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'stopped';

export interface StepDefinition {
  id: string;
  label: string;
}

export interface Step extends StepDefinition {
  state: StepState;
  detail: string | null;
}

export type StepPatch = { state: StepState; detail?: string | null };

export type ImportOutcome = 'pending' | 'moved' | 'converted' | 'review' | 'unchanged' | 'failed' | 'not processed';

/** One file of an automatic import, as shown in the Activity panel and CLI. */
export interface ImportRow {
  rel: string;
  kind: ParsedKind;
  status: ItemStatus;
  newRel: string | null;
  target: string | null;
  match: string | null;
  message: string | null;
  audio: string | null;
  outcome: ImportOutcome;
}

export interface ImportResult {
  imported: number;
  converted: number;
  review: number;
  failed: number;
  cancelled: boolean;
  targets: string[];
  dryRun?: boolean;
  planned?: number;
  toConvert?: number;
}

export type JobResult = ApplyResult | UndoResult | ImportResult;

/** What a running job gets to report progress and react to cancelling. */
export interface JobControl {
  /** Aborts immediately; the current copy or conversion is discarded. */
  signal: AbortSignal;
  /** Asks the job to stop after the current file. */
  stopSignal?: AbortSignal;
  onProgress?: ProgressListener;
  defineSteps: (steps: StepDefinition[]) => void;
  step: (id: string, patch: StepPatch) => void;
  setFiles: (files: ImportRow[]) => void;
}

export type JobRunner = (control: JobControl) => Promise<JobResult>;

/** A job as clients see it (see JobManager.snapshot). */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  root: string;
  targets: string[];
  params: { path?: string; requested?: string };
  label: string | null;
  source: string;
  state: JobState;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  note: string | null;
  steps: Step[];
  files: ImportRow[];
  progress: Progress;
  result: JobResult | null;
  error: string | null;
  queuePosition?: number;
  fileCount?: number;
}
