import { $, element } from './dom.js';
import { RENAMABLE, state } from './state.js';
import { breakable, fitHeight } from './text.js';

const KIND_LABEL = { episode: 'TV', movie: 'Movies' };

function describeParsed(parsed) {
  if (parsed.kind === 'episode') return `${parsed.title || '?'} · S${parsed.season}E${parsed.episode}`;
  if (parsed.kind === 'movie') return `${parsed.title}${parsed.year ? ` (${parsed.year})` : ''}`;
  return 'Not recognised';
}

/** Table rows for freshly scanned files, before any preview. */
export const itemsFromScan = (files) =>
  files.map((file) => ({
    rel: file.rel,
    kind: file.parsed.kind,
    newRel: null,
    target: null,
    status: 'pending',
    match: describeParsed(file.parsed),
    message: null,
    selected: false,
  }));

function cell(text, className) {
  const td = document.createElement('td');
  if (className === 'path') td.append(breakable(text));
  else td.textContent = text ?? '';
  if (className) td.className = className;
  return td;
}

const fitNameFields = () => document.querySelectorAll('#rows textarea').forEach(fitHeight);

/**
 * The file table: one row per item in state.items, with a checkbox and an
 * editable new name. `onChange` runs after the selection or a name changes.
 */
export function createFileTable({ onChange }) {
  window.addEventListener('resize', fitNameFields);
  $('selectAll').addEventListener('change', (event) => {
    for (const item of state.items) if (RENAMABLE.has(item.status)) item.selected = event.target.checked;
    render();
  });

  /** A one-line textarea, so long names wrap instead of being cut off; editing selects the row. */
  function nameEditor(item, onEdit) {
    const input = element('textarea', { rows: 1, className: 'new-name', value: item.newRel, spellcheck: false });
    input.setAttribute('aria-label', `New name for ${item.rel}`);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    input.addEventListener('input', () => {
      if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');
      fitHeight(input);
      Object.assign(item, { newRel: input.value.trim(), status: 'edited', message: 'Edited by hand', selected: true });
      onEdit();
    });
    const note = element('span', { className: 'target-note' });
    note.append(breakable(item.target ? `→ ${KIND_LABEL[item.kind] ?? ''} in ${item.target}` : 'renamed in place'));
    return [input, note];
  }

  function row(item) {
    const tr = element('tr', { className: `status-${item.status}` });
    const checkbox = element('input', { type: 'checkbox', checked: item.selected, disabled: !RENAMABLE.has(item.status) });
    checkbox.setAttribute('aria-label', `Select ${item.rel}`);
    checkbox.addEventListener('change', () => {
      item.selected = checkbox.checked;
      onChange();
    });
    const statusCell = cell(item.status, 'status');
    statusCell.title = item.message ?? '';

    const newNameCell = document.createElement('td');
    if (item.newRel !== null && item.newRel !== undefined) {
      const onEdit = () => {
        Object.assign(checkbox, { disabled: false, checked: true });
        tr.className = 'status-edited';
        statusCell.textContent = 'edited';
        onChange();
      };
      newNameCell.append(...nameEditor(item, onEdit));
    }
    tr.append(element('td', {}, checkbox), cell(item.rel, 'path'), newNameCell, cell(item.match ?? item.message, 'match'), statusCell);
    return tr;
  }

  function emptyRow() {
    const empty = cell('No media files found.', 'empty');
    empty.colSpan = 5;
    return element('tr', {}, empty);
  }

  function render() {
    $('count').textContent = state.items.length ? `(${state.items.length})` : '';
    $('rows').replaceChildren(...(state.items.length ? state.items.map(row) : [emptyRow()]));
    fitNameFields();
    const renamable = state.items.filter((item) => RENAMABLE.has(item.status));
    $('selectAll').checked = renamable.length > 0 && renamable.every((item) => item.selected);
    $('selectAll').disabled = renamable.length === 0;
    onChange();
  }

  return { render };
}
