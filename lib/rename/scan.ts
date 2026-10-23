import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FILTERS, MAX_FILES } from '../defaults.ts';
import { isMediaFile, isSampleFolder, isSamplePath, isVideoFile, parseMediaFile } from '../parse.ts';
import { toPosix } from '../paths.ts';
import type { Filters, ParsedMedia } from '../types.ts';

export interface ScanOptions extends Partial<Filters> {
  recursive?: boolean;
  /** Most files to return; more set `truncated`. */
  limit?: number;
}

export interface ScanResult {
  files: string[];
  truncated: boolean;
  excluded: { samples: number; nonVideo: number };
}

/** Why a file is left out by the filters, or null when it should be processed. */
export function filterReason(rel: string, { videoOnly = DEFAULT_FILTERS.videoOnly, excludeSamples = DEFAULT_FILTERS.excludeSamples }: Partial<Filters> = {}): string | null {
  const fileName = path.posix.basename(rel);
  if (!isMediaFile(fileName)) return 'Not a media file';
  if (videoOnly && !isVideoFile(fileName)) return 'Not a video file (video-only filter)';
  if (excludeSamples && isSamplePath(rel)) return 'Sample file (sample filter)';
  return null;
}

/** Media files under `root` (sorted, root-relative POSIX paths) and how many the filters left out. */
export async function scanFolder(root: string, { recursive = true, limit = MAX_FILES, ...filterOptions }: ScanOptions = {}): Promise<ScanResult> {
  const filters = { ...DEFAULT_FILTERS, ...filterOptions };
  const files: string[] = [];
  const excluded: ScanResult['excluded'] = { samples: 0, nonVideo: 0 };
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (filters.excludeSamples && isSampleFolder(entry.name)) {
          excluded.samples += await countMediaFiles(absolute);
          continue;
        }
        await walk(absolute);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        const rel = toPosix(path.relative(root, absolute));
        const reason = filterReason(rel, filters);
        if (reason) {
          excluded[reason.startsWith('Sample') ? 'samples' : 'nonVideo'] += 1;
          continue;
        }
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
      if (truncated) return;
    }
  }

  await walk(root);
  return { files, truncated, excluded };
}

async function countMediaFiles(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && isMediaFile(entry.name)) count += 1;
  }
  return count;
}

/** Parse a root-relative path, using the folder names as hints (nearest first). */
export function parseRelativePath(rel: string): ParsedMedia {
  const parts = rel.split('/');
  const fileName = parts.pop() ?? '';
  return parseMediaFile(fileName, { folderNames: parts.reverse() });
}
