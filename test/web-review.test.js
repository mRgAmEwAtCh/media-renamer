import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemsFromPreview } from '../web/src/items.ts';
import { resolveConflict } from '../web/src/conflicts.ts';
import { allDecided, jobsToReview, needsAttention, openConflicts, reviewFiles } from '../web/src/review.ts';
import { parseRoute } from '../web/src/route.ts';
import { changedFields, EMPTY_FORM, PREVIEW_FIELDS } from '../web/src/settings-form.ts';

const job = (id, state, outcomes) => ({ id, state, files: outcomes.map((outcome, i) => ({ rel: `dl/${id}/${i}.mkv`, outcome })) });

test('only finished jobs with files left for review show up, until this browser has dealt with them', () => {
  const jobs = [job('a', 'finished', ['moved', 'review', 'review']), job('b', 'finished', ['moved']), job('c', 'running', ['review']), job('d', 'cancelled', ['review'])];
  assert.deepEqual(reviewFiles(jobs[0]), ['dl/a/1.mkv', 'dl/a/2.mkv']);
  assert.deepEqual(reviewFiles(jobs[2]), [], 'a running import may still move the file');
  assert.deepEqual(jobsToReview(jobs, new Set()).map((j) => j.id), ['a', 'd']);
  assert.deepEqual(jobsToReview(jobs, new Set(['a'])).map((j) => j.id), ['d']);
});

const row = (rel, extra) => ({ rel, kind: 'movie', newRel: 'Heat (1995).mkv', target: '/lib', match: null, message: null, ...extra });
const clash = (rel) => row(rel, { status: 'conflict', conflict: { reason: 'duplicate', status: 'ok', message: null } });

test('rows needing attention, open conflicts and whether every row got a decision', () => {
  let items = itemsFromPreview([row('ok.mkv', { status: 'ok', newRel: 'A.mkv' }), row('warn.mkv', { status: 'warning', newRel: 'B.mkv' }), clash('x.mkv'), clash('y.mkv')]);
  assert.deepEqual(items.filter(needsAttention).map((item) => item.rel), ['warn.mkv', 'x.mkv', 'y.mkv']);
  assert.equal(openConflicts(items).length, 2);
  assert.equal(allDecided(items), false);

  items = resolveConflict(items, 2, 'skip');
  assert.equal(openConflicts(items).length, 0, 'skipping one of two files with the same name frees the other');
  assert.equal(allDecided(items), false, 'the warning is still undecided');
  items = items.map((item) => (item.rel === 'warn.mkv' ? { ...item, selected: true } : item));
  assert.equal(allDecided(items), true);
});

test('changed settings are compared as they would be saved', () => {
  const saved = { ...EMPTY_FORM, episodePattern: '{n}', region: 'DE', audioLanguages: 'de, en' };
  assert.deepEqual(changedFields({ ...saved, region: 'de', audioLanguages: 'de,en ' }, saved), [], 'case and spacing do not count');
  assert.deepEqual(changedFields({ ...saved, tvTarget: '/tv', autoEnabled: true }, saved), ['tvTarget', 'autoEnabled']);
  assert.ok(PREVIEW_FIELDS.has('tvTarget'));
  assert.ok(!PREVIEW_FIELDS.has('autoEnabled'), 'automation does not change a preview');
});

test('routes: views and links to an import to review', () => {
  assert.deepEqual(parseRoute(''), { view: 'rename', reviewJob: null });
  assert.deepEqual(parseRoute('#/activity'), { view: 'activity', reviewJob: null });
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings', reviewJob: null });
  assert.deepEqual(parseRoute('#/nonsense'), { view: 'rename', reviewJob: null });
  assert.deepEqual(parseRoute('#/review/j%201'), { view: 'rename', reviewJob: 'j 1' });
});
