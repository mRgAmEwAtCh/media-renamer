/**
 * Shared progress bookkeeping for apply and undo. `items` need `from`, `to`
 * and `size` (bytes); `onProgress` receives a copy of the state on each change.
 */
export function createProgress(items, onProgress) {
  const state = {
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
      state.current.bytesDone = done;
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
export const stopRequested = ({ signal, stopSignal }) => Boolean(signal?.aborted || stopSignal?.aborted);
