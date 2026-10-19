import { startActivity } from './activity.js';
import { setupNotifications } from './notify.js';
import { createFolderPicker } from './picker.js';
import { breakable, fitHeight } from './text.js';

const $ = (id) => document.getElementById(id);
// The browser only remembers the last source folder; everything else is saved on the server.
const LOCAL_KEY = 'media-renamer:settings';
const RENAMABLE = new Set(['ok', 'warning', 'edited']);
const KIND_LABEL = { episode: 'TV', movie: 'Movies' };

const state = {
  root: '',
  previewed: false,
  previewTargets: null, // destinations requested for the current preview
  items: [],
  busy: false,
  jobId: null,
  savedSnapshot: null, // form settings as last loaded from / saved to the server
  serverSaved: false,
  savedAt: null,
};

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) location.href = '/login';
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function setStatus(message, kind = '') {
  const status = $('status');
  status.textContent = message;
  status.className = kind;
}

/* ---------- Settings: form <-> server ---------- */

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ root: $('root').value.trim(), recursive: $('recursive').checked }));
}

function formSettings() {
  return {
    patterns: { episode: $('episodePattern').value, movie: $('moviePattern').value },
    targets: { episode: $('tvTarget').value.trim() || null, movie: $('movieTarget').value.trim() || null },
    move: $('moveEnabled').checked,
    language: $('language').value.trim(),
    region: $('region').value.trim().toUpperCase() || null,
    filters: { videoOnly: $('videoOnly').checked, excludeSamples: $('excludeSamples').checked },
    automation: {
      enabled: $('autoEnabled').checked,
      includeWarnings: $('autoWarnings').checked,
      cleanupEmptyFolders: $('autoCleanup').checked,
      audioFix: {
        enabled: $('audioFixEnabled').checked,
        episodes: $('audioFixEpisodes').checked,
        languages: $('audioLanguages').value.split(',').map((code) => code.trim().toLowerCase()).filter(Boolean),
        bitrate: $('audioBitrate').value,
      },
    },
  };
}

function applySettings(settings) {
  $('episodePattern').value = settings.patterns.episode;
  $('moviePattern').value = settings.patterns.movie;
  $('tvTarget').value = settings.targets.episode ?? '';
  $('movieTarget').value = settings.targets.movie ?? '';
  $('moveEnabled').checked = settings.move;
  $('language').value = settings.language ?? '';
  $('region').value = settings.region ?? '';
  $('videoOnly').checked = settings.filters.videoOnly;
  $('excludeSamples').checked = settings.filters.excludeSamples;
  const automation = settings.automation;
  $('autoEnabled').checked = automation.enabled;
  $('autoWarnings').checked = automation.includeWarnings;
  $('autoCleanup').checked = automation.cleanupEmptyFolders;
  $('audioFixEnabled').checked = automation.audioFix.enabled;
  $('audioFixEpisodes').checked = automation.audioFix.episodes;
  $('audioLanguages').value = automation.audioFix.languages.join(', ');
  if (![...$('audioBitrate').options].some((option) => option.value === automation.audioFix.bitrate)) {
    $('audioBitrate').append(new Option(automation.audioFix.bitrate, automation.audioFix.bitrate));
  }
  $('audioBitrate').value = automation.audioFix.bitrate;
  syncTargetFields();
}

function rememberSaved(response) {
  applySettings(response.settings);
  state.savedSnapshot = JSON.stringify(formSettings());
  state.serverSaved = response.saved;
  state.savedAt = response.savedAt;
  updateDefaultsStatus();
}

const isDirty = () => state.savedSnapshot !== null && JSON.stringify(formSettings()) !== state.savedSnapshot;

