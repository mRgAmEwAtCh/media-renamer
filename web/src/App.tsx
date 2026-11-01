import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobSnapshot } from '../../lib/types.ts';
import { api, errorMessage } from './api.ts';
import { ActivityPanel } from './components/ActivityPanel.tsx';
import { FileTable } from './components/FileTable.tsx';
import { useFolderPicker } from './components/FolderPicker.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { NamingPanel } from './components/NamingPanel.tsx';
import { ReviewInbox } from './components/ReviewInbox.tsx';
import { SourcePanel } from './components/SourcePanel.tsx';
import { useUnsavedSettings } from './components/UnsavedSettings.tsx';
import { saveLocal } from './local.ts';
import { selectedItems } from './items.ts';
import { jobsToReview, readReviewed, saveReviewed } from './review.ts';
import { useRoute, type View } from './route.ts';
import { requestedTargets, type SettingsForm } from './settings-form.ts';
import { isActive, useActivity } from './hooks/useActivity.ts';
import { useRenamer } from './hooks/useRenamer.ts';
import { useSettings } from './hooks/useSettings.ts';
import { useStatus } from './hooks/useStatus.ts';

const TARGET_FIELDS = {
  tv: { field: 'tvTarget', title: 'Choose the destination for TV shows' },
  movie: { field: 'movieTarget', title: 'Choose the destination for movies' },
} as const;

const TABS: [View, string][] = [
  ['rename', 'Rename'],
  ['activity', 'Activity'],
  ['settings', 'Settings'],
];

/** A counter (or a dot when `count` is absent) next to a tab; `label` is read out and shown on hover. */
interface Badge {
  count?: number;
  label: string;
  tone: 'warn' | 'accent';
}

