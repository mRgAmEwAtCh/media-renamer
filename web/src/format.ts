/** 1536 → "1.5 KB" */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 75 → "75 s", 600 → "10 min"; '' for unknown durations. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return `${Math.ceil(seconds)} s`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export const formatTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

export const formatDay = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : '');