function updateDefaultsStatus() {
  const status = $('defaultsStatus');
  if (isDirty()) {
    status.textContent = 'Unsaved changes. “Save as default” keeps them for all browsers and the CLI.';
    status.className = 'hint dirty';
  } else if (state.serverSaved) {
    const when = state.savedAt ? ` (${new Date(state.savedAt).toLocaleString()})` : '';
    status.textContent = `Using your saved defaults${when}.`;
    status.className = 'hint';
  } else {
    status.textContent = 'Using the server’s defaults. Nothing saved yet.';
    status.className = 'hint';
  }
  $('saveDefaults').disabled = state.busy || !isDirty();
  $('resetDefaults').disabled = state.busy || !state.serverSaved;
}

async function loadServerSettings() {
  try {
    const response = await api('/api/settings', {});
    rememberSaved(response);
    $('tmdbStatus').textContent = response.tmdbConfigured
      ? 'Movie lookups (TMDB): enabled by the server configuration.'
      : 'Movie lookups (TMDB): disabled. Set TMDB_API_KEY in the server configuration to enable them.';
    $('hookStatus').textContent = [
      response.hookEnabled
        ? 'The import hook is enabled (POST /api/hooks/extracted).'
        : 'The import hook is disabled. Set MEDIA_RENAMER_HOOK_TOKEN on the server to enable it.',
      response.audioToolsAvailable ? '' : 'ffmpeg is not installed, so audio tracks cannot be added.',
    ]
      .filter(Boolean)
      .join(' ');
    if (response.problems?.length) setStatus(`Saved settings problem: ${response.problems.join('; ')}`, 'error');
    adoptLegacyBrowserSettings(response.saved);
  } catch (error) {
    $('tmdbStatus').textContent = `Could not read server settings: ${error.message}`;
  }
}

/**
 * Earlier versions kept patterns and destinations in this browser only. Offer
 * them once (as unsaved changes) if nothing has been saved on the server yet.
 */
function adoptLegacyBrowserSettings(serverHasSaved) {
  const legacy = readLocal();
  const hasLegacy = ['episodePattern', 'moviePattern', 'target', 'language'].some((key) => legacy[key]);
  if (hasLegacy && !serverHasSaved) {
    if (legacy.episodePattern) $('episodePattern').value = legacy.episodePattern;
    if (legacy.moviePattern) $('moviePattern').value = legacy.moviePattern;
    if (legacy.moveEnabled && legacy.target) {
      $('moveEnabled').checked = true;
      $('tvTarget').value = legacy.target;
      $('movieTarget').value = legacy.target;
    }
    if (legacy.language) $('language').value = legacy.language;
    if (legacy.region) $('region').value = legacy.region;
    syncTargetFields();
    updateDefaultsStatus();
    setStatus('Loaded the settings this browser remembered. Click “Save as default” to keep them on the server.');
  }
  saveLocal(); // drop the legacy fields; only the source folder stays in the browser
}

async function saveDefaults() {
  try {
    rememberSaved(await api('/api/settings/save', { settings: formSettings() }));
    setStatus('Saved as default. The web UI on every device and the CLI now use these settings.', 'success');
  } catch (error) {
    setStatus(`Not saved: ${error.message}`, 'error');
  }
}

