import { useEffect, useLayoutEffect, useRef } from 'react';
import { editName, resolveConflict } from '../conflicts.ts';
import { isSelectable, type Item, type Resolution } from '../items.ts';
import { Breakable } from './Breakable.tsx';
import { ConflictActions } from './ConflictActions.tsx';

const KIND_LABEL: Record<string, string> = { episode: 'TV', movie: 'Movies' };

/** The status shown for a row: a settled conflict shows what will happen to it. */
const shownStatus = (item: Item): string => (item.resolution === 'overwrite' && item.status === 'conflict' ? 'overwrite' : item.resolution === 'remove' ? 'delete' : item.status);

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

interface RowProps {
  item: Item;
  items: Item[];
  onSelect: (selected: boolean) => void;
  onEdit: (newRel: string) => void;
  onResolve: (resolution: Resolution) => void;
  onKeepBoth: () => Promise<void>;
}

function Row({ item, items, onSelect, onEdit, onResolve, onKeepBoth }: RowProps) {
  const status = shownStatus(item);
  return (
    <tr className={`status-${status}`}>
      <td>
        <input
          type="checkbox"
          checked={item.selected}
          disabled={!isSelectable(item)}
          aria-label={`Select ${item.rel}`}
          onChange={(event) => onSelect(event.target.checked)}
        />
      </td>
      <td className="path">
        <Breakable text={item.rel} />
      </td>
      <td>
        {item.newRel !== null && <NameEditor key={item.editorKey ?? 0} item={item} onEdit={onEdit} />}
        {item.conflict && <ConflictActions item={item} items={items} onResolve={onResolve} onKeepBoth={onKeepBoth} />}
      </td>
      <td className="match">{item.match ?? item.message ?? ''}</td>
      <td className="status" title={item.message ?? ''}>
        {status}
      </td>
    </tr>
  );
}

/**
 * The files of the scanned folder with their proposed names. `items` is null
 * before the first scan. `version` changes with every scan and preview, so name
 * editors start from the new proposals.
 */
interface FileTableProps {
  items: Item[] | null;
  version: number;
  onChange: (items: Item[]) => void;
  /** Give the row a free name next to the file in the way. */
  onKeepBoth: (index: number) => Promise<void>;
}

export function FileTable({ items, version, onChange, onKeepBoth }: FileTableProps) {
  useEffect(() => {
    const fitAll = () => document.querySelectorAll<HTMLTextAreaElement>('#rows textarea').forEach(fitHeight);
    window.addEventListener('resize', fitAll);
    return () => window.removeEventListener('resize', fitAll);
  }, []);

  const list = items ?? [];
  const renamable = list.filter(isSelectable);
  const select = (index: number, selected: boolean) => onChange(list.map((item, i) => (i === index ? { ...item, selected } : item)));
  const selectAll = (selected: boolean) => onChange(list.map((item) => (isSelectable(item) ? { ...item, selected } : item)));

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
            <Row
              key={`${version}:${item.rel}`}
              item={item}
              items={list}
              onSelect={(selected) => select(index, selected)}
              onEdit={(newRel) => onChange(editName(list, index, newRel))}
              onResolve={(resolution) => onChange(resolveConflict(list, index, resolution))}
              onKeepBoth={() => onKeepBoth(index)}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}
