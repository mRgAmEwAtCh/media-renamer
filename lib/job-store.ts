import fs from 'node:fs/promises';
import { writeFileAtomic } from './fs-utils.ts';
import type { JobSnapshot } from './types.ts';

const SAVE_DELAY_MS = 1000;

/**
 * The job history file: progress updates are batched (saveSoon), and saves run
 * one after another, each writing the state at the time it runs, so the newest
 * always wins. A failing disk is reported once and does not stop the jobs.
 */
export class JobStore {
  file: string;
  snapshots: () => JobSnapshot[];
  timer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void>;
  warned: boolean;

  constructor(file: string, snapshots: () => JobSnapshot[]) {
    this.file = file;
    this.snapshots = snapshots;
    this.timer = null;
    this.saving = Promise.resolve();
    this.warned = false;
  }

  /** Saved jobs, or null when there is no (readable) history. */
  async read(): Promise<(JobSnapshot | null)[] | null> {
    let stored: unknown;
    try {
      stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Ignoring unreadable job history ${this.file}: ${(error as Error).message}`);
      }
      return null;
    }
    // The file is written by write(); entries are trusted to be job snapshots.
    return Array.isArray(stored) ? (stored as (JobSnapshot | null)[]) : null;
  }

  saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saving = this.saving.then(() => this.write());
    return this.saving;
  }

  private async write(): Promise<void> {
    try {
      await writeFileAtomic(this.file, `${JSON.stringify(this.snapshots())}\n`, { mkdir: true });
    } catch (error) {
      if (!this.warned) console.error(`Cannot save job history to ${this.file}: ${(error as Error).message}`);
      this.warned = true;
    }
  }
}
