import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FILTERS, MAX_FILES } from '../defaults.ts';
import { isMediaFile, isSampleFolder, isSamplePath, isVideoFile, parseMediaFile } from '../parse.ts';
import { toPosix } from '../paths.ts';

/** Why a file is left out by the filters, or null when it should be processed. */
export function filterReason(rel, { videoOnly = DEFAULT_FILTERS.videoOnly, excludeSamples = DEFAULT_FILTERS.excludeSamples } = {}) {
  const fileName = path.posix.basename(rel);
  if (!isMediaFile(fileName)) return 'Not a media file';
  if (videoOnly && !isVideoFile(fileName)) return 'Not a video file (video-only filter)';
  if (excludeSamples && isSamplePath(rel)) return 'Sample file (sample filter)';
  return null;
}

/** Media files under `root` (sorted, root-relative POSIX paths) and how many the filters left out. */
export async function scanFolder(root, { recursive = true, limit = MAX_FILES, ...filterOptions } = {}) {
  const filters = { ...DEFAULT_FILTERS, ...filterOptions };
  const files = [];
  const excluded = { samples: 0, nonVideo: 0 };
  let truncated = false;

  async function walk(directory) {
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

async function countMediaFiles(directory) {
  let count = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && isMediaFile(entry.name)) count += 1;
  }
  return count;
}

/** Parse a root-relative path, using the folder names as hints (nearest first). */
export function parseRelativePath(rel) {
  const parts = rel.split('/');
  const fileName = parts.pop();
  return parseMediaFile(fileName, { folderNames: parts.reverse() });
}
