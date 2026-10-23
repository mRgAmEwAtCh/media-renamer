import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DirectoryListing, PlacesResponse } from '../../../lib/api-types.ts';
import { api, errorMessage } from '../api.ts';

const ICONS: Record<string, string> = { home: '⌂', folder: '▸', drive: '⛁', volume: '⏏' };

export interface PickRequest {
  initialPath: string;
  title: string;
  resolve: (path: string | null) => void;
}

function Breadcrumbs({ listing, onOpen }: { listing: DirectoryListing; onOpen: (path: string) => void }) {
  const { breadcrumbs, separator } = listing;
  return breadcrumbs.map((crumb, index) => (
    <Fragment key={crumb.path}>
      {index > 0 && !breadcrumbs[index - 1].label.endsWith(separator) && (
        <span className="sep" aria-hidden="true">
          {separator}
        </span>
      )}
      <button type="button" onClick={() => onOpen(crumb.path)} aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}>
        {crumb.label}
      </button>
    </Fragment>
  ));
}

/** Arrow keys, Home and End move between folders; Backspace goes up (`goUp` is null at the top). */
function moveFocus(event: KeyboardEvent<HTMLUListElement>, goUp: (() => void) | null) {
  if (event.key === 'Backspace' && goUp) {
    event.preventDefault();
    goUp();
    return;
  }
  const steps: Record<string, (index: number, last: number) => number> = {
    ArrowDown: (index) => index + 1,
    ArrowUp: (index) => index - 1,
    Home: () => 0,
    End: (_index, last) => last,
  };
  if (!Object.hasOwn(steps, event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll('button')];
  const next = steps[event.key](buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length - 1);
  buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  event.preventDefault();
}

/**
 * The folder browser dialog. The server lists folders, because browsers don't
 * reveal the real path of a folder picked with a file input.
 */
export function FolderPicker({ request, onDone }: { request: PickRequest | null; onDone: (path: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const folderList = useRef<HTMLUListElement>(null);
  const [places, setPlaces] = useState<PlacesResponse | null>(null);
  const [current, setCurrentState] = useState<DirectoryListing | null>(null);
  const currentRef = useRef<DirectoryListing | null>(null);
  const setCurrent = (listing: DirectoryListing) => {
    currentRef.current = listing;
    setCurrentState(listing);
  };
  const [pathText, setPathText] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const requestId = useRef(0);
  const focusFirst = useRef(false);

  const navigate = useCallback(
    async (target: string, { fallback, hidden = showHidden }: { fallback?: string; hidden?: boolean } = {}): Promise<void> => {
      const id = ++requestId.current;
      setError('');
      setBusy(true);
      try {
        const listing = await api('/api/browse', { path: target, showHidden: hidden });
        if (id !== requestId.current) return;
        focusFirst.current = true;
        setCurrent(listing);
        setPathText(listing.path);
        setNote(null);
      } catch (failure) {
        if (id !== requestId.current) return;
        if (fallback) return navigate(fallback, { hidden });
        setError(errorMessage(failure));
        if (currentRef.current) setPathText(currentRef.current.path);
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    },
    [showHidden],
  );

  useEffect(() => {
    if (!focusFirst.current) return;
    focusFirst.current = false;
    folderList.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [current]);

  // Open the dialog for each new request.
  useEffect(() => {
    if (!request) return;
    setError('');
    if (!dialog.current?.open) dialog.current?.showModal();
    (async () => {
      try {
        const known = places ?? (await api('/api/places', {}));
        setPlaces(known);
        const home = known.places[0]?.path ?? '/';
        await navigate(request.initialPath || current?.path || home, { fallback: home });
      } catch (failure) {
        setError(errorMessage(failure));
      }
    })();
    // Only a new request opens the dialog; places and current are read as they are then.
  }, [request]);

  const finish = (path: string | null) => {
    if (dialog.current?.open) dialog.current.close();
    onDone(path);
  };

  async function openSystemDialog() {
    setError('');
    setNote('Waiting for the system folder dialog…');
    setBusy(true);
    try {
      const result = await api('/api/pick-folder', { start: current?.path ?? '' });
      if (result.path) return finish(result.path);
      setNote('System dialog cancelled.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const goUp = current?.parent ? () => navigate(current.parent!) : null;
  const media = current ? (current.mediaFiles === 1 ? '1 media file' : `${current.mediaFiles} media files`) : '';
  const info = note ?? (current ? `${media} directly in this folder${current.truncated ? ' · folder list truncated' : ''}` : '');

  return (
    <dialog ref={dialog} id="picker" aria-labelledby="pickerTitle" aria-busy={busy} onCancel={() => finish(null)}>
      <div className="picker">
        <header className="picker-head">
          <h2 id="pickerTitle">{request?.title ?? 'Choose a folder'}</h2>
          <button type="button" className="icon" aria-label="Close" onClick={() => finish(null)}>
            ✕
          </button>
        </header>
        <div className="picker-bar">
          <button type="button" aria-label="Parent folder" title="Parent folder (Backspace)" disabled={busy || !goUp} onClick={() => goUp?.()}>
            ↑
          </button>
          <input
            type="text"
            aria-label="Folder path (press Enter to open)"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            value={pathText}
            onChange={(event) => setPathText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              navigate(pathText);
            }}
          />
        </div>
        <nav className="crumbs" aria-label="Current location">
          {current && <Breadcrumbs listing={current} onOpen={navigate} />}
        </nav>
        <p className="picker-error" role="alert">
          {error}
        </p>
        <div className="picker-body">
          <ul className="places" aria-label="Places">
            {places?.places.map((place) => (
              <li key={place.path}>
                <button type="button" title={place.path} onClick={() => navigate(place.path)}>
                  {`${ICONS[place.kind] ?? '▸'} ${place.label}`}
                </button>
              </li>
            ))}
          </ul>
          <ul ref={folderList} className="folders" aria-label="Subfolders" onKeyDown={(event) => moveFocus(event, goUp)}>
            {current?.folders.length === 0 && <li className="empty">No subfolders</li>}
            {current?.folders.map((folder) => (
              <li key={folder.path}>
                <button type="button" className="folder" onClick={() => navigate(folder.path)}>
                  {`📁 ${folder.name}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <footer className="picker-foot">
          <span className="hint" aria-live="polite">
            {info}
          </span>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => {
                setShowHidden(event.target.checked);
                if (current) navigate(current.path, { hidden: event.target.checked });
              }}
            />{' '}
            Show hidden
          </label>
          <button type="button" hidden={!places?.nativeDialog} disabled={busy} onClick={openSystemDialog}>
            System dialog…
          </button>
          <button type="button" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => current && finish(current.path)}>
            Select this folder
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/** `pick(initialPath, { title })` opens the folder browser and resolves with the chosen folder, or null. */
export function useFolderPicker() {
  const [request, setRequest] = useState<PickRequest | null>(null);
  const pick = useCallback(
    (initialPath: string, { title = 'Choose a folder' }: { title?: string } = {}) =>
      new Promise<string | null>((resolve) => setRequest({ initialPath, title, resolve })),
    [],
  );
  const onDone = useCallback(
    (path: string | null) => {
      request?.resolve(path);
      setRequest(null);
    },
    [request],
  );
  return { pick, picker: <FolderPicker request={request} onDone={onDone} /> };
}
