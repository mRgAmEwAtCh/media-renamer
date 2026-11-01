import { useCallback, useEffect, useState } from 'react';

export type View = 'rename' | 'activity' | 'settings';

export interface Route {
  view: View;
  /** `#/review/<id>`: open the files of that job that need review. */
  reviewJob: string | null;
}

const VIEWS: ReadonlySet<string> = new Set(['rename', 'activity', 'settings']);

export function parseRoute(hash: string): Route {
  const [, first = '', second = ''] = hash.replace(/^#/, '').split('/');
  if (first === 'review' && second) return { view: 'rename', reviewJob: decodeURIComponent(second) };
  return { view: VIEWS.has(first) ? (first as View) : 'rename', reviewJob: null };
}

/**
 * The view in the address bar, so Back works and notifications can link to a
 * view. `beforeLeave(from, to)` may veto a change (e.g. unsaved settings);
 * navigation then returns to the view that was shown.
 */
export function useRoute(beforeLeave: (from: View, to: View) => Promise<boolean>) {
  const [route, setRoute] = useState(() => parseRoute(location.hash));

  useEffect(() => {
    let shown = parseRoute(location.hash);
    const onChange = async () => {
      const next = parseRoute(location.hash);
      if (next.view !== shown.view && !(await beforeLeave(shown.view, next.view))) {
        history.replaceState(null, '', `#/${shown.view}`);
        return;
      }
      shown = next;
      setRoute(next);
    };
    window.addEventListener('hashchange', onChange);
    // A notification clicked while this page is open (see sw.js).
    const onMessage = (event: MessageEvent) => {
      const url = (event.data as { type?: string; url?: string } | null)?.type === 'open' ? (event.data as { url: string }).url : null;
      if (url) location.hash = new URL(url, location.origin).hash || '#/rename';
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    navigator.serviceWorker?.startMessages();
    return () => {
      window.removeEventListener('hashchange', onChange);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [beforeLeave]);

  const navigate = useCallback((view: View) => {
    location.hash = `#/${view}`;
  }, []);

  /** Leave `#/review/<id>` once handled, without a history entry. */
  const settle = useCallback(() => {
    history.replaceState(null, '', '#/rename');
    setRoute({ view: 'rename', reviewJob: null });
  }, []);

  return { route, navigate, settle };
}
