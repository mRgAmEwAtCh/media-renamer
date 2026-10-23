import type { ParsedMedia, PreviewItem } from '../../lib/types.ts';

/** How the user settled a conflict: see conflicts.ts. */
export type Resolution = 'keep-both' | 'overwrite' | 'skip' | 'remove';

/** A row of the file table: a preview item, or a scanned file before the preview. */
export type Item = PreviewItem & {
  selected: boolean;
  resolution?: Resolution;
  /** The proposed name, so a conflict can go back to it after "Keep both". */
  originalNewRel?: string;
  /** Changes when the name is set by an action (not by typing), so the name field shows it. */
  editorKey?: number;
};

/** Preview statuses the user may select for renaming. */
export const RENAMABLE: ReadonlySet<string> = new Set(['ok', 'warning', 'edited']);

/** Rows that can be ticked: renamable ones, and conflicts settled by overwriting or deleting. */
export const isSelectable = (item: Item): boolean =>
  RENAMABLE.has(item.status) || item.resolution === 'overwrite' || item.resolution === 'remove';

const willChange = (item: Item) => Boolean(item.newRel && (item.target || item.newRel !== item.rel));

/** Items that are selected and would actually be renamed, moved or deleted. */
export const selectedItems = (items: Item[]): Item[] => items.filter((item) => item.selected && isSelectable(item) && willChange(item));

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

/** Table rows for a preview: confident matches start selected. */
export const itemsFromPreview = (items: PreviewItem[]): Item[] =>
  items.map((item) => ({ ...item, selected: item.status === 'ok', ...(item.conflict && item.newRel && { originalNewRel: item.newRel }) }));
