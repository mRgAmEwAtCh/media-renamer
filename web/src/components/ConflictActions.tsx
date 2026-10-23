import { useState } from 'react';
import { canOverwrite, sameNameAs } from '../conflicts.ts';
import { formatBytes } from '../format.ts';
import type { Item, Resolution } from '../items.ts';

const size = (bytes: number | undefined) => (bytes === undefined ? 'unknown size' : formatBytes(bytes));

function compare(mine: number | undefined, theirs: number | undefined): string {
  if (mine === undefined || theirs === undefined) return '';
  if (mine === theirs) return ', same size';
  return mine > theirs ? ', this file is larger' : ', this file is smaller';
}

interface ConflictActionsProps {
  item: Item;
  items: Item[];
  onResolve: (resolution: Resolution) => void;
  onKeepBoth: () => Promise<void>;
}

/** Sizes of the files in the way, and Keep both / Overwrite / Skip (optionally deleting the extracted file). */
export function ConflictActions({ item, items, onResolve, onKeepBoth }: ConflictActionsProps) {
  const [busy, setBusy] = useState(false);
  const duplicates = sameNameAs(item, items);
  const skipped = item.resolution === 'skip' || item.resolution === 'remove';
  // Overwriting only helps once no other file in the batch wants the same name.
  const offerOverwrite = canOverwrite(item, items);
  const details = [
    `This file: ${size(item.size)}`,
    item.existingSize !== undefined && `existing file: ${size(item.existingSize)}${compare(item.size, item.existingSize)}`,
    duplicates.length > 0 && `same new name as ${duplicates.map((other) => `${other.rel} (${size(other.size)})`).join(', ')}`,
  ].filter(Boolean);

  async function keepBoth() {
    setBusy(true);
    try {
      await onKeepBoth();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="conflict">
      <p className="hint">{details.join(' · ')}</p>
      <div className="conflict-actions" role="group" aria-label={`Resolve the conflict for ${item.rel}`}>
        <button type="button" aria-pressed={item.resolution === 'keep-both'} disabled={busy} onClick={keepBoth}>
          Keep both
        </button>
        {offerOverwrite && (
          <button type="button" aria-pressed={item.resolution === 'overwrite'} disabled={busy} onClick={() => onResolve('overwrite')}>
            Overwrite
          </button>
        )}
        <button type="button" aria-pressed={skipped} disabled={busy} onClick={() => onResolve('skip')}>
          Skip
        </button>
      </div>
      {skipped && (
        <label className="checkbox">
          <input type="checkbox" checked={item.resolution === 'remove'} onChange={(event) => onResolve(event.target.checked ? 'remove' : 'skip')} /> Delete
          the extracted file ({size(item.size)})
        </label>
      )}
    </div>
  );
}
