import type { Progress, ProgressListener } from '../types.ts';
import { formatBytes } from '../units.ts';
import type { CliValues } from './args.ts';
import type { Output } from './output.ts';

export interface ProgressReporter {
  update: ProgressListener;
  end: () => void;
}

/** What a task run by `runWithProgress` receives. */
export interface ProgressTaskOptions {
  signal: AbortSignal;
  onProgress: ProgressListener;
  reporter: ProgressReporter;
}

/** Progress on stderr: a live line on a terminal, one line per file otherwise. */
export function createProgressReporter(values: Pick<CliValues, 'quiet'>): ProgressReporter {
  if (values.quiet) return { update() {}, end() {} };
  const live = process.stderr.isTTY;
  let lastFile: string | null = null;
  let lastDraw = 0;
  return {
    update(p: Progress) {
      if (!p.current) return;
      if (!live) {
        if (p.current.from !== lastFile) process.stderr.write(`[${p.filesDone + 1}/${p.filesTotal}] ${p.current.from} → ${p.current.to}\n`);
        lastFile = p.current.from;
        return;
      }
      const now = Date.now();
      if (now - lastDraw < 200 && p.current.bytesDone < p.current.bytesTotal) return;
      lastDraw = now;
      const done = p.bytesDone + p.current.bytesDone;
      const percent = p.bytesTotal ? Math.floor((done / p.bytesTotal) * 100) : 0;
      const line = `[${p.filesDone + 1}/${p.filesTotal}] ${percent}% ${formatBytes(done)}/${formatBytes(p.bytesTotal)}  ${p.current.to}`;
      process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns || 100) - 1)}`);
    },
    end() {
      if (live && lastDraw) process.stderr.write('\r\x1b[2K');
    },
  };
}

/** Run a job with Ctrl-C/SIGTERM wired to a clean cancel. */
async function runCancellable<T>(output: Output, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    output.log('\nCancelling… the file being copied stays at its original location.');
    controller.abort();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    return await task(controller.signal);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

/** Run a cancellable job that reports progress: `task({ signal, onProgress })`. */
export async function runWithProgress<T>(
  values: Pick<CliValues, 'quiet'>,
  output: Output,
  task: (options: ProgressTaskOptions) => Promise<T>,
): Promise<T> {
  const reporter = createProgressReporter(values);
  try {
    return await runCancellable(output, (signal) => task({ signal, onProgress: reporter.update, reporter }));
  } finally {
    reporter.end();
  }
}