async function resetDefaults() {
  if (!confirm('Forget the saved defaults and use the server’s configuration again?')) return;
  try {
    rememberSaved(await api('/api/settings/reset', {}));
    setStatus('Saved defaults removed. Using the server’s configuration.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

/* ---------- Destinations ---------- */

function syncTargetFields() {
  for (const field of document.querySelectorAll('.target-field')) field.hidden = !$('moveEnabled').checked;
}

/** Destinations to request: none unless moving; an empty field renames that kind in place. */
function requestedTargets() {
  if (!$('moveEnabled').checked) return { episode: null, movie: null };
  return { episode: $('tvTarget').value.trim() || null, movie: $('movieTarget').value.trim() || null };
}

const sameTargets = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const targetChangedSincePreview = () => state.previewed && !sameTargets(requestedTargets(), state.previewTargets);

function willChange(item) {
  return item.newRel && (item.target || item.newRel !== item.rel);
}

function updateButtons() {
  const hasFiles = state.items.length > 0;
  const selected = state.items.filter((item) => item.selected && RENAMABLE.has(item.status) && willChange(item));
  const stale = targetChangedSincePreview();
  for (const id of ['scan', 'browse', 'browseTvTarget', 'browseMovieTarget']) $(id).disabled = state.busy;
  $('preview').disabled = state.busy || !hasFiles;
  $('apply').disabled = state.busy || !selected.length || stale;
  $('apply').textContent = selected.some((item) => item.target) ? 'Rename & move selected' : 'Rename selected';
  $('undo').disabled = state.busy || !state.root;
  updateDefaultsStatus();
  if (stale && !state.busy) setStatus('Destinations changed — preview again before renaming.', 'error');
}

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

/* ---------- File table ---------- */

function describeParsed(parsed) {
  if (parsed.kind === 'episode') return `${parsed.title || '?'} · S${parsed.season}E${parsed.episode}`;
  if (parsed.kind === 'movie') return `${parsed.title}${parsed.year ? ` (${parsed.year})` : ''}`;
  return 'Not recognised';
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className === 'path') td.append(breakable(text));
  else td.textContent = text ?? '';
  if (className) td.className = className;
  return td;
}

const fitNameFields = () => document.querySelectorAll('#rows textarea').forEach(fitHeight);
window.addEventListener('resize', fitNameFields);

function render() {
  const rows = $('rows');
  rows.replaceChildren();
  $('count').textContent = state.items.length ? `(${state.items.length})` : '';

  if (!state.items.length) {
    const row = document.createElement('tr');
    const empty = cell('No media files found.', 'empty');
    empty.colSpan = 5;
    row.append(empty);
    rows.append(row);
  }

  for (const item of state.items) {
    const row = document.createElement('tr');
    row.className = `status-${item.status}`;

    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.selected;
    checkbox.disabled = !RENAMABLE.has(item.status);
    checkbox.setAttribute('aria-label', `Select ${item.rel}`);
    checkbox.addEventListener('change', () => {
      item.selected = checkbox.checked;
      updateButtons();
    });
    selectCell.append(checkbox);

    const statusCell = cell(item.status, 'status');
    statusCell.title = item.message ?? '';

    const newNameCell = document.createElement('td');
    if (item.newRel !== null && item.newRel !== undefined) {
      // A one-line textarea, so long names wrap instead of being cut off.
      const input = document.createElement('textarea');
      input.rows = 1;
      input.className = 'new-name';
      input.value = item.newRel;
      input.spellcheck = false;
      input.setAttribute('aria-label', `New name for ${item.rel}`);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.preventDefault();
      });
      input.addEventListener('input', () => {
        if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');
        fitHeight(input);
        Object.assign(item, { newRel: input.value.trim(), status: 'edited', message: 'Edited by hand', selected: true });
        checkbox.disabled = false;
        checkbox.checked = true;
        row.className = 'status-edited';
        statusCell.textContent = 'edited';
        updateButtons();
      });
      const note = document.createElement('span');
      note.className = 'target-note';
      note.append(breakable(item.target ? `→ ${KIND_LABEL[item.kind] ?? ''} in ${item.target}` : 'renamed in place'));
      newNameCell.append(input, note);
    }

    row.append(selectCell, cell(item.rel, 'path'), newNameCell, cell(item.match ?? item.message, 'match'), statusCell);
    rows.append(row);
  }
  fitNameFields();
  const renamable = state.items.filter((item) => RENAMABLE.has(item.status));
  $('selectAll').checked = renamable.length > 0 && renamable.every((item) => item.selected);
  $('selectAll').disabled = renamable.length === 0;
  updateButtons();
}

function showScan(data) {
  state.root = data.root;
  state.previewed = false;
  state.previewTargets = null;
  state.items = data.files.map((file) => ({
    rel: file.rel,
    kind: file.parsed.kind,
    newRel: null,
    target: null,
    status: 'pending',
    match: describeParsed(file.parsed),
    message: null,
    selected: false,
  }));
  render();
}

const filters = () => ({ videoOnly: $('videoOnly').checked, excludeSamples: $('excludeSamples').checked });

