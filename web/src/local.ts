// The browser only remembers the last source folder; everything else is saved on the server.
const LOCAL_KEY = 'media-renamer:settings';

/** What this browser remembers. Earlier versions also kept patterns and a destination here. */
export interface LocalSettings {
  root?: string;
  recursive?: boolean;
  episodePattern?: string;
  moviePattern?: string;
  target?: string;
  moveEnabled?: boolean;
  language?: string;
  region?: string;
}

export function readLocal(): LocalSettings {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as LocalSettings;
  } catch {
    return {};
  }
}

/** Keep only the source folder; this also drops the fields of earlier versions. */
export function saveLocal(root: string, recursive: boolean): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ root: root.trim(), recursive }));
}
