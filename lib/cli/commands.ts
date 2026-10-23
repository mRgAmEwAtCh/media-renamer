import { applyRenames, buildPreview, parseRelativePath, scanFolder, undoLast } from '../renamer.ts';
import { EXIT, readStdin, splitRecords, UsageError } from './args.ts';
import { createMetadata } from './context.ts';
import { importCommand } from './import-command.ts';
import { describeTargets, display, logExcluded, printItems, printRenames } from './output.ts';
import { loadPlan, selectRenames } from './plan.ts';
import { runWithProgress } from './progress.ts';

const PROBLEM_STATUSES = new Set(['error', 'conflict']);

async function scanFiles(ctx, values, output) {
  const { files, truncated, excluded } = await scanFolder(ctx.root, { recursive: !values['no-recursive'], ...ctx.filters });
  if (truncated) output.log(`warning: stopped after ${files.length} files`);
  logExcluded(excluded, output);
  return { files, truncated, excluded };
}

/** Files named on the command line or stdin, else everything found in the folder. */
async function collectFiles(ctx, positionals, values, output) {
  const files = [...positionals];
  if (values.stdin) files.push(...splitRecords(await readStdin(), values.null));
  if (files.length) return files;
  return (await scanFiles(ctx, values, output)).files;
}

async function previewItems(ctx, positionals, values, output) {
  const files = await collectFiles(ctx, positionals, values, output);
  output.log(`Looking up ${files.length} file(s) in ${ctx.language}${ctx.region ? `/${ctx.region}` : ''}…${describeTargets(ctx.targets)}`);
  return buildPreview({ root: ctx.root, targets: ctx.targets, files, patterns: ctx.patterns, filters: ctx.filters, metadata: createMetadata(ctx) });
}

/** The one destination shared by all renames (null when in place or spread over several). */
function sharedTarget(renames) {
  const distinct = [...new Set(renames.map((r) => r.target ?? null))];
  return distinct.length === 1 ? distinct[0] : null;
}

async function scan(ctx, positionals, values, output) {
  if (positionals.length) throw new UsageError('scan takes only <dir>');
  const { root } = ctx;
  const { files, truncated, excluded } = await scanFiles(ctx, values, output);
  const entries = files.map((rel) => ({ rel: display(root, rel, values.absolute), parsed: parseRelativePath(rel) }));
  output.emit(entries, {
    document: () => ({ root, truncated, excluded, filters: ctx.filters, files: entries }),
    fields: ({ rel, parsed: p }) => [rel, p.kind, p.title, p.year, p.season, p.episode],
    line: ({ rel, parsed: p }) => {
      const detail = p.kind === 'episode' ? `${p.title} S${p.season}E${p.episode}` : `${p.title}${p.year ? ` (${p.year})` : ''}`;
      return `${p.kind.padEnd(8)} ${rel}  [${detail}]\n`;
    },
  });
  return EXIT.ok;
}

async function preview(ctx, positionals, values, output) {
  const items = await previewItems(ctx, positionals, values, output);
  printItems(ctx, items, values, output);
  return values.strict && items.some((i) => PROBLEM_STATUSES.has(i.status)) ? EXIT.unresolved : EXIT.ok;
}

async function apply(ctx, positionals, values, output) {
  if (values.plan && (positionals.length || values.stdin)) throw new UsageError('--plan cannot be combined with file arguments or --stdin');
  const items = values.plan ? (await loadPlan(ctx, values.plan)).items : await previewItems(ctx, positionals, values, output);
  const problems = items.filter((i) => PROBLEM_STATUSES.has(i.status));
  if (values.strict && problems.length) {
    printItems(ctx, problems, values, output);
    output.log(`Not applied: ${problems.length} item(s) need attention (--strict)`);
    return EXIT.unresolved;
  }
  const renames = selectRenames(items, values);
  const destinations = [...new Set(renames.map((r) => r.target).filter(Boolean))];
  const moving = destinations.length > 0;
  const verb = moving ? 'moved' : 'renamed';
  const where = moving ? ` into ${destinations.join(' and ')}` : '';
  if (!renames.length) {
    output.log(`Nothing to ${moving ? 'move' : 'rename'}`);
    printRenames(ctx, { renamed: 0, target: null, targets: [], renames: [] }, values, output);
    return EXIT.ok;
  }
  if (values['dry-run']) {
    output.log(`Dry run: ${renames.length} file(s) would be ${verb}${where}`);
    printRenames(ctx, { dryRun: true, renamed: 0, target: sharedTarget(renames), targets: destinations, renames }, values, output);
    return EXIT.ok;
  }

  const result = await runWithProgress(values, output, ({ signal, onProgress }) =>
    applyRenames(ctx.root, renames, { signal, onProgress, owner: 'CLI' }),
  );
  if (result.cancelled) output.log(`Cancelled after ${result.renamed} file(s)${where}.`);
  else output.log(`${verb[0].toUpperCase()}${verb.slice(1)} ${result.renamed} file(s)${where}.`);
  result.failed.forEach((f) => output.log(`failed ${f.from}: ${f.reason}`));
  if (result.renamed) output.log(`Undo with: media-renamer undo ${JSON.stringify(ctx.root)}`);
  printRenames(ctx, result, values, output);
  if (result.cancelled) return EXIT.cancelled;
  return result.failed.length ? EXIT.unresolved : EXIT.ok;
}

async function undo(ctx, positionals, values, output) {
  if (positionals.length) throw new UsageError('undo takes only <dir>');
  const result = await runWithProgress(values, output, ({ signal, onProgress }) => undoLast(ctx.root, { signal, onProgress, owner: 'CLI' }));
  output.log(`${result.cancelled ? 'Undo cancelled. ' : ''}Restored ${result.restored} file(s) from the batch of ${result.batchAt}`);
  result.skipped.forEach((s) => output.log(`skipped ${s.from}: ${s.reason}`));
  if (result.remaining) output.log(`${result.remaining} file(s) still to restore; run undo again.`);
  printRenames(ctx, result, values, output, { reverse: true });
  if (result.cancelled) return EXIT.cancelled;
  return result.skipped.length ? EXIT.unresolved : EXIT.ok;
}

/** Commands that work on a <dir>: `command(ctx, positionals, values, output)` resolves to an exit code. */
export const FOLDER_COMMANDS = { scan, preview, apply, import: importCommand, undo };
