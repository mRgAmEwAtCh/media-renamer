import { randomUUID } from 'node:crypto';
import { InputError } from './errors.ts';
import { canDismiss } from './job-attention.ts';
import { JobStore } from './job-store.ts';
import type { JobControl, JobKind, JobRunner, JobSnapshot, JobState, Progress, StepDefinition, StepPatch, ImportRow } from './types.ts';

/** A job inside the manager: the snapshot fields plus runtime state that is never saved or sent. */
type Job = JobSnapshot & {
  run?: JobRunner;
  cancel?: AbortController;
  stop?: AbortController;
  done?: Promise<void>;
  userCancelled?: boolean;
};

/** Re-creates the runner for a job restored from the store, or null when it cannot be resumed. */
export type JobResumer = (job: JobSnapshot) => JobRunner | null;

export interface JobManagerOptions {
  storeFile?: string | null;
  resume?: JobResumer | null;
  keep?: number;
}

export interface StartJobOptions {
  kind: JobKind;
  root: string;
  targets?: string[];
  params?: JobSnapshot['params'];
  label?: string | null;
  source?: string;
  run: JobRunner;
}

interface NewJobFields {
  id?: string;
  kind: JobKind;
  root: string;
  targets: string[];
  params: JobSnapshot['params'];
  label: string | null;
  source: string;
  queuedAt?: string;
}

const KEEP_FINISHED = 50;
const ACTIVE_STATES = new Set<JobState>(['queued', 'running', 'cancelling']);

/**
 * Runs rename, undo and import work in the background, one job at a time, in
 * the order it was requested. Clients poll for progress.
 *
 * A job's `run(control)` receives:
 * - `signal` cancels immediately (the current copy or conversion is discarded),
 * - `stopSignal` asks it to stop after the current file,
 * - `onProgress(progress)` for file/byte progress,
 * - `defineSteps([{ id, label }])` and `step(id, { state, detail })` for a step timeline,
 * - `setFiles(files)` for per-file outcomes.
 *
 * With a `storeFile`, the history and the queue survive restarts: `resume(job)`
 * is asked for a new `run` for jobs that were queued or interrupted.
 * `onFinish(job)` is called once for every job that ends.
 */
export class JobManager {
  jobs: Map<string, Job>;
  queue: Job[];
  active: Job | null;
  shuttingDown: boolean;
  store: JobStore | null;
  resume?: JobResumer | null;
  keep: number;
  declare onFinish?: (job: JobSnapshot) => unknown;

  constructor({ storeFile = null, resume = null, keep = KEEP_FINISHED }: JobManagerOptions = {}) {
    this.jobs = new Map();
    this.queue = [];
    this.active = null;
    this.shuttingDown = false;
    this.store = storeFile ? new JobStore(storeFile, () => [...this.jobs.values()].map((job) => this.snapshot(job))) : null;
    this.resume = resume;
    this.keep = keep;
  }

  start({ kind, root, targets = [], params = {}, label = null, source = 'web UI', run }: StartJobOptions): JobSnapshot {
    if (this.shuttingDown) throw new InputError('The server is shutting down', { status: 503 });
    const job = this.createJob({ kind, root, targets, params, label, source });
    job.run = run;
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.save();
    this.pump();
    return this.snapshot(job);
  }

  createJob({ id = randomUUID(), kind, root, targets, params, label, source, queuedAt = new Date().toISOString() }: NewJobFields): Job {
    return {
      id,
      kind,
      root,
      targets,
      params,
      label,
      source,
      state: 'queued',
      queuedAt,
      startedAt: null,
      finishedAt: null,
      note: null,
      steps: [],
      files: [],
      progress: { filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, current: null },
      result: null,
      error: null,
    };
  }

  /** Start the next queued job when nothing is running. */
  pump(): void {
    if (this.active || this.shuttingDown) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    job.cancel = new AbortController();
    job.stop = new AbortController();
    this.save();

    const control: JobControl = {
      signal: job.cancel.signal,
      stopSignal: job.stop.signal,
      onProgress: (progress: Progress) => {
        job.progress = progress;
        this.saveSoon();
      },
      defineSteps: (steps: StepDefinition[]) => {
        job.steps = steps.map(({ id, label }) => ({ id, label, state: 'pending', detail: null }));
        this.save();
      },
      step: (id: string, patch: StepPatch) => {
        const step = job.steps.find((s) => s.id === id);
        if (step) Object.assign(step, patch);
        this.save();
      },
      setFiles: (files: ImportRow[]) => {
        job.files = files;
        this.saveSoon();
      },
    };

    job.done = (async () => {
      try {
        job.result = await job.run!(control);
        if (job.result?.cancelled) job.state = this.shuttingDown && !job.userCancelled ? 'interrupted' : 'cancelled';
        else job.state = 'finished';
      } catch (error) {
        job.state = 'failed';
        job.error = (error as Error).message;
        if (!(error instanceof InputError)) console.error(error);
      } finally {
        for (const step of job.steps) {
          if (step.state === 'running') step.state = job.state === 'failed' ? 'failed' : 'stopped';
        }
        job.finishedAt = new Date().toISOString();
        job.progress = { ...job.progress, current: null };
        delete job.run;
        this.active = null;
        Promise.resolve()
          .then(() => this.onFinish?.(this.snapshot(job)))
          .catch((error: unknown) => console.error(`Job notification failed: ${(error as Error).message}`));
        this.prune();
        await this.save();
        this.pump();
      }
    })();
  }

