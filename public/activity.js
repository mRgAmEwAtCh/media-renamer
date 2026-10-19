const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
};

const STATE_LABEL = {
  queued: 'Waiting',
  running: 'Running',
  cancelling: 'Cancelling',
  finished: 'Finished',
  cancelled: 'Cancelled',
  failed: 'Failed',
  interrupted: 'Interrupted',
};
const STEP_ICON = { pending: '○', running: '◐', done: '✓', skipped: '–', failed: '✗', stopped: '■' };
const OUTCOME_LABEL = {
  pending: 'Waiting',
  moved: 'Moved',
  converted: 'Audio added + moved',
  review: 'Needs review',
  unchanged: 'Already named correctly',
  failed: 'Failed',
  'not processed': 'Not processed',
};
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

function title(job) {
  if (job.kind === 'import') return `Import: ${job.label ?? job.params?.path ?? ''}`;
  return job.label ?? (job.kind === 'undo' ? 'Undo last batch' : 'Rename');
}

function summary(job) {
  const r = job.result;
  if (job.state === 'queued') return `Waiting in queue${job.queuePosition ? ` (position ${job.queuePosition})` : ''}`;
  if (job.state === 'failed') return job.error ?? 'Failed';
  if (!r) return job.note ?? '';
  if (job.kind === 'import') {
    const parts = [`${r.imported} imported`];
    if (r.converted) parts.push(`${r.converted} with new audio`);
    if (r.review) parts.push(`${r.review} need review`);
    if (r.failed) parts.push(`${r.failed} failed`);
    return parts.join(' · ');
  }
  if (job.kind === 'undo') return `${r.restored} restored${r.skipped?.length ? ` · ${r.skipped.length} skipped` : ''}`;
  return `${r.renamed} renamed${r.failed?.length ? ` · ${r.failed.length} failed` : ''}`;
}

function progressBlock(job) {
  const p = job.progress;
  if (job.state !== 'running' || !p?.current) return null;
  const done = p.bytesDone + p.current.bytesDone;
  const percent = p.bytesTotal ? Math.floor((done / p.bytesTotal) * 100) : 0;
  const phase = p.current.phase === 'converting' ? 'Converting audio' : 'Moving';
  return element(
    'div',
    { className: 'activity-progress' },
    element('progress', { max: p.bytesTotal || 1, value: done }),
    element(
      'p',
      { className: 'hint' },
      `${phase}: file ${p.filesDone + 1} of ${p.filesTotal} · ${percent}% · ${formatBytes(done)} of ${formatBytes(p.bytesTotal)}`,
    ),
    element('p', { className: 'path job-current' }, `${p.current.from} → ${p.current.to}`),
  );
}

function stepsBlock(job) {
  if (!job.steps?.length) return null;
  return element(
    'ol',
    { className: 'steps' },
    ...job.steps.map((step) =>
      element(
        'li',
        { className: `step step-${step.state}` },
        element('span', { className: 'step-icon', ariaHidden: 'true' }, STEP_ICON[step.state] ?? '○'),
        element('span', { className: 'step-label' }, step.label),
        step.detail ? element('span', { className: 'step-detail' }, ` — ${step.detail}`) : null,
      ),
    ),
  );
}

function filesBlock(job, onOpenFolder) {
  if (!job.files?.length) return null;
  const reviewFolders = [
    ...new Set(job.files.filter((f) => f.outcome === 'review').map((f) => `${job.root}/${f.rel}`.replace(/\/[^/]*$/, ''))),
  ];
  const count = job.fileCount ?? job.files.length;
  return element(
    'details',
    { className: 'activity-files', open: job.files.some((f) => f.outcome === 'review' || f.outcome === 'failed') },
    element('summary', {}, `${count} file${count === 1 ? '' : 's'}`),
    element(
      'ul',
      {},
      ...job.files.map((file) =>
        element(
          'li',
          { className: `outcome-${file.outcome.replace(' ', '-')}` },
          element('span', { className: 'outcome' }, OUTCOME_LABEL[file.outcome] ?? file.outcome),
          element('span', { className: 'path' }, file.rel),
          file.newRel && ['moved', 'converted', 'pending'].includes(file.outcome)
            ? element('span', { className: 'path hint' }, `→ ${file.target ? `${file.target}/` : ''}${file.newRel}`)
            : null,
          file.match || file.message ? element('span', { className: 'hint' }, [file.match, file.message].filter(Boolean).join(' — ')) : null,
          file.audio ? element('span', { className: 'hint' }, `Audio: ${file.audio}`) : null,
        ),
      ),
    ),
    ...reviewFolders.map((folder) =>
      element('button', { type: 'button', className: 'link', onclick: () => onOpenFolder(folder) }, `Open ${folder} in the renamer`),
    ),
  );
}

/**
 * The Activity panel: queued, running and recent jobs (manual renames and
 * automatic imports), with step timelines, progress and per-file results.
 */
export function startActivity({ api, onOpenFolder, onChange }) {
  const list = document.getElementById('activityList');
  const empty = document.getElementById('activityEmpty');
  let timer = null;
  let lastActive = false;

  function render(jobs) {
    empty.hidden = jobs.length > 0;
    list.replaceChildren(
      ...jobs.map((job) => {
        const cancel = ACTIVE.has(job.state) && job.state !== 'cancelling'
          ? element('button', {
              type: 'button',
              onclick: async () => {
                const message = job.state === 'queued' ? 'Remove this job from the queue?' : 'Cancel? The file in progress stays where it was; finished files can be undone.';
                if (confirm(message)) await api('/api/job/cancel', { id: job.id }).then(refresh, () => {});
              },
            }, job.state === 'queued' ? 'Remove' : 'Cancel')
          : null;
        return element(
          'li',
          { className: `activity-item state-${job.state}` },
          element(
            'div',
            { className: 'activity-head' },
            element('strong', {}, title(job)),
            element('span', { className: `badge badge-${job.state}` }, STATE_LABEL[job.state] ?? job.state),
            element('span', { className: 'hint' }, `${job.source === 'hook' ? 'via hook' : job.source ?? ''} · ${day(job.queuedAt)} ${time(job.startedAt ?? job.queuedAt)}`),
            cancel,
          ),
          element('p', { className: 'activity-summary' }, summary(job)),
          job.note && job.state !== 'queued' ? element('p', { className: 'hint' }, job.note) : null,
          progressBlock(job),
          stepsBlock(job),
          filesBlock(job, onOpenFolder),
        );
      }),
    );
  }

  async function refresh() {
    try {
      const { jobs } = await api('/api/jobs', {});
      render(jobs);
      const active = jobs.some((job) => ACTIVE.has(job.state));
      if (lastActive && !active) onChange?.();
      lastActive = active;
      schedule(active ? 1500 : 8000);
    } catch {
      schedule(10000);
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(refresh, document.hidden ? Math.max(ms, 10000) : ms);
  }

  document.addEventListener('visibilitychange', () => !document.hidden && refresh());
  refresh();
  return { refresh };
}
