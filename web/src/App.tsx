import { useCallback, useEffect, useRef } from 'react';
import { ActivityPanel } from './components/ActivityPanel.tsx';
import { FileTable, selectedItems } from './components/FileTable.tsx';
import { useFolderPicker } from './components/FolderPicker.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { NamingPanel } from './components/NamingPanel.tsx';
import { SourcePanel } from './components/SourcePanel.tsx';
import { saveLocal } from './local.ts';
import { formFilters } from './settings-form.ts';
import { useActivity } from './hooks/useActivity.ts';
import { useRenamer } from './hooks/useRenamer.ts';
import { useSettings } from './hooks/useSettings.ts';
import { useStatus } from './hooks/useStatus.ts';

const TARGET_FIELDS = {
  tv: { field: 'tvTarget', title: 'Choose the destination for TV shows' },
  movie: { field: 'movieTarget', title: 'Choose the destination for movies' },
} as const;

function Header() {
  return (
    <header>
      <h1>
        <img src="/icon.svg" alt="" width="40" height="40" /> Media Renamer
      </h1>
      <p>Rename movies and TV episodes using TVmaze and TMDB metadata. Everything runs on this computer.</p>
    </header>
  );
}

function Credits() {
  return (
    <footer className="credits">
      <p>
        This product uses the TMDB API but is not endorsed or certified by TMDB. Movie data:{' '}
        <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">
          The Movie Database (TMDB)
        </a>
        . TV data:{' '}
        <a href="https://www.tvmaze.com/" target="_blank" rel="noopener noreferrer">
          TVmaze
        </a>{' '}
        (
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">
          CC BY-SA 4.0
        </a>
        ).
      </p>
    </footer>
  );
}

export function App() {
  const { status, setStatus } = useStatus();
  // The renamer and the activity list need each other; refs connect them after the first render.
  const persistLocal = useRef(() => {});
  const refreshActivity = useRef(() => {});
  const onSettingsLoaded = useCallback(() => persistLocal.current(), []);
  const settings = useSettings(setStatus, onSettingsLoaded);
  const renamer = useRenamer({ form: settings.form, setStatus, onJobDone: () => refreshActivity.current() });
  const activity = useActivity(renamer.rescanIfIdle);
  const { pick, picker } = useFolderPicker();
  const browseButtons = { root: useRef<HTMLButtonElement>(null), tv: useRef<HTMLButtonElement>(null), movie: useRef<HTMLButtonElement>(null) };

  useEffect(() => {
    persistLocal.current = () => saveLocal(renamer.root, renamer.recursive);
    refreshActivity.current = activity.refresh;
  });

  const dirty = settings.dirty;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => dirty && event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function browseRoot() {
    const chosen = await pick(renamer.root.trim(), { title: 'Choose the folder to rename' });
    if (!chosen) return browseButtons.root.current?.focus();
    renamer.setRoot(chosen);
    await renamer.scanFolder({ folder: chosen });
  }

  async function browseTarget(kind: 'tv' | 'movie') {
    const { field, title } = TARGET_FIELDS[kind];
    const chosen = await pick(settings.form[field].trim() || renamer.root.trim(), { title });
    if (chosen) settings.update({ [field]: chosen });
    browseButtons[kind].current?.focus();
  }

  const { busy, scan } = renamer;
  const items = scan.items ?? [];
  const selected = selectedItems(items);

  return (
    <>
      <Header />
      <main>
        <SourcePanel
          root={renamer.root}
          recursive={renamer.recursive}
          form={settings.form}
          busy={busy}
          browseButton={browseButtons.root}
          onRootChange={renamer.setRoot}
          onRecursiveChange={renamer.setRecursive}
          onFiltersChange={(patch) => {
            settings.update(patch);
            if (scan.root && !busy) renamer.scanFolder({ filters: { ...formFilters(settings.form), ...patch } });
          }}
          onBrowse={browseRoot}
          onScan={() => renamer.scanFolder()}
        />
        <NamingPanel settings={settings} busy={busy} browseButtons={browseButtons} onBrowseTarget={browseTarget}>
          <button type="button" disabled={busy || !items.length} onClick={renamer.preview}>
            Preview names
          </button>
          <button type="button" className="primary" disabled={busy || !selected.length || renamer.stale} onClick={renamer.apply}>
            {selected.some((item) => item.target) ? 'Rename & move selected' : 'Rename selected'}
          </button>
          <button type="button" disabled={busy || !scan.root} onClick={renamer.undo}>
            Undo last batch
          </button>
        </NamingPanel>
        <p id="status" role="status" aria-live="polite" className={status.kind}>
          {status.message}
        </p>
        {renamer.job && <JobPanel job={renamer.job} connectionProblem={renamer.connectionProblem} onCancel={renamer.cancelJob} />}
        <ActivityPanel
          jobs={activity.jobs}
          clearing={activity.clearing}
          onClear={activity.clear}
          onCancel={activity.cancel}
          onOpenFolder={(folder) => {
            renamer.setRoot(folder);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            renamer.scanFolder({ folder });
          }}
        />
        <FileTable items={scan.items} version={scan.version} onChange={renamer.setItems} />
      </main>
      <Credits />
      {picker}
    </>
  );
}
