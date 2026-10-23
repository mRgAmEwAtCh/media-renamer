import { useCallback, useState } from 'react';

export type StatusKind = '' | 'error' | 'success';
export type SetStatus = (message: string, kind?: StatusKind) => void;

/** The status line under the action buttons. */
export function useStatus() {
  const [status, setState] = useState<{ message: string; kind: StatusKind }>({ message: '', kind: '' });
  const setStatus: SetStatus = useCallback((message, kind = '') => setState({ message, kind }), []);
  return { status, setStatus };
}
