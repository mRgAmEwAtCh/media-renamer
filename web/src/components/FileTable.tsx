import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { editName, resolveConflict } from '../conflicts.ts';
import type { Review } from '../hooks/useRenamer.ts';
import { isSelectable, type Item, type Resolution } from '../items.ts';
import { needsAttention, openConflicts } from '../review.ts';
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
  busy: boolean;
  /** Set while the rows are an import's files to review. */
  review: Review | null;
  onChange: (items: Item[]) => void;
  /** Give the row a free name next to the file in the way. */
  onKeepBoth: (index: number) => Promise<void>;
  onKeepBothAll: () => void;
  onCloseReview: (done: boolean) => void;
  /** The sticky bar under the table: Preview / Rename / Undo and the status line. */
  actions: ReactNode;
}

function ReviewBanner({ review, busy, onClose }: { review: Review; busy: boolean; onClose: (done: boolean) => void }) {
  return (
    <div className="review-banner" role="note">
      <span>
        Reviewing <strong>{review.files.length}</strong> {review.files.length === 1 ? 'file' : 'files'} from <strong><Breakable text={review.label} /></strong>
      </span>
      <span className="row">
        <button type="button" disabled={busy} onClick={() => onClose(true)} title="Hide this import from “Needs review”">
          Mark as reviewed
        </button>
        <button type="button" disabled={busy} onClick={() => onClose(false)}>
          Close
        </button>
      </span>
    </div>
  );
}

export function FileTable({ items, version, busy, review, onChange, onKeepBoth, onKeepBothAll, onCloseReview, actions }: FileTableProps) {
  useEffect(() => {
    const fitAll = () => document.querySelectorAll<HTMLTextAreaElement>('#rows textarea').forEach(fitHeight);
    window.addEventListener('resize', fitAll);
    return () => window.removeEventListener('resize', fitAll);
  }, []);

  const list = items ?? [];
  const renamable = list.filter(isSelectable);
  const select = (index: number, selected: boolean) => onChange(list.map((item, i) => (i === index ? { ...item, selected } : item)));
  const selectAll = (selected: boolean) => onChange(list.map((item) => (isSelectable(item) ? { ...item, selected } : item)));
  const conflicts = openConflicts(list);
  const attention = list.filter(needsAttention).length;

  // The filter keeps the rows it showed when turned on (or at the last preview), so a
  // row does not vanish the moment its conflict is settled or its name is edited.
  const [onlyAttention, setOnlyAttention] = useState(false);
  const shownRels = useMemo(
    () => (onlyAttention ? new Set(list.filter(needsAttention).map((item) => item.rel)) : null),
    // Recomputed per preview and toggle only, on purpose.
    [onlyAttention, version],
  );
  const skipAll = () => {
    let next = list;
    for (const item of conflicts) next = resolveConflict(next, next.findIndex((row) => row.rel === item.rel), 'skip');
    onChange(next);
  };

  return (
    <section className="panel files" aria-labelledby="files-heading">
      <h2 id="files-heading">
        Files <span>{list.length ? `(${list.length})` : ''}</span>
      </h2>
      {review && <ReviewBanner review={review} busy={busy} onClose={onCloseReview} />}
      {(attention > 0 || onlyAttention) && (
        <div className="row table-tools">
          <label className="checkbox">
            <input type="checkbox" checked={onlyAttention} onChange={(event) => setOnlyAttention(event.target.checked)} /> Only files that need attention (
            {attention})
          </label>
          {conflicts.length > 1 && (
            <>
              <button type="button" disabled={busy} onClick={onKeepBothAll}>
                {`Keep both for all ${conflicts.length} conflicts`}
              </button>
              <button type="button" disabled={busy} onClick={skipAll}>
                Skip all conflicts
              </button>
            </>
          )}
        </div>
      )}
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
          {list.map((item, index) =>
            shownRels && !shownRels.has(item.rel) ? null : (
            <Row
              key={`${version}:${item.rel}`}
              item={item}
              items={list}
              onSelect={(selected) => select(index, selected)}
              onEdit={(newRel) => onChange(editName(list, index, newRel))}
              onResolve={(resolution) => onChange(resolveConflict(list, index, resolution))}
              onKeepBoth={() => onKeepBoth(index)}
            />
            ),
          )}
          {shownRels && list.length > 0 && shownRels.size === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                Nothing needs attention.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {actions}
    </section>
  );
}
