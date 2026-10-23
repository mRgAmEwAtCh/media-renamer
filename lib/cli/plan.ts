import { readFile } from 'node:fs/promises';
import { InputError, resolveRoot, resolveTarget } from '../renamer.ts';
import type { DoneRename, ItemStatus, ParsedKind, PreviewItem } from '../types.ts';
import { readStdin, splitRecords } from './args.ts';
import type { CliValues } from './args.ts';
import type { CliContext } from './context.ts';

/** A preview item, or an item read from a plan (where the kind may be missing). */
export type PlanItem = Omit<PreviewItem, 'kind'> & { kind: ParsedKind | null };

/** A rename to perform: `from` in the root, `to` in `target` (or the root when null). */
export type PlannedRename = Pick<DoneRename, 'from' | 'to' | 'target'>;

/** Parsed plan JSON as far as the code relies on it; anything else is untrusted input. */
type PlanJson = Record<string, unknown> | unknown[] | null;

/** Configured destination for an item's kind; items without a kind need one shared destination. */
function targetForKind(ctx: CliContext, kind: ParsedKind | null, rel: string): string | null {
  if (kind === 'episode' || kind === 'movie') return ctx.targets[kind];
  if (ctx.targets.episode === ctx.targets.movie) return ctx.targets.episode;
  throw new InputError(`Plan item ${rel} has neither a kind nor a target; pass one --target for all files`);
}

/** JSON (a preview/apply document or an array) or JSON Lines. */
function parsePlan(text: string): { header: Record<string, unknown>; entries: unknown } {
  let parsed: PlanJson;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = splitRecords(text, false).map((line): unknown => JSON.parse(line));
    } catch {
      throw new InputError('Plan must be JSON or JSON Lines from "preview"');
    }
  }
  if (parsed && !Array.isArray(parsed) && !parsed.items && !parsed.renames && ('rel' in parsed || 'from' in parsed)) {
    parsed = [parsed]; // A single JSON Lines record is also valid JSON.
  }
  const header = parsed && !Array.isArray(parsed) ? parsed : {};
  const entries = Array.isArray(parsed) ? parsed : (parsed?.items ?? parsed?.renames);
  return { header, entries };
}

/** Load a plan from a file or stdin ("-") and resolve each item's destination. */
export async function loadPlan(ctx: CliContext, source: string): Promise<{ items: PlanItem[] }> {
  const { header, entries } = parsePlan(source === '-' ? await readStdin() : await readFile(source, 'utf8'));
  if (header.root && (await resolveRoot(header.root)) !== ctx.root) {
    throw new InputError(`Plan was made for ${header.root}, not ${ctx.root}`);
  }
  if (!Array.isArray(entries)) throw new InputError('Plan has no items');

  const resolved = new Map<string, string | null>();
  const resolve = async (value: unknown): Promise<string | null> => {
    const key = String(value ?? '');
    if (!resolved.has(key)) resolved.set(key, await resolveTarget(ctx.root, value));
    return resolved.get(key) as string | null;
  };
  const headerTargets = header.targets && typeof header.targets === 'object' ? (header.targets as Record<string, unknown>) : null;

  // Destinations come from the plan item, then the plan header, then --target flags or defaults.
  const items: PlanItem[] = [];
  for (const entry of entries as Record<string, unknown>[]) {
    const rel = (entry.from ?? entry.rel) as string;
    const kind = (entry.kind ?? null) as ParsedKind | null;
    let target: string | null;
    if (Object.hasOwn(entry, 'target')) target = await resolve(entry.target);
    else if (headerTargets && Object.hasOwn(headerTargets, kind ?? '')) target = await resolve(headerTargets[kind as string]);
    else if (Object.hasOwn(header, 'target')) target = await resolve(header.target);
    else target = targetForKind(ctx, kind, rel);
    if (ctx.explicitTarget) {
      const wanted = targetForKind(ctx, kind, rel);
      if (wanted !== target) {
        throw new InputError(`Plan moves files to ${target ?? 'their own folder'}, not ${wanted ?? 'their own folder'} (${rel})`);
      }
    }
    items.push({
      rel,
      newRel: (entry.to ?? entry.newRel) as string | null,
      kind,
      target,
      status: (entry.status ?? 'ok') as ItemStatus,
      match: (entry.match ?? null) as string | null,
      message: (entry.message ?? null) as string | null,
    });
  }
  return { items };
}

/** The renames to apply: confident items (and warnings with --include-warnings) that change something. */
export function selectRenames(items: PlanItem[], values: Pick<CliValues, 'include-warnings'>): PlannedRename[] {
  const allowed = new Set(values['include-warnings'] ? ['ok', 'warning'] : ['ok']);
  return items
    .filter((item) => allowed.has(item.status) && item.newRel && (item.target || item.newRel !== item.rel))
    .map((item) => ({ from: item.rel, to: item.newRel as string, target: item.target ?? null }));
}
