import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMediaFile } from './parse.ts';
import { InputError } from './errors.ts';

const MAX_FOLDERS = 5000;
const PROBE_TIMEOUT_MS = 1500;
const WINDOWS_SYSTEM_NAMES = new Set([
  '$recycle.bin', '$windows.~bt', '$windows.~ws', '$winreagent', 'config.msi', 'recovery',
  'system volume information', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp',
]);

const isHidden = (name) => name.startsWith('.') || WINDOWS_SYSTEM_NAMES.has(name.toLowerCase());
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** stat() with a deadline, so a disconnected network drive cannot stall the listing. */
async function isDirectory(target) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  const probe = fs.stat(target).then((stat) => stat.isDirectory(), () => false);
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function childFolders(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const folders = [];
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const target = path.join(parent, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(target)))) {
        folders.push({ name: entry.name, path: target });
      }
    }
    return folders.sort(byName);
  } catch {
    return [];
  }
}

/** Quick-access locations: home folders plus drives (Windows) or mounted volumes (macOS/Linux). */
export async function listPlaces({ platform = process.platform, home = os.homedir() } = {}) {
  const candidates = [{ label: 'Home', path: home, kind: 'home' }];
  for (const [label, names] of [['Desktop', ['Desktop']], ['Downloads', ['Downloads']], ['Videos', ['Videos', 'Movies']]]) {
    for (const name of names) candidates.push({ label, path: path.join(home, name), kind: 'folder', group: label });
  }

  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') candidates.push({ label: `${letter}:`, path: `${letter}:\\`, kind: 'drive' });
  } else {
    candidates.push({ label: platform === 'darwin' ? 'Computer' : 'File system', path: '/', kind: 'drive' });
    const user = os.userInfo().username;
    const mountParents = platform === 'darwin' ? ['/Volumes'] : [`/media/${user}`, '/media', `/run/media/${user}`, '/mnt'];
    for (const parent of mountParents) {
      for (const volume of await childFolders(parent)) {
        if (parent === '/media' && volume.name === user) continue;
        const real = await fs.realpath(volume.path).catch(() => volume.path);
        if (real === '/') continue;
        candidates.push({ label: volume.name, path: volume.path, kind: 'volume' });
      }
    }
  }

  const present = await Promise.all(candidates.map((place) => isDirectory(place.path)));
  const places = [];
  const seenGroups = new Set();
  candidates.forEach((place, index) => {
    if (!present[index] || places.some((p) => p.path === place.path)) return;
    if (place.group) {
      if (seenGroups.has(place.group)) return;
      seenGroups.add(place.group);
    }
    places.push({ label: place.label, path: place.path, kind: place.kind });
  });
  return places;
}

function breadcrumbs(directory) {
  const crumbs = [];
  for (let current = directory; ; current = path.dirname(current)) {
    const parent = path.dirname(current);
    crumbs.unshift({ label: parent === current ? current : path.basename(current), path: current });
    if (parent === current) return crumbs;
  }
}

/** List the subfolders of one directory and count the media files directly inside it. */
export async function listDirectory(input, { showHidden = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new InputError('A folder path is required');
  const directory = path.resolve(input.trim());

  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new InputError(`Permission denied: ${directory}`);
    if (error.code === 'ENOTDIR') throw new InputError(`Not a folder: ${directory}`);
    throw new InputError(`Folder not found: ${directory}`);
  }

  const folders = [];
  let mediaFiles = 0;
  for (const entry of entries) {
    if (!showHidden && isHidden(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(target)))) {
      folders.push({ name: entry.name, path: target });
    } else if (entry.isFile() && isMediaFile(entry.name)) {
      mediaFiles += 1;
    }
  }
  folders.sort(byName);

  const parent = path.dirname(directory);
  return {
    path: directory,
    parent: parent === directory ? null : parent,
    separator: path.sep,
    breadcrumbs: breadcrumbs(directory),
    folders: folders.slice(0, MAX_FOLDERS),
    truncated: folders.length > MAX_FOLDERS,
    mediaFiles,
  };
}
