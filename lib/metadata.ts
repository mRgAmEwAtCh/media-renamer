import { sleep } from './async.ts';
import type { EpisodeMatch, MetadataSource, MovieMatch, ShowMatch } from './types.ts';

// The fields read from TMDB and TVmaze responses. Responses are untrusted JSON;
// getJson is the one place where they are given these shapes.
interface TmdbSearch<T> {
  results?: T[];
}

interface TmdbTvShow {
  id: number;
  name: string;
  original_name: string;
  first_air_date?: string;
}

interface TmdbMovie {
  id: number;
  title: string;
  original_title: string;
  release_date?: string;
}

interface TmdbEpisode {
  name: string;
  air_date?: string;
}

interface TvmazeShow {
  id: number;
  name: string;
  premiered?: string | null;
  url?: string;
}

interface TvmazeSearchResult {
  show: TvmazeShow;
}

interface TvmazeEpisode {
  name: string;
  airdate?: string;
}

export interface MetadataClientOptions {
  tmdbKey?: string;
  language?: string | null;
  region?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type QueryParams = Record<string, string | number | null | undefined>;

const yearOf = (date: string | null | undefined) => (date ? Number(String(date).slice(0, 4)) || null : null);

export const DEFAULT_LANGUAGE = 'en-US';

/** Normalise "de", "de-de" or "de_DE" to TMDB's form ("de", "de-DE"); throws on garbage. */
export function normalizeLanguage(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const match = String(value).trim().match(/^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2}))?$/);
  if (!match) throw new Error(`Invalid language "${value}" (expected e.g. de-DE, en-US, fr)`);
  return match[2] ? `${match[1].toLowerCase()}-${match[2].toUpperCase()}` : match[1].toLowerCase();
}

/** Normalise an ISO 3166-1 region ("de" -> "DE"); throws on garbage. */
export function normalizeRegion(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const region = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new Error(`Invalid region "${value}" (expected a 2-letter country code, e.g. DE)`);
  return region;
}

// Placeholder titles TMDB returns when an episode has no translation yet ("Episode 3", "Folge 3", …).
const GENERIC_EPISODE = /^\s*[\p{L}.]+\s*#?\d+\s*$/u;
const isGenericEpisodeTitle = (title: string | null | undefined) => !title || GENERIC_EPISODE.test(title);

/**
 * Looks up movies (TMDB) and TV episodes. With a TMDB key, TV titles also come
 * from TMDB so they can be localised; otherwise TVmaze (English only) is used.
 * `language` (e.g. de-DE) and `region` (e.g. DE) control localisation.
 */
export class MetadataClient implements MetadataSource {
  tmdbKey: string;
  language: string;
  region: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  cache: Map<string, Promise<unknown>>;

  constructor({ tmdbKey = '', language = DEFAULT_LANGUAGE, region = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 }: MetadataClientOptions = {}) {
    this.tmdbKey = tmdbKey.trim();
    this.language = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
    this.region = normalizeRegion(region);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  get languageCode(): string {
    return this.language.split('-')[0];
  }

  cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) {
      const pending = loader().catch((error) => {
        this.cache.delete(key);
        throw error;
      });
      this.cache.set(key, pending);
    }
    return this.cache.get(key) as Promise<T>;
  }

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 429 && attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${new URL(url).hostname} responded with HTTP ${response.status}`);
      return response.json() as Promise<T>;
    }
  }

  tmdb<T>(pathname: string, params: QueryParams = {}) {
    const url = new URL(`https://api.themoviedb.org/3${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {};
    if (this.tmdbKey.startsWith('eyJ')) headers.Authorization = `Bearer ${this.tmdbKey}`;
    else url.searchParams.set('api_key', this.tmdbKey);
    return this.getJson<T>(url.href, headers);
  }

  findShow(name: string, year: number | null) {
    return this.cached<ShowMatch | null>(`show:${this.language}:${name.toLowerCase()}:${year ?? ''}`, async () => {
      if (this.tmdbKey) {
        const show = await this.findTmdbShow(name, year);
        if (show) return show;
      }
      return this.findTvmazeShow(name, year);
    });
  }

  async findTmdbShow(name: string, year: number | null): Promise<ShowMatch | null> {
    const search = (withYear: boolean) => this.tmdb<TmdbSearch<TmdbTvShow>>('/search/tv', { query: name, language: this.language, first_air_date_year: withYear ? year : null });
    let data = await search(Boolean(year));
    if (year && !data?.results?.length) data = await search(false);
    const show = data?.results?.[0];
    if (!show) return null;
    return {
      source: 'TMDB',
      id: show.id,
      name: show.name || show.original_name,
      originalName: show.original_name ?? null,
      year: yearOf(show.first_air_date),
    };
  }

  async findTvmazeShow(name: string, year: number | null): Promise<ShowMatch | null> {
    const results = await this.getJson<TvmazeSearchResult[]>(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`);
    if (!results?.length) return null;
    const byYear = year ? results.find((r) => yearOf(r.show.premiered) === year) : null;
    const show = (byYear ?? results[0]).show;
    return { source: 'TVmaze', id: show.id, name: show.name, originalName: show.name, year: yearOf(show.premiered), url: show.url };
  }

  /** `show` is a result of findShow (a bare id is treated as a TVmaze show id). */
  findEpisode(show: ShowMatch | number, season: number | undefined, episode: number | undefined) {
    const ref: Pick<ShowMatch, 'source' | 'id'> = typeof show === 'object' && show ? show : { source: 'TVmaze', id: show };
    return this.cached<EpisodeMatch | null>(`episode:${ref.source}:${ref.id}:${this.language}:${season}:${episode}`, async () => {
      if (ref.source === 'TMDB') return this.findTmdbEpisode(ref.id, season, episode);
      const result = await this.getJson<TvmazeEpisode>(`https://api.tvmaze.com/shows/${ref.id}/episodebynumber?season=${season}&number=${episode}`);
      return result ? { title: result.name, airdate: result.airdate || null } : null;
    });
  }

  async findTmdbEpisode(showId: number, season: number | undefined, episode: number | undefined): Promise<EpisodeMatch | null> {
    const load = (language: string) => this.tmdb<TmdbEpisode>(`/tv/${showId}/season/${season}/episode/${episode}`, { language });
    const localized = await load(this.language);
    if (!localized) return null;
    let title = localized.name;
    if (isGenericEpisodeTitle(title) && this.languageCode !== 'en') {
      const english = await load('en-US');
      if (english && !isGenericEpisodeTitle(english.name)) title = english.name;
    }
    return { title, airdate: localized.air_date || null };
  }

  findMovie(title: string, year: number | null) {
    if (!this.tmdbKey) return Promise.resolve(null);
    return this.cached<MovieMatch | null>(`movie:${this.language}:${this.region ?? ''}:${title.toLowerCase()}:${year ?? ''}`, async () => {
      const search = (params: QueryParams) => this.tmdb<TmdbSearch<TmdbMovie>>('/search/movie', { query: title, language: this.language, ...params });
      // Region narrows matches to releases in that country; fall back to a global search.
      const attempts: QueryParams[] = [
        { year, region: this.region },
        ...(this.region ? [{ year }] : []),
        ...(year ? [{}] : []),
      ];
      for (const params of attempts) {
        const movie = (await search(params))?.results?.[0];
        if (movie) {
          return {
            source: 'TMDB',
            id: movie.id,
            name: movie.title || movie.original_title,
            originalName: movie.original_title ?? null,
            year: yearOf(movie.release_date),
          };
        }
      }
      return null;
    });
  }
}
