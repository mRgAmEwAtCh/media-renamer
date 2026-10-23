// Small parsers shared by the environment defaults and saved-settings validation.

import type { MediaKind } from '../types.ts';

export const KIND_LABEL: Record<MediaKind, string> = { episode: 'TV', movie: 'Movie' };
export const AUDIO_LANGUAGE = /^[a-z]{2,3}$/;
const AUDIO_BITRATE = /^(\d{3,4})k$/;

export const blankToNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** "de, EN" → ['de', 'en'] */
export const csv = (value: unknown): string[] =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** Normalised bitrate such as "1024k" (192k–1536k), or null. */
export function validAudioBitrate(value: unknown): string | null {
  const match = String(value ?? '').trim().toLowerCase().match(AUDIO_BITRATE);
  const kbps = match ? Number(match[1]) : NaN;
  return kbps >= 192 && kbps <= 1536 ? `${kbps}k` : null;
}
