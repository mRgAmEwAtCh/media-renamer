import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canOverwrite, editName, recheckConflicts, resolveConflict, sameNameAs } from '../web/src/conflicts.ts';
import { isSelectable, itemsFromPreview, selectedItems } from '../web/src/items.ts';

const LIBRARY = '/library';
const item = (rel, extra = {}) => ({
  rel,
  kind: 'movie',
  newRel: 'Heat (1995).mkv',
  target: LIBRARY,
  match: null,
  size: 1,
  ...extra,
});
const conflict = (reason, rel, extra) =>
  item(rel, { status: 'conflict', message: reason === 'exists' ? 'A file with the new name already exists' : 'Another file maps to the same name', conflict: { reason, status: 'warning', message: 'No TMDB key' }, ...extra });

test('a name taken on disk can be overwritten, skipped, or kept next to the old file', () => {
  let items = itemsFromPreview([conflict('exists', 'Heat.2160p.mkv', { existingSize: 5 })]);
  assert.equal(items[0].originalNewRel, 'Heat (1995).mkv');
  assert.equal(isSelectable(items[0]), false);
  assert.ok(canOverwrite(items[0], items));

  items = resolveConflict(items, 0, 'overwrite');
  assert.deepEqual([items[0].status, items[0].selected, isSelectable(items[0])], ['conflict', true, true]);
  assert.equal(selectedItems(items).length, 1);

  items = resolveConflict(items, 0, 'keep-both', 'Heat (1995) (2).mkv');
  assert.deepEqual([items[0].newRel, items[0].status, items[0].selected, items[0].editorKey], ['Heat (1995) (2).mkv', 'warning', true, 1]);
  assert.ok(canOverwrite(items[0], items), 'can still switch back to overwriting');

  items = resolveConflict(items, 0, 'skip');
  assert.deepEqual([items[0].newRel, items[0].selected, isSelectable(items[0]), items[0].editorKey], ['Heat (1995).mkv', false, false, 2]);

  items = resolveConflict(items, 0, 'remove');
  assert.deepEqual([items[0].selected, isSelectable(items[0])], [true, true]);
  assert.match(items[0].message, /deleted/);
});

test('settling one of two files with the same new name frees the other', () => {
  let items = itemsFromPreview([conflict('duplicate', 'Heat.720p.mkv'), conflict('duplicate', 'Heat.2160p.mkv', { existingSize: 3 })]);
  assert.equal(sameNameAs(items[0], items).length, 1);
  assert.equal(canOverwrite(items[1], items), false, 'not while another file wants the name');

  items = resolveConflict(items, 0, 'skip');
  assert.equal(items[1].message, 'A file with the new name already exists', 'only the file on disk is left in the way');
  assert.ok(canOverwrite(items[1], items));

  items = resolveConflict(items, 0, 'keep-both', 'Heat (1995) (2).mkv');
  assert.equal(items[1].message, 'A file with the new name already exists');

  const noDiskConflict = resolveConflict(itemsFromPreview([conflict('duplicate', 'a.mkv'), conflict('duplicate', 'b.mkv')]), 0, 'skip');
  assert.deepEqual([noDiskConflict[1].status, noDiskConflict[1].message], ['warning', 'No TMDB key'], 'back to what it was before');
});

test('typing a name takes the row out of conflict handling and never overwrites', () => {
  let items = itemsFromPreview([conflict('exists', 'Heat.mkv', { existingSize: 5 })]);
  items = resolveConflict(items, 0, 'overwrite');
  items = editName(items, 0, 'Heat (1995) Director’s Cut.mkv');
  assert.deepEqual([items[0].status, items[0].resolution, items[0].conflict, items[0].selected], ['edited', undefined, undefined, true]);
  assert.deepEqual(recheckConflicts(items), items);
});

test('renaming in place never offers to overwrite a file another row moves or deletes', () => {
  const inPlace = (rel, newRel, extra) => ({ ...item(rel, { newRel, target: null, status: 'ok', ...extra }) });
  let items = itemsFromPreview([
    inPlace('a.mkv', 'b.mkv', { status: 'conflict', existingSize: 1, conflict: { reason: 'exists', status: 'ok', message: null }, message: 'A file with the new name already exists' }),
    inPlace('b.mkv', 'c.mkv'),
  ]);
  assert.equal(canOverwrite(items[0], items), false, 'b.mkv moves away in the same batch');
  items = items.map((row, i) => (i === 1 ? { ...row, status: 'skipped', newRel: null } : row));
  assert.equal(canOverwrite(items[0], items), true, 'b.mkv stays, so it may be replaced');
});
