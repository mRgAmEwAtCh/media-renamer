import path from 'node:path';
import type { ParsedMedia } from './types.ts';

export const VIDEO_EXTENSIONS = new Set([
  '.3gp', '.avi', '.divx', '.flv', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.mts', '.ogv', '.ts',
  '.vob', '.webm', '.wmv',
]);
export const SUBTITLE_EXTENSIONS = new Set(['.ass', '.idx', '.srt', '.ssa', '.sub', '.vtt']);

const SAMPLE_FOLDER = /^samples?$/i;
const SAMPLE_NAME = /(^|[\s._\-[(])sample([\s._\-\])]|$)/i;

const LANGUAGE_CODES = new Set([
  'ar', 'ara', 'cs', 'ces', 'cze', 'da', 'dan', 'de', 'deu', 'ger', 'el', 'ell', 'gre', 'en', 'eng',
  'es', 'spa', 'fi', 'fin', 'fr', 'fra', 'fre', 'he', 'heb', 'hu', 'hun', 'it', 'ita', 'ja', 'jpn',
  'ko', 'kor', 'nl', 'nld', 'dut', 'no', 'nor', 'pl', 'pol', 'pt', 'por', 'ru', 'rus', 'sv', 'swe',
  'tr', 'tur', 'zh', 'zho', 'chi',
]);

const RELEASE_TAGS =
  /\b(2160p|1080p|1080i|720p|576p|480p|blu-?ray|bdrip|brrip|remux|web-?dl|webrip|hdtv|dvdrip|xvid|divx|x26[45]|h ?26[45]|hevc|proper|repack)\b/i;

const TV_PATTERNS = [
  /^(?<name>.*?)[\s-]*\bs(?<season>\d{1,2})[\s-]*e(?<episode>\d{1,3})(?:-?e(?<episodeEnd>\d{1,3}))?\b/i,
  /^(?<name>.*?)[\s-]*\b(?<season>\d{1,2})x(?<episode>\d{2,3})\b/i,
];

const SEASON_FOLDER = /^(season|series|staffel|saison)\s*\d+$|^specials?$/i;

export function isMediaFile(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension);
}

export function isVideoFile(fileName: string) {
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/** A folder that holds release samples, e.g. "Sample" or "Samples". */
export function isSampleFolder(name: string) {
  return SAMPLE_FOLDER.test(name);
}

/**
 * A release sample: inside a Sample(s) folder, or "sample" as a separate word
 * in the file name (sample.mkv, movie-sample.mkv, Movie.2010.SAMPLE.mkv).
 */
export function isSamplePath(relPath: string) {
  const parts = relPath.split(/[\\/]/);
  const fileName = parts.pop()!;
  if (parts.some(isSampleFolder)) return true;
  return SAMPLE_NAME.test(path.basename(fileName, path.extname(fileName)));
}

function normalize(text: string) {
  return text.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTitle(text: string) {
  let title = text.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
  const tag = title.match(RELEASE_TAGS);
  if (tag) title = title.slice(0, tag.index);
  return title
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–]+|[\s\-–([]+$/g, '')
    .trim();
}

function splitTitleYear(text: string): { title: string; year: number | null } {
  const maxYear = new Date().getFullYear() + 1;
  const yearPattern = /(^|[\s([])((?:19|20)\d{2})(?=$|[\s)\]])/g;
  let chosen: RegExpExecArray | null = null;
  for (const match of text.matchAll(yearPattern)) {
    const year = Number(match[2]);
    if (match.index + match[1].length > 0 && year <= maxYear) chosen = match;
  }
  if (!chosen) return { title: cleanTitle(text), year: null };
  return { title: cleanTitle(text.slice(0, chosen.index)), year: Number(chosen[2]) };
}

function seriesFromFolders(folderNames: string[]) {
  for (const folder of folderNames) {
    const name = normalize(folder);
    if (!name || SEASON_FOLDER.test(name)) continue;
    return splitTitleYear(name);
  }
  return { title: '', year: null };
}

/**
 * Parse a media file name into movie or episode facts.
 * folderNames lists parent directories from nearest to farthest and is used
 * when an episode file name carries no series name.
 */
export function parseMediaFile(fileName: string, { folderNames = [] }: { folderNames?: string[] } = {}): ParsedMedia {
  const rawExtension = path.extname(fileName);
  const extension = rawExtension.toLowerCase();
  const isSubtitle = SUBTITLE_EXTENSIONS.has(extension);
  let base = path.basename(fileName, rawExtension);
  let language: string | null = null;

  if (isSubtitle) {
    const match = base.match(/[._ -]([a-z]{2,3})$/i);
    if (match && LANGUAGE_CODES.has(match[1].toLowerCase())) {
      language = match[1].toLowerCase();
      base = base.slice(0, -match[0].length);
    }
  }

  const common = { extension, isSubtitle, language };
  const text = normalize(base);

  for (const pattern of TV_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    let { title, year } = splitTitleYear(match.groups!.name);
    if (!title) ({ title, year } = seriesFromFolders(folderNames));
    return {
      kind: 'episode',
      title,
      year,
      season: Number(match.groups!.season),
      episode: Number(match.groups!.episode),
      episodeEnd: match.groups!.episodeEnd ? Number(match.groups!.episodeEnd) : null,
      ...common,
    };
  }

  const { title, year } = splitTitleYear(text);
  if (!title) return { kind: 'unknown', title: '', year: null, ...common };
  return { kind: 'movie', title, year, ...common };
}
