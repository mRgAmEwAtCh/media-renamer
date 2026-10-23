/** The two kinds of media the renamer knows; each has its own pattern and destination. */
export const KINDS = Object.freeze(['episode', 'movie']);

export const DEFAULT_PATTERNS = Object.freeze({
  episode: '{n} - {s00e00} - {t}',
  movie: '{n} ({y})',
});

export const DEFAULT_FILTERS = Object.freeze({ videoOnly: false, excludeSamples: true });

/** Most files scanned or previewed at once. */
export const MAX_FILES = 5000;
