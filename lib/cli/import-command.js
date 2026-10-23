import path from 'node:path';
import { loadConfig } from '../config.js';
import { runImport } from '../importer.js';
import { EXIT, UsageError } from './args.js';
import { createMetadata } from './context.js';
import { runWithProgress } from './progress.js';

const STEP_MARK = { done: '✓', skipped: '–', failed: '✗', stopped: '■' };
const INDENT = ' '.repeat(14);

/** Automation settings for this run: saved settings with the command-line overrides. */
function automationFor(ctx, values) {
  if (values['audio-fix'] && values['no-audio-fix']) throw new UsageError('--audio-fix and --no-audio-fix cannot be combined');
  const automation = structuredClone(ctx.settings.automation);
  if (values['include-warnings']) automation.includeWarnings = true;
  if (values.cleanup) automation.cleanupEmptyFolders = true;
  if (values['audio-fix']) automation.audioFix.enabled = true;
  if (values['no-audio-fix']) automation.audioFix.enabled = false;
  return automation;
}

/** The job control runImport reports to: finished steps are logged, per-file rows collected. */
function createControl(output, reporter, onFiles) {
  const steps = new Map();
  return {
    onProgress: reporter.update,
    defineSteps: (list) => list.forEach((s) => steps.set(s.id, s.label)),
    step: (id, patch) => {
      if (!Object.hasOwn(STEP_MARK, patch.state)) return;
      reporter.end();
      output.log(`${STEP_MARK[patch.state]} ${steps.get(id)}${patch.detail ? ` — ${patch.detail}` : ''}`);
    },
    setFiles: onFiles,
  };
}

function printImport(ctx, result, files, values, output) {
  const inTarget = (row) => (row.target && !values.absolute ? path.join(row.target, row.newRel) : row.newRel);
  const shown = files.map((row) => ({ ...row, newRel: row.newRel && values.absolute ? path.join(row.target ?? ctx.root, row.newRel) : row.newRel }));
  output.emit(shown, {
    document: () => ({ root: ctx.root, result, files: shown }),
    fields: (row) => [row.outcome, row.rel, row.newRel, row.target ?? '', row.audio ?? row.message ?? ''],
    line: (row) => {
      let text = `${row.outcome.padEnd(13)} ${row.rel}\n`;
      if (row.newRel && row.outcome !== 'review') text += `${INDENT}→ ${inTarget(row)}\n`;
      const note = [row.match, row.message, row.audio && `audio: ${row.audio}`].filter(Boolean).join(' — ');
      return note ? `${text}${INDENT}${note}\n` : text;
    },
  });
}

export async function importCommand(ctx, positionals, values, output) {
  if (positionals.length) throw new UsageError('import takes only <dir>');
  const automation = automationFor(ctx, values);
  const wait = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError('--wait must be a number of seconds');
  const settings = { ...ctx.settings, targets: ctx.targets, move: true, patterns: ctx.patterns, filters: ctx.filters, automation };
  const { audioTools } = loadConfig(process.env);

  let files = [];
  const result = await runWithProgress(values, output, ({ signal, reporter }) =>
    runImport({
      root: ctx.root,
      target: ctx.root,
      settings,
      metadata: createMetadata(ctx),
      audioTools,
      stableSeconds: wait,
      dryRun: Boolean(values['dry-run']),
      control: { ...createControl(output, reporter, (rows) => (files = rows)), signal },
      owner: 'CLI import',
    }),
  );

  printImport(ctx, result, files, values, output);
  if (result.imported) output.log(`Undo with: media-renamer undo ${JSON.stringify(ctx.root)}`);
  if (result.cancelled) return EXIT.cancelled;
  return result.failed || result.review ? EXIT.unresolved : EXIT.ok;
}
