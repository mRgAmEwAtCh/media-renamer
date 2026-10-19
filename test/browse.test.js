import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listDirectory, listPlaces } from '../lib/browse.js';
import { nativeDialogCommand, pickFolderNative } from '../lib/native-dialog.js';
import { InputError } from '../lib/renamer.js';

async function tempTree() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-browse-')));
  for (const dir of ['Shows', 'movies', '.hidden', 'Season 10', 'Season 2']) await fs.mkdir(path.join(root, dir));
  for (const file of ['a.mkv', 'b.srt', 'notes.txt']) await fs.writeFile(path.join(root, file), '');
  await fs.symlink(path.join(root, 'Shows'), path.join(root, 'Linked'));
  return root;
}

test('lists subfolders naturally sorted, counts media and hides dot folders', async () => {
  const root = await tempTree();
  const listing = await listDirectory(root);
  assert.deepEqual(listing.folders.map((f) => f.name), ['Linked', 'movies', 'Season 2', 'Season 10', 'Shows']);
  assert.equal(listing.mediaFiles, 2);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listing.breadcrumbs.at(-1).path, root);
  assert.equal(listing.breadcrumbs[0].path, path.parse(root).root);

  const withHidden = await listDirectory(root, { showHidden: true });
  assert.ok(withHidden.folders.some((f) => f.name === '.hidden'));
});

test('reports a missing folder as an input error and the filesystem root has no parent', async () => {
  await assert.rejects(listDirectory(path.join(os.tmpdir(), 'definitely-missing-folder-xyz')), InputError);
  const top = await listDirectory(path.parse(process.cwd()).root);
  assert.equal(top.parent, null);
});

test('places include home and only existing locations', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-home-')));
  await fs.mkdir(path.join(home, 'Movies'));
  const places = await listPlaces({ home });
  assert.equal(places[0].path, home);
  assert.ok(places.some((p) => p.label === 'Videos' && p.path === path.join(home, 'Movies')));
  assert.ok(!places.some((p) => p.label === 'Downloads'));
});

test('builds native dialog commands that pass the start folder as data', async () => {
  const start = '/tmp/it\'s "quoted"; rm -rf ~';
  const mac = await nativeDialogCommand({ platform: 'darwin', start });
  assert.equal(mac.command, 'osascript');
  assert.equal(mac.args.at(-1), start);
  assert.ok(!mac.args.slice(0, -1).some((arg) => arg.includes(start)));

  const windows = await nativeDialogCommand({ platform: 'win32', start: 'C:\\Media', env: {} });
  assert.equal(windows.command, 'powershell.exe');
  assert.equal(windows.env.MEDIA_RENAMER_START, 'C:\\Media');
  assert.ok(windows.args.includes('-STA'));

  const which = async (name) => (name === 'kdialog' ? '/usr/bin/kdialog' : null);
  const linux = await nativeDialogCommand({ platform: 'linux', start: '/srv', env: { DISPLAY: ':0' }, which });
  assert.deepEqual([linux.command, linux.args[1]], ['kdialog', '/srv']);
  assert.equal(await nativeDialogCommand({ platform: 'linux', start: '/srv', env: {}, which }), null, 'headless Linux has no dialog');
});

test('interprets native dialog results', async () => {
  const pick = (result, platform = 'darwin') => pickFolderNative({ platform, start: os.tmpdir(), run: async () => result });
  assert.deepEqual(await pick({ code: 0, stdout: '/Users/me/Movies/\n', stderr: '' }), { path: '/Users/me/Movies' });
  assert.deepEqual(await pick({ code: 1, stdout: '', stderr: 'User canceled. (-128)' }), { cancelled: true });
  await assert.rejects(pick({ code: 1, stdout: '', stderr: 'syntax error' }), /osascript failed/);
  assert.deepEqual(await pick({ code: 0, stdout: 'D:\\', stderr: '' }, 'win32'), { path: 'D:\\' });
  assert.deepEqual(await pick({ code: 0, stdout: '', stderr: '' }, 'win32'), { cancelled: true });
  await assert.rejects(
    pickFolderNative({ platform: 'linux', env: {}, run: async () => ({}) }),
    /No system folder dialog/,
  );
});
