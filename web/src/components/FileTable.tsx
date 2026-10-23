import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ParsedMedia, PreviewItem } from '../../../lib/types.ts';
import { Breakable } from './Breakable.tsx';

/** A row of the table: a preview item, or a scanned file before the preview. */
export type Item = PreviewItem & { selected: boolean };

/** Preview statuses the user may select for renaming. */
export const RENAMABLE: ReadonlySet<string> = new Set(['ok', 'warning', 'edited']);

const KIND_LABEL: Record<string, string> = { episode: 'TV', movie: 'Movies' };

const willChange = (item: Item) => Boolean(item.newRel && (item.target || item.newRel !== item.rel));

/** Items that are selected and would actually be renamed or moved. */
export const selectedItems = (items: Item[]): Item[] => items.filter((item) => item.selected && RENAMABLE.has(item.status) && willChange(item));

function describeParsed(parsed: ParsedMedia): string {
  if (parsed.kind === 'episode') return `${parsed.title || '?'} · S${parsed.season}E${parsed.episode}`;
  if (parsed.kind === 'movie') return `${parsed.title}${parsed.year ? ` (${parsed.year})` : ''}`;
  return 'Not recognised';
}

/** Table rows for freshly scanned files, before any preview. */
export const itemsFromScan = (files: { rel: string; parsed: ParsedMedia }[]): Item[] =>
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

/** Grow a textarea to fit its content. */
function fitHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
}

/** A one-line textarea, so long names wrap instead of being cut off; editing selects the row. */
function NameEditor({ item, onEdit }: { item: Item; onEdit: (newRel: string) => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (input.current) fitHeight(input.current);
  }, []);
  return (
    <>
      <textarea
        ref={input}
        rows={1}
        className="new-name"
        defaultValue={item.newRel ?? ''}
        spellCheck={false}
        aria-label={`New name for ${item.rel}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
        onInput={(event) => {
          const textarea = event.currentTarget;
          if (/[\r\n]/.test(textarea.value)) textarea.value = textarea.value.replace(/[\r\n]+/g, ' ');
          fitHeight(textarea);
          onEdit(textarea.value.trim());
        }}
      />
      <span className="target-note">
        <Breakable text={item.target ? `→ ${KIND_LABEL[item.kind] ?? ''} in ${item.target}` : 'renamed in place'} />
      </span>
    </>
  );
}

function Row({ item, onChange }: { item: Item; onChange: (patch: Partial<Item>) => void }) {
  return (
    <tr className={`status-${item.status}`}>
      <td>
        <input
          type="checkbox"
          checked={item.selected}
          disabled={!RENAMABLE.has(item.status)}
          aria-label={`Select ${item.rel}`}
          onChange={(event) => onChange({ selected: event.target.checked })}
        />
      </td>
      <td className="path">
        <Breakable text={item.rel} />
      </td>
      <td>{item.newRel !== null && <NameEditor item={item} onEdit={(newRel) => onChange({ newRel, status: 'edited', message: 'Edited by hand', selected: true })} />}</td>
      <td className="match">{item.match ?? item.message ?? ''}</td>
      <td className="status" title={item.message ?? ''}>
        {item.status}
      </td>
    </tr>
  );
}

/**
 * The files of the scanned folder with their proposed names. `items` is null
 * before the first scan. `version` changes with every scan and preview, so name
 * editors start from the new proposals.
 */
export function FileTable({ items, version, onChange }: { items: Item[] | null; version: number; onChange: (items: Item[]) => void }) {
  useEffect(() => {
    const fitAll = () => document.querySelectorAll<HTMLTextAreaElement>('#rows textarea').forEach(fitHeight);
    window.addEventListener('resize', fitAll);
    return () => window.removeEventListener('resize', fitAll);
  }, []);

  const list = items ?? [];
  const renamable = list.filter((item) => RENAMABLE.has(item.status));
  const update = (index: number, patch: Partial<Item>) => onChange(list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const selectAll = (selected: boolean) => onChange(list.map((item) => (RENAMABLE.has(item.status) ? { ...item, selected } : item)));

  return (
    <section className="panel" aria-labelledby="files-heading">
      <h2 id="files-heading">
        3. Files <span>{list.length ? `(${list.length})` : ''}</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={renamable.length > 0 && renamable.every((item) => item.selected)}
                disabled={renamable.length === 0}
                onChange={(event) => selectAll(event.target.checked)}
              />
            </th>
            <th>Current name</th>
            <th>New name</th>
            <th>Match</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="rows">
          {list.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                {items ? 'No media files found.' : 'Scan a folder to begin.'}
              </td>
            </tr>
          )}
          {list.map((item, index) => (
            <Row key={`${version}:${item.rel}`} item={item} onChange={(patch) => update(index, patch)} />
          ))}
        </tbody>
      </table>
    </section>
  );
}
