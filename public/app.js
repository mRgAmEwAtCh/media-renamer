import { startActivity } from './activity.js';
import { api } from './api.js';
import { $, setStatus } from './dom.js';
import { createFileTable, itemsFromScan } from './file-table.js';
import { closeJobPanel, openJobPanel, reportJob, showConnectionProblem, showJob } from './job-panel.js';
import { setupNotifications } from './notify.js';
import { createFolderPicker } from './picker.js';
import {
  formFilters,
  isDirty,
  loadServerSettings,
  previewOptions,
  readLocal,
  requestedTargets,
  resetDefaults,
  saveDefaults,
  saveLocal,
  syncTargetFields,
  updateDefaultsStatus,
} from './settings-form.js';
import { selectedItems, state } from './state.js';

const ACTIVE_STATES = ['queued', 'running', 'cancelling'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameTargets = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const targetChangedSincePreview = () => state.previewed && !sameTargets(requestedTargets(), state.previewTargets);

function updateButtons() {
  const selected = selectedItems();
  const stale = targetChangedSincePreview();
  for (const id of ['scan', 'browse', 'browseTvTarget', 'browseMovieTarget']) $(id).disabled = state.busy;
  $('preview').disabled = state.busy || !state.items.length;
  $('apply').disabled = state.busy || !selected.length || stale;
  $('apply').textContent = selected.some((item) => item.target) ? 'Rename & move selected' : 'Rename selected';
  $('undo').disabled = state.busy || !state.root;
  updateDefaultsStatus();
  if (stale && !state.busy) setStatus('Destinations changed — preview again before renaming.', 'error');
}

const table = createFileTable({ onChange: updateButtons });

/** Run a task with the buttons disabled; its error goes to the status line. */
async function run(message, task) {
  state.busy = true;
  updateButtons();
  setStatus(message);
  try {
    await task();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    state.busy = false;
    updateButtons();
  }
}

/* ---------- Scan and preview ---------- */

function showScan(data) {
  Object.assign(state, { root: data.root, previewed: false, previewTargets: null, items: itemsFromScan(data.files) });
  table.render();
}

function describeExcluded(excluded = {}) {
  const parts = [];
  if (excluded.samples) parts.push(`${excluded.samples} sample`);
  if (excluded.nonVideo) parts.push(`${excluded.nonVideo} non-video`);
  return parts.length ? ` Skipped ${parts.join(' and ')} file(s).` : '';
}

async function scan() {
  saveLocal();
  await run('Scanning…', async () => {
    const data = await api('/api/scan', { root: $('root').value.trim(), recursive: $('recursive').checked, ...formFilters() });
    showScan(data);
    setStatus(
      `Found ${data.files.length} media file(s)${data.truncated ? ' (list truncated)' : ''}.${describeExcluded(data.excluded)} Click “Preview names”.`,
    );
  });
}

async function rescan() {
  showScan(await api('/api/scan', { root: state.root, recursive: $('recursive').checked, ...formFilters() }));
}

async function preview() {
  const targets = requestedTargets();
  if ($('moveEnabled').checked && !targets.episode && !targets.movie) {
    setStatus('Choose a destination for TV shows and/or movies, or untick “Move renamed files”.', 'error');
    return;
  }
  await run('Looking up metadata…', async () => {
    const data = await api('/api/preview', { root: state.root, targets, files: state.items.map((item) => item.rel), ...previewOptions() });
    Object.assign(state, { previewTargets: targets, previewed: true, items: data.items.map((item) => ({ ...item, selected: item.status === 'ok' })) });
    table.render();
    const ready = state.items.filter((item) => item.selected);
    const moving = ['episode', 'movie']
      .map((kind) => [kind, ready.filter((item) => item.kind === kind && item.target).length])
      .filter(([, count]) => count)
      .map(([kind, count]) => `${count} to ${data.targets[kind]}`);
    setStatus(`${ready.length} file(s) ready${moving.length ? ` (moving ${moving.join(', ')})` : ''}. Review warnings before selecting them.`);
  });
}

/* ---------- Rename, undo and job progress ---------- */

/** Show a server-side job until it ends; survives page reloads and brief disconnects. */
async function followJob(job) {
  Object.assign(state, { busy: true, jobId: job.id });
  openJobPanel();
  setStatus('');
  updateButtons();
  showJob(job);
  while (ACTIVE_STATES.includes(job.state)) {
    await sleep(700);
    try {
      const latest = (await api('/api/job', { id: job.id })).job;
      if (!latest) break; // The server restarted; the undo log keeps what was done.
      job = latest;
      showJob(job);
    } catch (error) {
      showConnectionProblem(error);
      await sleep(2000);
    }
  }
  closeJobPanel();
  Object.assign(state, { busy: false, jobId: null });
  if (job.result || job.state === 'failed') reportJob(job);
  else setStatus('The server restarted during the job. Completed moves are in the undo log.', 'error');
  if (state.root) await rescan().catch(() => {});
  activity.refresh();
  updateButtons();
}

/** Start a job on the server and follow it; errors starting it go to the status line. */
async function startJob(path, body) {
  try {
    await followJob(await api(path, body));
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function apply() {
  const selected = selectedItems();
  const renames = selected.map((item) => ({ from: item.rel, to: item.newRel, target: item.target ?? null }));
  const byTarget = Object.entries(Object.groupBy(selected, (item) => item.target ?? '')).map(([target, list]) =>
    target ? `${list.length} into ${target}` : `${list.length} in place`,
  );
  if (!renames.length || !confirm(`Rename ${renames.length} file(s): ${byTarget.join(', ')}?`)) return;
  await startJob('/api/apply', { root: state.root, renames });
}

async function undo() {
  if (!confirm('Undo the last rename batch in this folder?')) return;
  await startJob('/api/undo', { root: state.root });
}

async function cancelJob() {
  if (!state.jobId || !confirm('Cancel? The file being copied stays where it was; completed files can be undone.')) return;
  try {
    showJob((await api('/api/job/cancel', { id: state.jobId })).job);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

/** Re-attach the progress panel to a rename/undo started from this UI; imports show in Activity. */
async function resumeRunningJob() {
  try {
    const { job } = await api('/api/job', {});
    if (job && job.source === 'web UI' && ACTIVE_STATES.includes(job.state)) {
      state.root = job.root;
      await followJob(job);
    }
  } catch {
    // No job information available; nothing to resume.
  }
}

setupNotifications(api).catch((error) => console.warn(`Notifications unavailable: ${error.message}`));

const activity = startActivity({
  api,
  onOpenFolder: (folder) => {
    $('root').value = folder;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    scan();
  },
  // An import may have moved files out of the folder shown in the table.
  onChange: () => state.root && !state.busy && rescan().catch(() => {}),
});

/* ---------- Wiring ---------- */

const pickFolder = createFolderPicker({ api });

$('browse').addEventListener('click', async () => {
  const chosen = await pickFolder($('root').value.trim(), { title: 'Choose the folder to rename' });
  if (!chosen) return $('browse').focus();
  $('root').value = chosen;
  await scan();
});
for (const [button, field, title] of [
  ['browseTvTarget', 'tvTarget', 'Choose the destination for TV shows'],
  ['browseMovieTarget', 'movieTarget', 'Choose the destination for movies'],
]) {
  $(button).addEventListener('click', async () => {
    const chosen = await pickFolder($(field).value.trim() || $('root').value.trim(), { title });
    if (chosen) {
      $(field).value = chosen;
      updateButtons();
    }
    $(button).focus();
  });
}
$('moveEnabled').addEventListener('change', () => {
  syncTargetFields();
  updateButtons();
});
for (const id of ['tvTarget', 'movieTarget', 'episodePattern', 'moviePattern', 'language', 'region', 'audioLanguages']) {
  $(id).addEventListener('input', updateButtons);
}
for (const id of ['autoEnabled', 'autoWarnings', 'autoCleanup', 'audioFixEnabled', 'audioFixEpisodes', 'audioBitrate']) {
  $(id).addEventListener('change', updateButtons);
}
for (const id of ['videoOnly', 'excludeSamples']) {
  $(id).addEventListener('change', () => {
    updateButtons();
    if (state.root && !state.busy) scan();
  });
}
$('recursive').addEventListener('change', saveLocal);
$('scan').addEventListener('click', scan);
$('root').addEventListener('keydown', (event) => event.key === 'Enter' && scan());
$('preview').addEventListener('click', preview);
$('apply').addEventListener('click', apply);
$('undo').addEventListener('click', undo);
$('jobCancel').addEventListener('click', cancelJob);
$('saveDefaults').addEventListener('click', saveDefaults);
$('resetDefaults').addEventListener('click', resetDefaults);
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) event.preventDefault();
});

const local = readLocal();
$('root').value = local.root ?? '';
$('recursive').checked = local.recursive ?? true;
syncTargetFields();
updateButtons();
loadServerSettings().then(updateButtons);
resumeRunningJob();
