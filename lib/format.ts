/** Values a naming pattern can refer to; missing ones render as empty. */
export interface PatternValues {
  name?: string;
  originalName?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  episodeEnd?: number | null;
  title?: string | null;
  airdate?: string | null;
}

type TokenValue = string | number | null | undefined;

const pad = (value: unknown, width = 2) => String(value).padStart(width, '0');
const present = (...values: unknown[]) => values.every((value) => value !== null && value !== undefined && value !== '');

const TOKENS: Record<string, (v: PatternValues) => TokenValue> = {
  n: (v) => v.name,
  on: (v) => v.originalName ?? v.name,
  y: (v) => v.year,
  s: (v) => v.season,
  s00: (v) => (present(v.season) ? pad(v.season) : null),
  e: (v) => v.episode,
  e00: (v) => (present(v.episode) ? pad(v.episode) : null),
  s00e00: (v) =>
    present(v.season, v.episode)
      ? `S${pad(v.season)}E${pad(v.episode)}${v.episodeEnd ? `-E${pad(v.episodeEnd)}` : ''}`
      : null,
  sxe: (v) => (present(v.season, v.episode) ? `${v.season}x${pad(v.episode)}` : null),
  t: (v) => v.title,
  d: (v) => v.airdate,
};

export const TOKEN_NAMES = Object.keys(TOKENS);

export function validatePattern(pattern: unknown): asserts pattern is string {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('Naming pattern must not be empty');
  const unknown = [...pattern.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1])
    .filter((token) => !Object.hasOwn(TOKENS, token));
  if (unknown.length) throw new Error(`Unknown pattern token(s): ${unknown.map((t) => `{${t}}`).join(', ')}`);
}

function cleanSegment(segment: string) {
  return segment
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[<>"\\|?*\u0000-\u001f]/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s+-)+\s+(?=-\s)/g, ' ')
    .replace(/^[\s.\-]+|[\s.\-]+$/g, '')
    .slice(0, 200)
    .trim();
}

/** Render a naming pattern into a relative path without an extension. */
export function renderPattern(pattern: string, values: PatternValues) {
  validatePattern(pattern);
  const rendered = pattern.replace(/\{([^{}]*)\}/g, (_, token: string) => {
    const value = TOKENS[token](values);
    return present(value) ? String(value).replace(/[/\\]/g, '-') : '';
  });
  return rendered.split('/').map(cleanSegment).filter(Boolean).join('/');
}