  prune(): void {
    const finished = [...this.jobs.values()].filter((job) => !ACTIVE_STATES.has(job.state));
    for (const job of finished.slice(0, Math.max(0, finished.length - this.keep))) this.jobs.delete(job.id);
  }

  get(id: string | null | undefined): JobSnapshot | null {
    const job = id ? this.jobs.get(id) : (this.active ?? this.queue[0] ?? [...this.jobs.values()].at(-1));
    return job ? this.snapshot(job) : null;
  }

  /** Newest first. */
  list(): JobSnapshot[] {
    return [...this.jobs.values()].reverse().map((job) => this.snapshot(job, { summary: true }));
  }

  /** First queued or running job matching the predicate (e.g. the same import path). */
  findActive(predicate: (job: JobSnapshot) => boolean): JobSnapshot | null {
    const job = [this.active, ...this.queue].find((candidate) => candidate && predicate(candidate));
    return job ? this.snapshot(job) : null;
  }

  cancel(id: string): JobSnapshot {
    const job = this.jobs.get(id);
    if (!job) throw new InputError('Unknown job', { status: 404 });
    if (job.state === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== job);
      Object.assign(job, { state: 'cancelled', finishedAt: new Date().toISOString(), note: 'Cancelled before it started' });
      delete job.run;
      this.save();
    } else if (job.state === 'running') {
      job.state = 'cancelling';
      job.userCancelled = true;
      job.cancel!.abort();
      this.save();
    }
    return this.snapshot(job);
  }

  /** Forget all finished jobs; queued and running jobs stay. */
  async clear(): Promise<number> {
    const finished = [...this.jobs.values()].filter((job) => !ACTIVE_STATES.has(job.state));
    for (const job of finished) this.jobs.delete(job.id);
    await this.save();
    return finished.length;
  }

  /** Forget one job that finished with nothing left to look at (see canDismiss). */
  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new InputError('Unknown job', { status: 404 });
    if (!canDismiss(job)) throw new InputError('Only finished jobs that need no attention can be removed', { status: 409 });
    this.jobs.delete(id);
    await this.save();
  }

  /**
   * Stop accepting jobs, let the current file finish for up to graceMs, then
   * cancel hard. Queued jobs stay queued in the store and resume after a restart.
   */
  async shutdown({ graceMs }: { graceMs: number }): Promise<void> {
    this.shuttingDown = true;
    const job = this.active;
    if (job) {
      job.stop!.abort();
      const timer = setTimeout(() => job.cancel!.abort(), graceMs);
      timer.unref();
      await job.done;
      clearTimeout(timer);
    }
    await this.save();
  }

  /** Load history and re-queue jobs that were waiting or cut off by a restart. */
  async restore(): Promise<void> {
    const stored = await this.store?.read();
    if (!stored) return;
    for (const saved of stored) {
      if (!saved?.id || this.jobs.has(saved.id)) continue;
      const job = { ...this.createJob(saved), ...saved };
      if (ACTIVE_STATES.has(job.state) || job.state === 'interrupted') {
        const run = this.resume?.(job);
        if (run) {
          const wasStarted = job.state !== 'queued';
          Object.assign(job, this.createJob(job), {
            run,
            note: wasStarted ? 'Restarted after the server stopped during this job' : 'Waiting since before a server restart',
          });
          this.queue.push(job);
        } else if (job.state !== 'interrupted') {
          Object.assign(job, { state: 'interrupted', finishedAt: job.finishedAt ?? new Date().toISOString() });
        }
      }
      this.jobs.set(job.id, job);
    }
    this.prune();
    await this.save();
    this.pump();
  }

  saveSoon(): void {
    this.store?.saveSoon();
  }

  /** Write the history now (when there is a store file). */
  save(): Promise<void> {
    return this.store?.save() ?? Promise.resolve();
  }

  snapshot(job: Job, { summary = false }: { summary?: boolean } = {}): JobSnapshot {
    const { cancel, stop, done, run, userCancelled, ...visible } = job;
    const copy: JobSnapshot = structuredClone(visible);
    if (job.state === 'queued') copy.queuePosition = this.queue.indexOf(job) + 1;
    if (summary) {
      copy.fileCount = copy.files.length;
      copy.files = copy.files.slice(0, 200);
    }
    return copy;
  }
}