function describeExcluded(excluded = {}) {
  const parts = [];
  if (excluded.samples) parts.push(`${excluded.samples} sample`);
  if (excluded.nonVideo) parts.push(`${excluded.nonVideo} non-video`);
  return parts.length ? ` Skipped ${parts.join(' and ')} file(s).` : '';
}

async function scan() {
  saveLocal();
  await run('Scanning…', async () => {
    const data = await api('/api/scan', { root: $('root').value.trim(), recursive: $('recursive').checked, ...filters() });
    showScan(data);
    setStatus(
      `Found ${data.files.length} media file(s)${data.truncated ? ' (list truncated)' : ''}.${describeExcluded(data.excluded)} Click “Preview names”.`,
    );
  });
}

async function rescan() {
  showScan(await api('/api/scan', { root: state.root, recursive: $('recursive').checked, ...filters() }));
}

async function preview() {
  const targets = requestedTargets();
  if ($('moveEnabled').checked && !targets.episode && !targets.movie) {
    setStatus('Choose a destination for TV shows and/or movies, or untick “Move renamed files”.', 'error');
    return;
  }
  await run('Looking up metadata…', async () => {
    const data = await api('/api/preview', {
      root: state.root,
      targets,
      files: state.items.map((item) => item.rel),
      patterns: { episode: $('episodePattern').value, movie: $('moviePattern').value },
      ...filters(),
      ...($('language').value.trim() && { language: $('language').value.trim() }),
      region: $('region').value.trim() || null,
    });
    state.previewTargets = targets;
    state.previewed = true;
    state.items = data.items.map((item) => ({ ...item, selected: item.status === 'ok' }));
    render();
    const ready = state.items.filter((item) => item.selected);
    const moving = ['episode', 'movie']
      .map((kind) => [kind, ready.filter((item) => item.kind === kind && item.target).length])
      .filter(([, count]) => count)
      .map(([kind, count]) => `${count} to ${data.targets[kind]}`);
    setStatus(`${ready.length} file(s) ready${moving.length ? ` (moving ${moving.join(', ')})` : ''}. Review warnings before selecting them.`);
  });
}

