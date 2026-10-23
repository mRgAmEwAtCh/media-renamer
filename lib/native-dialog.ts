import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InputError } from './errors.ts';
import type { PickFolderResult } from './api-types.ts';

export type FindExecutable = (name: string, env: NodeJS.ProcessEnv) => Promise<string | null>;

/** How to launch the platform's folder dialog. */
export interface DialogCommand {
  tool: 'osascript' | 'powershell' | 'zenity' | 'kdialog';
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Exit codes that mean the user dismissed the dialog. */
  cancelCodes: number[];
}

export interface DialogCommandOptions {
  platform?: string;
  start: string;
  env?: NodeJS.ProcessEnv;
  which?: FindExecutable;
}

export interface DialogRunResult {
  /** Exit code, or an error code such as "ENOENT" when the command could not start. */
  code: number | string | null | undefined;
  killed: boolean;
  stdout: string;
  stderr: string;
}

export interface PickFolderOptions {
  start?: unknown;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  which?: FindExecutable;
  run?: (spec: DialogCommand) => Promise<DialogRunResult>;
}

export type { PickFolderResult };

const TITLE = 'Choose a media folder';
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

// The start folder reaches the dialog through argv or an environment variable,
// never by splicing it into script text, so paths cannot inject commands.
const MAC_SCRIPT = [
  'on run argv',
  'activate',
  `set picked to choose folder with prompt "${TITLE}" default location (POSIX file (item 1 of argv))`,
  'return POSIX path of picked',
  'end run',
];

const WINDOWS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${TITLE}'
$dialog.ShowNewFolderButton = $false
if ($env:MEDIA_RENAMER_START) { $dialog.SelectedPath = $env:MEDIA_RENAMER_START }
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
} finally { $owner.Dispose(); $dialog.Dispose() }
`;

async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env) {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this PATH entry.
    }
  }
  return null;
}

/** Describe the native folder dialog for this platform, or null when none is usable. */
export async function nativeDialogCommand(
  { platform = process.platform, start, env = process.env, which = findExecutable }: DialogCommandOptions = {} as DialogCommandOptions,
): Promise<DialogCommand | null> {
  if (platform === 'darwin') {
    return { tool: 'osascript', command: 'osascript', args: [...MAC_SCRIPT.flatMap((line) => ['-e', line]), start], env, cancelCodes: [1] };
  }
  if (platform === 'win32') {
    return {
      tool: 'powershell',
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      env: { ...env, MEDIA_RENAMER_START: start },
      cancelCodes: [],
    };
  }
  if (platform === 'linux' || platform === 'freebsd') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    if (await which('zenity', env)) {
      const args = ['--file-selection', '--directory', `--title=${TITLE}`, `--filename=${path.join(start, path.sep)}`];
      return { tool: 'zenity', command: 'zenity', args, env, cancelCodes: [1] };
    }
    if (await which('kdialog', env)) {
      return { tool: 'kdialog', command: 'kdialog', args: ['--getexistingdirectory', start, '--title', TITLE], env, cancelCodes: [1] };
    }
  }
  return null;
}

function runCommand({ command, args, env }: DialogCommand): Promise<DialogRunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { env, encoding: 'utf8', timeout: DIALOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, killed: Boolean(error?.killed), stdout, stderr });
    });
  });
}

let dialogOpen = false;

/**
 * Open the operating system's folder picker.
 * Resolves { path } on selection, { cancelled: true } when dismissed.
 */
export async function pickFolderNative(
  { start, platform = process.platform, env = process.env, which, run = runCommand }: PickFolderOptions = {},
): Promise<PickFolderResult> {
  let startDirectory = os.homedir();
  if (typeof start === 'string' && start.trim()) {
    const candidate = path.resolve(start.trim());
    if (await fs.stat(candidate).then((s) => s.isDirectory(), () => false)) startDirectory = candidate;
  }

  const spec = await nativeDialogCommand({ platform, start: startDirectory, env, which });
  if (!spec) throw new InputError('No system folder dialog is available on this machine; use the built-in browser');
  if (dialogOpen) throw new InputError('A folder dialog is already open');

  dialogOpen = true;
  try {
    const result = await run(spec);
    if (result.code === 'ENOENT') throw new InputError(`${spec.tool} is not installed`);
    if (result.killed) return { cancelled: true };
    const cancelled = spec.cancelCodes.includes(result.code as number) && (spec.tool !== 'osascript' || /-128/.test(result.stderr));
    if (cancelled) return { cancelled: true };
    if (result.code !== 0) throw new Error(`${spec.tool} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);

    let picked = result.stdout.replace(/\r?\n$/, '');
    if (!picked) return { cancelled: true };
    if (picked.length > 1 && /[\\/]$/.test(picked) && !/^[A-Za-z]:\\$/.test(picked)) picked = picked.slice(0, -1);
    return { path: picked };
  } finally {
    dialogOpen = false;
  }
}

export async function nativeDialogAvailable(options: Partial<DialogCommandOptions> = {}) {
  return Boolean(await nativeDialogCommand({ start: os.homedir(), ...options }));
}
