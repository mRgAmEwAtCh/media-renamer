import type { AudioPlan, Progress, ProgressListener } from '../types.ts';

/** A file being moved, as far as progress reporting cares. */
export interface ProgressItem {
  from: string;
  to: string;
  size: number;
  audio?: AudioPlan | null;
}

export interface ProgressTracker {
  state: Progress;
  start(item: ProgressItem): void;
  bytes(done: number): void;
  finish(item: ProgressItem): void;
}

/**
 * Shared progress bookkeeping for apply and undo. `items` need `from`, `to`
 * and `size` (bytes); `onProgress` receives a copy of the state on each change.
 */
export function createProgress(items: readonly ProgressItem[], onProgress?: ProgressListener): ProgressTracker {
  const state: Progress = {
    filesTotal: items.length,
    filesDone: 0,
    bytesTotal: items.reduce((sum, item) => sum + item.size, 0),
    bytesDone: 0,
    current: null,
  };
  const emit = () => onProgress?.({ ...state, current: state.current && { ...state.current } });
  return {
    state,
    start(item) {
      state.current = { from: item.from, to: item.to, bytesDone: 0, bytesTotal: item.size, phase: item.audio ? 'converting' : 'moving' };
      emit();
    },
    bytes(done) {
      state.current!.bytesDone = done;
      emit();
    },
    finish(item) {
      state.filesDone += 1;
      state.bytesDone += item.size;
      state.current = null;
      emit();
    },
  };
}

/** True once either signal asks the job to stop. */
export const stopRequested = ({ signal, stopSignal }: { signal?: AbortSignal; stopSignal?: AbortSignal }): boolean => Boolean(signal?.aborted || stopSignal?.aborted);
