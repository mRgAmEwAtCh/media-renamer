import { InputError } from '../../errors.js';
import { applyRenames, undoLast } from '../../renamer.js';

/** Rename and undo jobs started from the web UI, and the job queue. */
export function jobRoutes({ jobs, policy, allowedRoot, allowedTarget }) {
  /** Each rename's checked destination; renames without their own use the request's `target`. */
  async function resolveRenames(root, body) {
    const fallback = await allowedTarget(root, body.target);
    const resolved = new Map();
    const renames = [];
    for (const rename of body.renames) {
      let target = fallback;
      if (rename && typeof rename === 'object' && Object.hasOwn(rename, 'target')) {
        const key = String(rename.target ?? '');
        if (!resolved.has(key)) resolved.set(key, await allowedTarget(root, rename.target));
        target = resolved.get(key);
      }
      renames.push({ from: rename?.from, to: rename?.to, target });
    }
    return renames;
  }

  return {
    async '/api/apply'(body) {
      const root = await allowedRoot(body.root);
      if (!Array.isArray(body.renames) || body.renames.length === 0) throw new InputError('Nothing to rename');
      const renames = await resolveRenames(root, body);
      const targets = [...new Set(renames.map((rename) => rename.target).filter(Boolean))];
      return jobs.start({
        kind: 'apply',
        root,
        targets,
        label: `Rename ${renames.length} file(s)`,
        run: (control) => applyRenames(root, renames, { owner: 'web UI', ...control }),
      });
    },

    async '/api/undo'(body) {
      const root = await allowedRoot(body.root);
      return jobs.start({
        kind: 'undo',
        root,
        label: 'Undo last batch',
        run: (control) => undoLast(root, { checkTarget: (target) => policy.check(target), owner: 'web UI', ...control }),
      });
    },

    async '/api/job'(body) {
      return { job: jobs.get(typeof body.id === 'string' ? body.id : null) };
    },

    async '/api/jobs'() {
      return { jobs: jobs.list() };
    },

    async '/api/job/cancel'(body) {
      if (typeof body.id !== 'string') throw new InputError('Job id required');
      return { job: jobs.cancel(body.id) };
    },

    async '/api/jobs/clear'() {
      return { removed: await jobs.clear() };
    },
  };
}
