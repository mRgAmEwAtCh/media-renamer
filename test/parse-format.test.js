import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPattern, validatePattern } from '../lib/format.ts';
import { parseMediaFile } from '../lib/parse.ts';

test('parses SxxEyy episodes with release tags', () => {
  const parsed = parseMediaFile('Breaking.Bad.S01E02.720p.HDTV.x264.mkv');
  assert.equal(parsed.kind, 'episode');
  assert.equal(parsed.title, 'Breaking Bad');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 2);
  assert.equal(parsed.extension, '.mkv');
});

test('parses multi-episode and NxNN forms and series years', () => {
  const multi = parseMediaFile('Doctor.Who.2005.S02E12E13.mkv');
  assert.deepEqual([multi.title, multi.year, multi.episode, multi.episodeEnd], ['Doctor Who', 2005, 12, 13]);
  const cross = parseMediaFile('The Office - 3x05 - Initiation.avi');
  assert.deepEqual([cross.title, cross.season, cross.episode], ['The Office', 3, 5]);
});

test('takes the series name from folders when the file has none', () => {
  const parsed = parseMediaFile('S01E01.mkv', { folderNames: ['Season 1', 'Severance (2022)'] });
  assert.deepEqual([parsed.title, parsed.year], ['Severance', 2022]);
});

test('parses movies, keeping year-like titles', () => {
  const movie = parseMediaFile('The.Matrix.1999.1080p.BluRay.x264.mp4');
  assert.deepEqual([movie.kind, movie.title, movie.year], ['movie', 'The Matrix', 1999]);
  const yearTitle = parseMediaFile('2012 (2009).mkv');
  assert.deepEqual([yearTitle.title, yearTitle.year], ['2012', 2009]);
  const noYear = parseMediaFile('Arrival [1080p].mkv');
  assert.deepEqual([noYear.title, noYear.year], ['Arrival', null]);
});

test('keeps subtitle language codes separate', () => {
  const parsed = parseMediaFile('Inception.2010.en.srt');
  assert.deepEqual([parsed.title, parsed.year, parsed.language, parsed.isSubtitle], ['Inception', 2010, 'en', true]);
});

test('renders patterns and cleans unsafe or empty parts', () => {
  const values = { name: 'Star Wars: A New Hope', year: 1977 };
  assert.equal(renderPattern('{n} ({y})', values), 'Star Wars - A New Hope (1977)');
  assert.equal(renderPattern('{n} ({y})', { name: 'Arrival' }), 'Arrival');
  const episode = { name: 'Show', season: 1, episode: 2, episodeEnd: 3, title: 'AC/DC?' };
  assert.equal(renderPattern('{n}/Season {s00}/{n} - {s00e00} - {t}', episode), 'Show/Season 01/Show - S01E02-E03 - AC-DC');
  assert.equal(renderPattern('../{n}/./x', { name: 'Show' }), 'Show/x');
});

test('rejects unknown pattern tokens', () => {
  assert.throws(() => validatePattern('{n} {bogus}'), /bogus/);
  assert.throws(() => validatePattern('  '), /empty/);
});
