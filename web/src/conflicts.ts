import type { Item, Resolution } from './items.ts';

// Conflicts are re-checked in the page after every change, so settling one
// (e.g. "Keep both" on one of two files with the same new name) frees the other.

const MESSAGES = {
  duplicate: 'Another file maps to the same name',
  exists: 'A file with the new name already exists',
  overwrite: 'Will replace the existing file',
  skip: 'Skipped: the file stays where it is',
  remove: 'Skipped: the extracted file will be deleted',
  keepBoth: 'Renamed to keep both files',
};

/** Files that still want their new name: everything with one except skipped and settled-by-skipping rows. */
const claimsName = (item: Item) =>
  Boolean(item.newRel) && item.resolution !== 'skip' && item.resolution !== 'remove' && ['ok', 'warning', 'edited', 'conflict'].includes(item.status);

const keyOf = (target: string | null, name: string) => `${target ?? ''}\0${name.toLowerCase()}`;
const nameKey = (item: Item) => keyOf(item.target, item.newRel!);

/** Whether the item's name is the one the server found taken on disk. */
export const nameIsTaken = (item: Item): boolean => item.existingSize !== undefined && item.newRel === item.originalNewRel;

/** Other rows that want `name` (default: the item's current new name) in the item's folder. */
export function sameNameAs(item: Item, items: Item[], name = item.newRel): Item[] {
  if (!name || (name === item.newRel && !claimsName(item))) return [];
  return items.filter((other) => other !== item && claimsName(other) && nameKey(other) === keyOf(item.target, name));
}

/**
 * Overwriting is possible when the proposed name is taken on disk, no other row
 * wants it, and the file in the way is not another row that is moved or deleted
 * (renaming in place, where rows and new names share a folder).
 */
export function canOverwrite(item: Item, items: Item[]): boolean {
  const name = item.originalNewRel ?? item.newRel;
  if (item.existingSize === undefined || !name || sameNameAs(item, items, name).length > 0) return false;
  const inTheWay = item.target === null ? items.find((other) => other !== item && other.rel.toLowerCase() === name.toLowerCase()) : undefined;
  return !inTheWay || (!claimsName(inTheWay) && inTheWay.resolution !== 'remove');
}

function settle(item: Item, duplicates: number): Item {
  const before = item.conflict!;
  if (item.resolution === 'skip' || item.resolution === 'remove') {
    return { ...item, status: 'conflict', message: MESSAGES[item.resolution], selected: item.resolution === 'remove' };
  }
  if (duplicates > 0) return { ...item, status: 'conflict', message: MESSAGES.duplicate, selected: false };
  if (nameIsTaken(item)) {
    if (item.resolution === 'overwrite') return { ...item, status: 'conflict', message: MESSAGES.overwrite, selected: true };
    return { ...item, status: 'conflict', message: MESSAGES.exists, selected: false };
  }
  if (item.resolution === 'keep-both') return { ...item, status: before.status, message: MESSAGES.keepBoth, selected: true };
  // The conflict went away (the other file got another name or was skipped).
  return { ...item, status: before.status, message: before.message, selected: before.status === 'ok' };
}

/** Re-evaluate every row that had a conflict in the preview. */
export function recheckConflicts(items: Item[]): Item[] {
  const counts = new Map<string, number>();
  for (const item of items) if (claimsName(item)) counts.set(nameKey(item), (counts.get(nameKey(item)) ?? 0) + 1);
  return items.map((item) => (item.conflict ? settle(item, claimsName(item) ? counts.get(nameKey(item))! - 1 : 0) : item));
}

/** Settle one row's conflict; `newRel` is the free name for "Keep both". */
export function resolveConflict(items: Item[], index: number, resolution: Resolution, newRel?: string): Item[] {
  const updated = items.map((item, i) => {
    if (i !== index) return item;
    const name = resolution === 'keep-both' ? newRel! : (item.originalNewRel ?? item.newRel);
    const renamed = name !== item.newRel;
    return { ...item, resolution, newRel: name, editorKey: (item.editorKey ?? 0) + (renamed ? 1 : 0) };
  });
  return recheckConflicts(updated);
}

/** A name typed by hand replaces any decision about the conflict. */
export function editName(items: Item[], index: number, newRel: string): Item[] {
  const updated = items.map((item, i) =>
    i === index
      ? { ...item, newRel, status: 'edited' as const, message: 'Edited by hand', selected: true, resolution: undefined, conflict: undefined, existingSize: undefined }
      : item,
  );
  return recheckConflicts(updated);
}