/* ---------- Jobs ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return `${Math.ceil(seconds)} s`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

const rate = { since: 0, bytes: 0 };
const listTargets = (targets) => (targets?.length ? targets.join(' and ') : '');

function showJob(job) {
  const p = job.progress;
  const moving = job.kind === 'apply' ? (job.targets?.length ? 'Moving' : 'Renaming') : 'Undoing';
  $('jobTitle').textContent =
    job.state === 'cancelling'
      ? 'Cancelling…'
      : job.state === 'queued'
        ? `Waiting for another job to finish${job.queuePosition ? ` (position ${job.queuePosition})` : ''}…`
        : `${moving} files…`;
  $('jobCancel').disabled = !['running', 'queued'].includes(job.state);

  const doneBytes = p.bytesDone + (p.current?.bytesDone ?? 0);
  const now = Date.now();
  if (!rate.since) Object.assign(rate, { since: now, bytes: doneBytes });
  const seconds = (now - rate.since) / 1000;
  const speed = seconds > 2 ? (doneBytes - rate.bytes) / seconds : 0;
  const eta = speed > 0 ? formatDuration((p.bytesTotal - doneBytes) / speed) : '';

  const parts = [`${p.filesDone} of ${p.filesTotal} file(s)`];
  if (p.bytesTotal) parts.push(`${formatBytes(doneBytes)} of ${formatBytes(p.bytesTotal)}`);
  if (speed > 0) parts.push(`${formatBytes(speed)}/s`);
  if (eta) parts.push(`about ${eta} left`);
  $('jobOverallLabel').textContent = parts.join(' · ');
  $('jobOverall').max = p.bytesTotal || p.filesTotal || 1;
  $('jobOverall').value = p.bytesTotal ? doneBytes : p.filesDone;

  $('jobCurrent').textContent = p.current ? `${p.current.from} → ${p.current.to}` : '';
  $('jobFile').hidden = !p.current;
  if (p.current) {
    $('jobFile').max = p.current.bytesTotal || 1;
    $('jobFile').value = p.current.bytesDone;
  }
}

function reportJob(job) {
  const r = job.result;
  if (job.state === 'failed') return setStatus(job.error ?? 'The job failed.', 'error');
  if (job.kind === 'apply') {
    const verb = r.targets?.length ? `Moved ${r.renamed} file(s) to ${listTargets(r.targets)}` : `Renamed ${r.renamed} file(s)`;
    const failed = r.failed?.length ? ` ${r.failed.length} failed: ${r.failed.map((f) => `${f.from} (${f.reason})`).join('; ')}.` : '';
    if (r.cancelled) {
      return setStatus(`Cancelled. ${verb}; the file in progress was left where it was.${failed} “Undo last batch” reverts the completed ones.`, 'error');
    }
    return setStatus(`${verb}.${failed} Use “Undo last batch” to revert.`, failed ? 'error' : 'success');
  }
  const from = r.targets?.length ? ` from ${listTargets(r.targets)}` : '';
  const skipped = r.skipped?.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.from} (${s.reason})`).join('; ')}.` : '';
  const remaining = r.remaining ? ` ${r.remaining} file(s) still to restore — run “Undo last batch” again.` : '';
  return setStatus(`${r.cancelled ? 'Undo cancelled. ' : ''}Restored ${r.restored} file(s)${from}.${skipped}${remaining}`, skipped || remaining ? 'error' : 'success');
}

/** Show a server-side job until it ends; survives page reloads and brief disconnects. */
async function followJob(job) {
  state.busy = true;
  state.jobId = job.id;
  Object.assign(rate, { since: 0, bytes: 0 });
  for (const bar of ['jobOverall', 'jobFile']) $(bar).value = 0;
  $('jobOverallLabel').textContent = 'Starting…';
  $('jobCurrent').textContent = '';
  $('jobPanel').hidden = false;
  setStatus('');
  updateButtons();
  showJob(job);
  while (['queued', 'running', 'cancelling'].includes(job.state)) {
    await sleep(700);
    try {
      const latest = (await api('/api/job', { id: job.id })).job;
      if (!latest) break; // The server restarted; the undo log keeps what was done.
      job = latest;
      showJob(job);
    } catch (error) {
      $('jobOverallLabel').textContent = `Lost contact with the server (${error.message}); retrying…`;
      await sleep(2000);
    }
  }
  $('jobPanel').hidden = true;
  state.busy = false;
  state.jobId = null;
  if (job.result || job.state === 'failed') reportJob(job);
  else setStatus('The server restarted during the job. Completed moves are in the undo log.', 'error');
  if (state.root) await rescan().catch(() => {});
  activity.refresh();
  updateButtons();
}

async function apply() {
  const selected = state.items.filter((item) => item.selected && RENAMABLE.has(item.status) && willChange(item));
  const renames = selected.map((item) => ({ from: item.rel, to: item.newRel, target: item.target ?? null }));
  const byTarget = Object.entries(Object.groupBy(selected, (item) => item.target ?? '')).map(([target, list]) =>
    target ? `${list.length} into ${target}` : `${list.length} in place`,
  );
  if (!renames.length || !confirm(`Rename ${renames.length} file(s): ${byTarget.join(', ')}?`)) return;
  try {
    await followJob(await api('/api/apply', { root: state.root, renames }));
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function undo() {
  if (!confirm('Undo the last rename batch in this folder?')) return;
  try {
    await followJob(await api('/api/undo', { root: state.root }));
  } catch (error) {
    setStatus(error.message, 'error');
  }
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
    if (job && job.source === 'web UI' && ['queued', 'running', 'cancelling'].includes(job.state)) {
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
$('selectAll').addEventListener('change', (event) => {
  for (const item of state.items) if (RENAMABLE.has(item.status)) item.selected = event.target.checked;
  render();
});
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
