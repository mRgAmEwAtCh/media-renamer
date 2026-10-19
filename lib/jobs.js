import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './renamer.js';

const KEEP_FINISHED = 50;
const SAVE_DELAY_MS = 1000;
const ACTIVE_STATES = new Set(['queued', 'running', 'cancelling']);

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
  constructor({ storeFile = null, resume = null, keep = KEEP_FINISHED } = {}) {
    this.jobs = new Map();
    this.queue = [];
    this.active = null;
    this.shuttingDown = false;
    this.storeFile = storeFile;
    this.resume = resume;
    this.keep = keep;
    this.saveTimer = null;
    this.saveWarned = false;
  }

  start({ kind, root, targets = [], params = {}, label = null, source = 'web UI', run }) {
    if (this.shuttingDown) throw Object.assign(new InputError('The server is shutting down'), { status: 503 });
    const job = this.createJob({ kind, root, targets, params, label, source });
    job.run = run;
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.save();
    this.pump();
    return this.snapshot(job);
  }

  createJob({ id = randomUUID(), kind, root, targets, params, label, source, queuedAt = new Date().toISOString() }) {
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
  pump() {
    if (this.active || this.shuttingDown) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    job.cancel = new AbortController();
    job.stop = new AbortController();
    this.save();

    const control = {
      signal: job.cancel.signal,
      stopSignal: job.stop.signal,
      onProgress: (progress) => {
        job.progress = progress;
        this.saveSoon();
      },
      defineSteps: (steps) => {
        job.steps = steps.map(({ id, label }) => ({ id, label, state: 'pending', detail: null }));
        this.save();
      },
      step: (id, patch) => {
        const step = job.steps.find((s) => s.id === id);
        if (step) Object.assign(step, patch);
        this.save();
      },
      setFiles: (files) => {
        job.files = files;
        this.saveSoon();
      },
    };

    job.done = (async () => {
      try {
        job.result = await job.run(control);
        if (job.result?.cancelled) job.state = this.shuttingDown && !job.userCancelled ? 'interrupted' : 'cancelled';
        else job.state = 'finished';
      } catch (error) {
        job.state = 'failed';
        job.error = error.message;
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
          .catch((error) => console.error(`Job notification failed: ${error.message}`));
        this.prune();
        await this.save();
        this.pump();
      }
    })();
  }

  prune() {
    const finished = [...this.jobs.values()].filter((job) => !ACTIVE_STATES.has(job.state));
    for (const job of finished.slice(0, Math.max(0, finished.length - this.keep))) this.jobs.delete(job.id);
  }

  get(id) {
    const job = id ? this.jobs.get(id) : (this.active ?? this.queue[0] ?? [...this.jobs.values()].at(-1));
    return job ? this.snapshot(job) : null;
  }

  /** Newest first. */
  list() {
    return [...this.jobs.values()].reverse().map((job) => this.snapshot(job, { summary: true }));
  }

  /** First queued or running job matching the predicate (e.g. the same import path). */
  findActive(predicate) {
    const job = [this.active, ...this.queue].find((candidate) => candidate && predicate(candidate));
    return job ? this.snapshot(job) : null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new InputError('Unknown job'), { status: 404 });
    if (job.state === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== job);
      Object.assign(job, { state: 'cancelled', finishedAt: new Date().toISOString(), note: 'Cancelled before it started' });
      delete job.run;
      this.save();
    } else if (job.state === 'running') {
      job.state = 'cancelling';
      job.userCancelled = true;
      job.cancel.abort();
      this.save();
    }
    return this.snapshot(job);
  }

  /** Forget all finished jobs; queued and running jobs stay. */
  async clear() {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (ACTIVE_STATES.has(job.state)) continue;
      this.jobs.delete(id);
      removed += 1;
    }
    await this.save();
    return removed;
  }

  /**
   * Stop accepting jobs, let the current file finish for up to graceMs, then
   * cancel hard. Queued jobs stay queued in the store and resume after a restart.
   */
  async shutdown({ graceMs }) {
    this.shuttingDown = true;
    const job = this.active;
    if (job) {
      job.stop.abort();
      const timer = setTimeout(() => job.cancel.abort(), graceMs);
      timer.unref();
      await job.done;
      clearTimeout(timer);
    }
    await this.save();
  }

  /** Load history and re-queue jobs that were waiting or cut off by a restart. */
  async restore() {
    if (!this.storeFile) return;
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(this.storeFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Ignoring unreadable job history ${this.storeFile}: ${error.message}`);
      return;
    }
    if (!Array.isArray(stored)) return;
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

  saveSoon() {
    if (!this.storeFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  /** Saves run one after another; each writes the state at the time it runs, so the newest always wins. */
  save() {
    if (!this.storeFile) return Promise.resolve();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saving = (this.saving ?? Promise.resolve()).then(() => this.writeStore());
    return this.saving;
  }

  async writeStore() {
    const jobs = [...this.jobs.values()].map((job) => this.snapshot(job));
    const temporary = `${this.storeFile}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.storeFile), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(jobs)}\n`);
      await fs.rename(temporary, this.storeFile);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      if (!this.saveWarned) console.error(`Cannot save job history to ${this.storeFile}: ${error.message}`);
      this.saveWarned = true;
    }
  }

  snapshot(job, { summary = false } = {}) {
    const { cancel, stop, done, run, userCancelled, ...visible } = job;
    const copy = structuredClone(visible);
    if (job.state === 'queued') copy.queuePosition = this.queue.indexOf(job) + 1;
    if (summary) {
      copy.fileCount = copy.files.length;
      copy.files = copy.files.slice(0, 200);
    }
    return copy;
  }
}