function Header({ view, badges, onNavigate }: { view: View; badges: Partial<Record<View, Badge[]>>; onNavigate: (view: View) => void }) {
  return (
    <header>
      <h1>
        <img src="/icon.svg" alt="" width="32" height="32" /> Media Renamer
      </h1>
      <nav aria-label="Views">
        {TABS.map(([value, label]) => (
          <a
            key={value}
            href={`#/${value}`}
            aria-current={view === value ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(value);
            }}
          >
            {label}
            {badges[value]?.map((badge) => (
              <span key={badge.label} className={`tab-badge ${badge.tone}${badge.count === undefined ? ' dot' : ''}`} title={badge.label}>
                <span aria-hidden="true">{badge.count}</span>
                <span className="visually-hidden">{badge.label}</span>
              </span>
            ))}
          </a>
        ))}
      </nav>
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

/** Where renamed files go with the current settings, with a link to change them. */
function SettingsSummary({ form, dirty, onEdit }: { form: SettingsForm; dirty: boolean; onEdit: () => void }) {
  const targets = requestedTargets(form);
  const where = (target: string | null) => target ?? 'renamed in place';
  const text = form.move ? `TV shows → ${where(targets.episode)} · Movies → ${where(targets.movie)}` : 'Files are renamed in place';
  return (
    <p className="settings-summary hint">
      <span>{`${text}${form.language ? ` · ${form.language}` : ''}`}</span>
      {dirty && <span className="dirty"> · unsaved changes</span>}{' '}
      <button type="button" className="link" onClick={onEdit}>
        Change in Settings
      </button>
    </p>
  );
}

export function App() {
  const { status, setStatus } = useStatus();
  // The renamer and the activity list need each other; refs connect them after the first render.
  const persistLocal = useRef(() => {});
  const refreshActivity = useRef(() => {});
  const onSettingsLoaded = useCallback(() => persistLocal.current(), []);
  const settings = useSettings(setStatus, onSettingsLoaded);
  const [reviewed, setReviewed] = useState(readReviewed);
  const markReviewed = useCallback((id: string) => {
    setReviewed((current) => {
      const next = new Set(current).add(id);
      saveReviewed(next);
      return next;
    });
  }, []);
  const renamer = useRenamer({ form: settings.form, setStatus, onJobDone: () => refreshActivity.current(), onReviewed: markReviewed });
  const activity = useActivity(renamer.rescanIfIdle);
  const { pick, picker } = useFolderPicker();
  const { confirmSettings, dialog } = useUnsavedSettings(settings);
  const browseButtons = { root: useRef<HTMLButtonElement>(null), tv: useRef<HTMLButtonElement>(null), movie: useRef<HTMLButtonElement>(null) };

  const beforeLeave = useCallback(
    async (from: View) => from !== 'settings' || (await confirmSettings('You changed settings without saving them. Save them before leaving Settings?')) !== null,
    [confirmSettings],
  );
  const { route, navigate, settle } = useRoute(beforeLeave);

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

  // After opening files to review, bring the first one that needs a decision into view.
  const focusPending = useRef(false);
  const { version } = renamer.scan;
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    const row = document.querySelector<HTMLElement>('#rows tr.status-conflict, #rows tr.status-warning, #rows tr.status-error') ?? document.querySelector<HTMLElement>('#rows tr');
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.querySelector<HTMLElement>('.conflict-actions button, textarea')?.focus({ preventScroll: true });
  }, [version]);

  /** Unsaved naming settings would make the preview differ from what imports do: settle them first. */
  const previewSettings = () => confirmSettings('The preview would use settings that are not saved. Save them first?', { previewOnly: true });

  async function startReview(job: JobSnapshot) {
    if (renamer.busy || !confirmReplacingRows()) return;
    const form = await previewSettings();
    if (!form) return;
    if (route.view !== 'rename') navigate('rename');
    focusPending.current = true;
    if (!(await renamer.reviewJob(job, form))) focusPending.current = false;
  }

  async function preview() {
    if (renamer.busy || !confirmReplacingRows()) return;
    const form = await previewSettings();
    if (form) await renamer.preview(form);
  }

  function confirmReplacingRows() {
    return !renamer.hasPendingEdits() || confirm('Replace your edited names, selections and conflict decisions with a new preview?');
  }

  async function scanAndPreview(folder = renamer.root) {
    if (renamer.busy || !settings.loaded || !confirmReplacingRows()) return;
    const form = await previewSettings();
    if (form) await renamer.scanFolder({ folder, settings: form });
  }

  // A link to `#/review/<job>` (from a notification) opens that job's files once the settings are loaded.
  const { reviewJob } = route;
  const { loaded } = settings;
  const startReviewRef = useRef(startReview);
  useEffect(() => {
    startReviewRef.current = startReview;
  });
  useEffect(() => {
    if (!reviewJob || !loaded) return;
    settle();
    api('/api/jobs', {})
      .then(({ jobs }) => {
        const job = jobs.find((candidate) => candidate.id === reviewJob);
        if (job) return startReviewRef.current(job);
        setStatus('That import is no longer in the history.', 'error');
      })
      .catch((error: unknown) => setStatus(errorMessage(error), 'error'));
  }, [reviewJob, loaded, settle, setStatus]);

  async function browseRoot() {
    const chosen = await pick(renamer.root.trim(), { title: 'Choose the folder to rename' });
    if (!chosen) return browseButtons.root.current?.focus();
    renamer.setRoot(chosen);
    await scanAndPreview(chosen);
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
  const toReview = jobsToReview(activity.jobs, reviewed);
  const running = activity.jobs.filter(isActive).length;
  const activityBadges: Badge[] = [];
  if (running) activityBadges.push({ label: `${running} running`, tone: 'accent' });
  if (toReview.length) activityBadges.push({ count: toReview.length, label: `${toReview.length} to review`, tone: 'warn' });
  const badges: Partial<Record<View, Badge[]>> = {
    activity: activityBadges,
    ...(dirty && { settings: [{ label: 'Unsaved changes', tone: 'warn' }] }),
  };
  const statusLine = (
    <p id="status" role="status" aria-live="polite" className={status.kind}>
      {status.message}
    </p>
  );

  return (
    <>
      <Header view={route.view} badges={badges} onNavigate={navigate} />
      <main>
        {route.view === 'rename' && (
          <>
            <ReviewInbox
              jobs={toReview}
              busy={busy}
              current={scan.review && { jobId: scan.review.jobId, files: scan.review.files.length }}
              onReview={startReview}
              onDismiss={(job) => {
                markReviewed(job.id);
                if (scan.review?.jobId === job.id) renamer.closeReview(false);
              }}
            />
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
              }}
              onBrowse={browseRoot}
              onScan={() => scanAndPreview()}
            >
              <SettingsSummary form={settings.form} dirty={dirty} onEdit={() => navigate('settings')} />
            </SourcePanel>
            {renamer.job && <JobPanel job={renamer.job} connectionProblem={renamer.connectionProblem} onCancel={renamer.cancelJob} />}
            <FileTable
              items={scan.items}
              version={scan.version}
              busy={busy}
              review={scan.review}
              onChange={renamer.setItems}
              onKeepBoth={renamer.keepBoth}
              onKeepBothAll={renamer.keepBothAll}
              onCloseReview={renamer.closeReview}
              actions={
                <>
                  <div className="row">
                    <button type="button" disabled={busy || !items.length} onClick={preview}>
                      {scan.previewed ? 'Preview again' : 'Retry preview'}
                    </button>
                    <button type="button" className="primary" disabled={busy || !selected.length || renamer.stale} onClick={renamer.apply}>
                      {`${selected.some((item) => item.target && item.resolution !== 'remove') ? 'Rename & move' : 'Rename'} ${selected.length ? `${selected.length} ` : ''}selected`}
                    </button>
                    <button type="button" disabled={busy || !scan.root} onClick={renamer.undo}>
                      Undo last batch
                    </button>
                  </div>
                  {statusLine}
                </>
              }
            />
          </>
        )}
        {route.view === 'activity' && (
          <ActivityPanel
            jobs={activity.jobs}
            reviewed={reviewed}
            clearing={activity.clearing}
            onClear={activity.clear}
            onCancel={activity.cancel}
            onRemove={activity.remove}
            removed={activity.removed}
            onUndoRemove={activity.undoRemove}
            onReview={startReview}
            onOpenFolder={(folder) => {
              navigate('rename');
              renamer.setRoot(folder);
              renamer.scanFolder({ folder });
            }}
          />
        )}
        {route.view === 'settings' && (
          <>
            <NamingPanel settings={settings} busy={busy} browseButtons={browseButtons} onBrowseTarget={browseTarget} />
            {statusLine}
          </>
        )}
        {route.view === 'activity' && statusLine}
      </main>
      <Credits />
      {picker}
      {dialog}
    </>
  );
}
