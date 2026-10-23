import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { mapPath } from '../config.ts';
import { InputError } from '../errors.ts';
import { runImport } from '../importer.ts';
import type { JobControl, JobRunner, JobSnapshot } from '../types.ts';
import type { RouteContext } from './context.ts';
import { readJsonOrForm } from './http.ts';
import type { RootCheck } from './root-policy.ts';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * POST /api/hooks/extracted: a downloader reports a finished folder or file and
 * an automatic import is queued for it. `resume` re-creates the runner for an
 * import that was queued or interrupted before a restart.
 */
export function createHook({ config, jobs, policy, currentSettings, metadataFor }: RouteContext) {
  /** Runs one automatic import with the settings that apply when it starts. */
  const importRunner = (root: string, target: string): JobRunner => async (control: JobControl) => {
    await policy.check(target);
    const { effective } = await currentSettings();
    return runImport({
      root,
      target,
      settings: effective,
      metadata: metadataFor(effective),
      audioTools: config.audioTools,
      stableSeconds: config.stableSeconds,
      control,
      owner: 'automatic import',
    });
  };

  function authorize(request: IncomingMessage): void {
    if (!config.hookToken) throw new InputError('The import hook is switched off; set MEDIA_RENAMER_HOOK_TOKEN', { status: 404 });
    const header = String(request.headers.authorization ?? '');
    const token = header.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? request.headers['x-hook-token'];
    if (!token || !timingSafeEqual(digest(String(token)), digest(config.hookToken))) {
      throw new InputError('Missing or wrong hook token', { status: 401 });
    }
  }

  /** The allowed real path for a path as the downloader sees it. */
  async function locate(requested: string): Promise<RootCheck> {
    const mapped = mapPath(requested, config.pathMap);
    return policy.check(mapped).catch((error: unknown) => {
      if ((error as InputError).status === 403) throw error;
      throw new InputError(`Not found: ${mapped}${mapped === requested ? '' : ` (sent as ${requested})`}`, { status: 404 });
    });
  }

  async function hook(request: IncomingMessage): Promise<JobSnapshot & { duplicate?: boolean }> {
    authorize(request);
    const body = await readJsonOrForm(request);
    const requested = String(body.path ?? body.ARCHIVE_PATH ?? '').trim();
    if (!requested) throw new InputError('Send the folder or file as "path" (JSON) or ARCHIVE_PATH (form field)');
    const { effective } = await currentSettings();
    if (!effective.automation.enabled) throw new InputError('Automatic import is switched off in the settings', { status: 409 });

    const located = await locate(requested);
    const stat = await fs.stat(located.real);
    const root = located.root ?? (stat.isDirectory() ? located.real : path.dirname(located.real));
    const existing = jobs.findActive((job) => job.kind === 'import' && job.params?.path === located.real);
    if (existing) return { ...existing, duplicate: true };
    return jobs.start({
      kind: 'import',
      root,
      params: { path: located.real, requested },
      label: path.basename(located.real),
      source: 'hook',
      run: importRunner(root, located.real),
    });
  }

  const resume = (job: JobSnapshot): JobRunner | null => (job.kind === 'import' && job.params?.path ? importRunner(job.root, job.params.path) : null);

  return { hook, resume };
}
