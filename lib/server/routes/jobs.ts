import { InputError } from '../../errors.ts';
import { applyRenames, undoLast } from '../../renamer.ts';
import type { JobControl, RenameRequest } from '../../types.ts';
import type { ApiResponse } from '../../api-types.ts';
import type { RouteContext } from '../context.ts';
import type { RequestBody, Routes } from '../http.ts';

/** One entry of `renames` as the client sent it. */
type RenameInput = { from?: unknown; to?: unknown; target?: unknown; overwrite?: unknown } | null | undefined;

/** Rename and undo jobs started from the web UI, and the job queue. */
export function jobRoutes({ jobs, policy, allowedRoot, allowedTarget }: RouteContext): Routes {
  /** Each rename's checked destination; renames without their own use the request's `target`. */
  async function resolveRenames(root: string, body: RequestBody): Promise<RenameRequest[]> {
    const fallback = await allowedTarget(root, body.target);
    const resolved = new Map<string, string | null>();
    const renames: RenameRequest[] = [];
    for (const rename of (body.renames ?? []) as RenameInput[]) {
      let target: string | null | undefined = fallback;
      if (rename && typeof rename === 'object' && Object.hasOwn(rename, 'target')) {
        const key = String(rename.target ?? '');
        if (!resolved.has(key)) resolved.set(key, await allowedTarget(root, rename.target));
        target = resolved.get(key);
      }
      renames.push({ from: rename?.from as string, to: rename?.to as string, target, ...(rename?.overwrite === true && { overwrite: true }) });
    }
    return renames;
  }

  return {
    async '/api/apply'(body: RequestBody): Promise<ApiResponse<'/api/apply'>> {
      const root = await allowedRoot(body.root);
      const remove = Array.isArray(body.remove) ? (body.remove as unknown[]) : [];
      const hasRenames = Array.isArray(body.renames) && body.renames.length > 0;
      if (!hasRenames && !remove.length) throw new InputError('Nothing to rename');
      if (body.renames !== undefined && !Array.isArray(body.renames)) throw new InputError('Nothing to rename');
      const renames = await resolveRenames(root, body);
      const targets = [...new Set(renames.map((rename) => rename.target).filter(Boolean))] as string[];
      const label = [renames.length && `Rename ${renames.length} file(s)`, remove.length && `delete ${remove.length}`].filter(Boolean).join(', ');
      return jobs.start({
        kind: 'apply',
        root,
        targets,
        label: label.charAt(0).toUpperCase() + label.slice(1),
        run: (control: JobControl) => applyRenames(root, renames, { owner: 'web UI', remove, ...control }),
      });
    },

    async '/api/undo'(body: RequestBody): Promise<ApiResponse<'/api/undo'>> {
      const root = await allowedRoot(body.root);
      return jobs.start({
        kind: 'undo',
        root,
        label: 'Undo last batch',
        run: (control: JobControl) => undoLast(root, { checkTarget: (target: string) => policy.check(target), owner: 'web UI', ...control }),
      });
    },

    async '/api/job'(body: RequestBody): Promise<ApiResponse<'/api/job'>> {
      return { job: jobs.get(typeof body.id === 'string' ? body.id : null) };
    },

    async '/api/jobs'(): Promise<ApiResponse<'/api/jobs'>> {
      return { jobs: jobs.list() };
    },

    async '/api/job/cancel'(body: RequestBody): Promise<ApiResponse<'/api/job/cancel'>> {
      if (typeof body.id !== 'string') throw new InputError('Job id required');
      return { job: jobs.cancel(body.id) };
    },

    async '/api/jobs/clear'(): Promise<ApiResponse<'/api/jobs/clear'>> {
      return { removed: await jobs.clear() };
    },
  };
}
