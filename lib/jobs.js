import { randomUUID } from 'node:crypto';
import { InputError } from './renamer.js';

const KEEP_FINISHED = 20;

/**
 * Runs rename/undo work in the background, one job at a time, so long
 * cross-disk moves keep running on the server while clients poll for progress.
 *
 * A job's `run({ signal, stopSignal, onProgress })` receives two signals:
 * `signal` cancels immediately (the current copy is discarded), `stopSignal`
 * asks it to stop after the current file.
 */
export class JobManager {
  constructor() {
    this.jobs = new Map();
    this.active = null;
    this.shuttingDown = false;
  }

  start({ kind, root, targets = [], run }) {
    if (this.shuttingDown) throw Object.assign(new InputError('The server is shutting down'), { status: 503 });
    if (this.active) {
      throw Object.assign(new InputError(`A ${this.active.kind} job is already running in ${this.active.root}`), {
        status: 409,
        job: this.snapshot(this.active),
      });
    }

    const cancel = new AbortController();
    const stop = new AbortController();
    const job = {
      id: randomUUID(),
      kind,
      root,
      targets,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: { filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, current: null },
      result: null,
      error: null,
      cancel,
      stop,
      done: null,
    };
    this.jobs.set(job.id, job);
    this.active = job;

    job.done = (async () => {
      try {
        job.result = await run({
          signal: cancel.signal,
          stopSignal: stop.signal,
          onProgress: (progress) => {
            job.progress = progress;
          },
        });
        job.state = job.result?.cancelled ? 'cancelled' : 'finished';
      } catch (error) {
        job.state = 'failed';
        job.error = error.message;
        if (!(error instanceof InputError)) console.error(error);
      } finally {
        job.finishedAt = new Date().toISOString();
        job.progress = { ...job.progress, current: null };
        this.active = null;
        this.prune();
      }
    })();
    return this.snapshot(job);
  }

  prune() {
    const finished = [...this.jobs.values()].filter((job) => job.state !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(job.id);
  }

  get(id) {
    const job = id ? this.jobs.get(id) : (this.active ?? [...this.jobs.values()].at(-1));
    return job ? this.snapshot(job) : null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new InputError('Unknown job'), { status: 404 });
    if (job.state === 'running') {
      job.state = 'cancelling';
      job.cancel.abort();
    }
    return this.snapshot(job);
  }

  /**
   * Stop accepting jobs, let the current file finish for up to graceMs,
   * then cancel hard. Resolves once the running job has ended.
   */
  async shutdown({ graceMs }) {
    this.shuttingDown = true;
    const job = this.active;
    if (!job) return;
    job.stop.abort();
    const timer = setTimeout(() => job.cancel.abort(), graceMs);
    timer.unref();
    await job.done;
    clearTimeout(timer);
  }

  snapshot(job) {
    const { cancel, stop, done, ...visible } = job;
    return structuredClone(visible);
  }
}
