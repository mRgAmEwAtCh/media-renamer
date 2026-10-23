import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { renderPattern } from '../lib/format.ts';
import { MetadataClient, normalizeLanguage, normalizeRegion } from '../lib/metadata.ts';
import { buildPreview } from '../lib/renamer.ts';

/** Fake fetch that answers from a route table and records every request URL. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    for (const [match, respond] of routes) {
      if (match(url)) {
        const body = respond(url);
        return body === null ? new Response('', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

const isTmdb = (pathname) => (url) => url.hostname === 'api.themoviedb.org' && url.pathname === `/3${pathname}`;

test('normalises language and region codes and rejects garbage', () => {
  assert.equal(normalizeLanguage('de'), 'de');
  assert.equal(normalizeLanguage('de_de'), 'de-DE');
  assert.equal(normalizeLanguage('EN-us'), 'en-US');
  assert.equal(normalizeLanguage(''), null);
  assert.throws(() => normalizeLanguage('german'), /Invalid language/);
  assert.equal(normalizeRegion('de'), 'DE');
  assert.throws(() => normalizeRegion('DEU'), /Invalid region/);
  assert.deepEqual(
    [loadConfig({ MEDIA_RENAMER_LANGUAGE: 'de_DE', MEDIA_RENAMER_REGION: 'de' }).language, loadConfig({}).language, loadConfig({}).region],
    ['de-DE', 'en-US', null],
  );
});

test('movie search sends language and region, falling back to a search without region', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [
      isTmdb('/search/movie'),
      (url) =>
        url.searchParams.get('region')
          ? { results: [] }
          : { results: [{ id: 238, title: 'Der Pate', original_title: 'The Godfather', release_date: '1972-03-14' }] },
    ],
  ]);
  const client = new MetadataClient({ tmdbKey: 'key', language: 'de-DE', region: 'DE', fetchImpl });
  const movie = await client.findMovie('The Godfather', 1972);
  assert.deepEqual(movie, { source: 'TMDB', id: 238, name: 'Der Pate', originalName: 'The Godfather', year: 1972 });
  assert.equal(calls[0].searchParams.get('language'), 'de-DE');
  assert.equal(calls[0].searchParams.get('region'), 'DE');
  assert.equal(calls[1].searchParams.get('region'), null, 'second attempt drops the region');
  assert.equal(calls[1].searchParams.get('year'), '1972');
});

test('TV titles are localised via TMDB with an English fallback for placeholder episode names', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [isTmdb('/search/tv'), () => ({ results: [{ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20' }] })],
    [isTmdb('/tv/1396/season/1/episode/2'), (url) => ({ name: url.searchParams.get('language') === 'de-DE' ? 'Die Katze ist im Sack …' : 'Cat’s in the Bag…', air_date: '2008-01-27' })],
    [isTmdb('/tv/1396/season/1/episode/9'), (url) => ({ name: url.searchParams.get('language') === 'de-DE' ? 'Folge 9' : 'Bit by a Dead Bee', air_date: '2008-03-09' })],
  ]);
  const client = new MetadataClient({ tmdbKey: 'key', language: 'de-DE', fetchImpl });
  const show = await client.findShow('Breaking Bad', null);
  assert.equal(show.source, 'TMDB');
  assert.equal((await client.findEpisode(show, 1, 2)).title, 'Die Katze ist im Sack …');
  assert.equal((await client.findEpisode(show, 1, 9)).title, 'Bit by a Dead Bee', 'placeholder "Folge 9" replaced by English');
  assert.ok(calls.every((url) => url.hostname === 'api.themoviedb.org'), 'TVmaze not needed when TMDB answers');
});

test('without a TMDB key TV lookups use TVmaze and movies are skipped', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [(url) => url.pathname === '/search/shows', () => [{ show: { id: 169, name: 'Breaking Bad', premiered: '2008-01-20' } }]],
    [(url) => url.pathname === '/shows/169/episodebynumber', () => ({ name: 'Pilot', airdate: '2008-01-20' })],
  ]);
  const client = new MetadataClient({ language: 'de-DE', fetchImpl });
  const show = await client.findShow('Breaking Bad');
  assert.equal(show.source, 'TVmaze');
  assert.equal((await client.findEpisode(show, 1, 1)).title, 'Pilot');
  assert.equal(await client.findMovie('Anything', 2000), null);
  assert.ok(calls.every((url) => url.hostname === 'api.tvmaze.com'));
});

test('falls back to TVmaze when TMDB has no match for a show', async () => {
  const { fetchImpl } = fakeFetch([
    [isTmdb('/search/tv'), () => ({ results: [] })],
    [(url) => url.pathname === '/search/shows', () => [{ show: { id: 5, name: 'Obscure Show', premiered: '1999-01-01' } }]],
  ]);
  const client = new MetadataClient({ tmdbKey: 'key', fetchImpl });
  assert.equal((await client.findShow('Obscure Show')).source, 'TVmaze');
});

test('{on} renders the original title and previews use localised names', async () => {
  assert.equal(renderPattern('{n} [{on}] ({y})', { name: 'Der Pate', originalName: 'The Godfather', year: 1972 }), 'Der Pate [The Godfather] (1972)');
  assert.equal(renderPattern('{on}', { name: 'Only Name' }), 'Only Name');

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-locale-')));
  await fs.writeFile(path.join(root, 'The.Godfather.1972.1080p.mkv'), '');
  const { fetchImpl } = fakeFetch([
    [isTmdb('/search/movie'), () => ({ results: [{ id: 238, title: 'Der Pate', original_title: 'The Godfather', release_date: '1972-03-14' }] })],
  ]);
  const [item] = await buildPreview({
    root,
    files: ['The.Godfather.1972.1080p.mkv'],
    patterns: { movie: '{n} ({y})/{n} ({y})' },
    metadata: new MetadataClient({ tmdbKey: 'key', language: 'de-DE', region: 'DE', fetchImpl }),
  });
  assert.equal(item.newRel, 'Der Pate (1972)/Der Pate (1972).mkv');
  assert.equal(item.match, 'TMDB: Der Pate (1972)');
});
