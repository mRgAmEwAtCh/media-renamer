import path from 'node:path';
import { activeTargets } from '../settings.ts';
import { EXIT, UsageError } from './args.ts';

const FORMATS = ['table', 'json', 'jsonl', 'tsv'];

/**
 * stdout/stderr for one command run. `emit(rows, { document, fields, line })`
 * prints rows in the chosen format: `document()` for json, each row for jsonl,
 * `fields(row, index)` for tsv and `line(row, index)` for the table.
 */
export function createOutput(values) {
  const format = values.format ?? (process.stdout.isTTY ? 'table' : 'json');
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of: ${FORMATS.join(', ')}`);
  const separator = values.null ? '\0' : '\n';
  const write = (text) => process.stdout.write(text);
  const record = (fields) => write(`${fields.map((f) => String(f ?? '')).join('\t')}${separator}`);
  return {
    format,
    log: (message) => values.quiet || process.stderr.write(`${message}\n`),
    write,
    record,
    emit(rows, { document, fields, line }) {
      if (format === 'json') return write(`${JSON.stringify(document(), null, 2)}\n`);
      if (format === 'jsonl') return rows.forEach((row) => write(`${JSON.stringify(row)}\n`));
      if (format === 'tsv') return rows.forEach((row, index) => record(fields(row, index)));
      return rows.forEach((row, index) => write(line(row, index)));
    },
  };
}

/** A root-relative path as shown: absolute with --absolute. */
export const display = (base, rel, absolute) => (rel && absolute ? path.join(base, rel) : rel);

export const describeTarget = (target) => target ?? 'rename in place';

export function describeTargets(targets) {
  if (!targets.episode && !targets.movie) return '';
  return ` Destinations: TV → ${describeTarget(targets.episode)}, movies → ${describeTarget(targets.movie)}`;
}

export function logExcluded(excluded, output) {
  const parts = [];
  if (excluded.samples) parts.push(`${excluded.samples} sample file(s)`);
  if (excluded.nonVideo) parts.push(`${excluded.nonVideo} non-video file(s)`);
  if (parts.length) output.log(`Skipped ${parts.join(' and ')} (filters)`);
}

const INDENT = ' '.repeat(10);

/** Preview items: status, old name, new name and match notes. */
export function printItems(ctx, items, values, output) {
  const shown = items.map((item) => ({
    ...item,
    rel: display(ctx.root, item.rel, values.absolute),
    newRel: display(item.target ?? ctx.root, item.newRel, values.absolute),
  }));
  output.emit(shown, {
    document: () => ({ root: ctx.root, targets: ctx.targets, items: shown }),
    fields: (item) => [item.status, item.rel, item.newRel, item.match ?? item.message, item.target ?? ''],
    line: (item, index) => {
      let text = `${item.status.padEnd(9)} ${item.rel}\n`;
      const { target } = items[index];
      if (item.newRel && (target || item.newRel !== item.rel)) {
        text += `${INDENT}→ ${target && !values.absolute ? path.join(target, item.newRel) : item.newRel}\n`;
      }
      const note = [item.match, item.message].filter(Boolean).join(' — ');
      return note ? `${text}${INDENT}${note}\n` : text;
    },
  });
  if (output.format === 'table') {
    const counts = Object.entries(Object.groupBy(items, (i) => i.status)).map(([status, list]) => `${list.length} ${status}`);
    output.log(`\n${counts.join(', ') || 'no files'}`);
  }
}

/** Completed (or planned) moves; `reverse` for undo, where files come back from their destination. */
export function printRenames(ctx, result, values, output, { reverse = false } = {}) {
  const renames = result.renames.map((rename) => {
    const destination = rename.target ?? ctx.root;
    const [fromBase, toBase] = reverse ? [destination, ctx.root] : [ctx.root, destination];
    return {
      from: display(fromBase, rename.from, values.absolute),
      to: display(toBase, rename.to, values.absolute),
      target: rename.target ?? null,
    };
  });
  output.emit(renames, {
    document: () => ({ root: ctx.root, targets: ctx.targets, ...result, renames }),
    fields: (r) => [r.from, r.to, r.target ?? ''],
    line: (r, index) => {
      const { target } = result.renames[index];
      const inTarget = (rel) => (target && !values.absolute ? path.join(target, rel) : rel);
      return reverse ? `${inTarget(r.from)}\n  → ${r.to}\n` : `${r.from}\n  → ${inTarget(r.to)}\n`;
    },
  });
}

export function printSettings({ file, saved, defaults, effective }, output) {
  if (output.format === 'json' || output.format === 'jsonl') {
    const document = { file, saved: saved.exists, savedAt: saved.savedAt, settings: effective, defaults, problems: saved.problems };
    output.write(`${JSON.stringify(document, null, output.format === 'json' ? 2 : 0)}\n`);
    return EXIT.ok;
  }
  const yesNo = (value) => (value ? 'yes' : 'no');
  const targets = activeTargets(effective);
  const savedNote = saved.exists ? (saved.savedAt ? ` (saved ${saved.savedAt})` : '') : ' (not saved; environment/built-in defaults)';
  const rows = [
    ['settings file', `${file}${savedNote}`],
    ['episode pattern', effective.patterns.episode],
    ['movie pattern', effective.patterns.movie],
    ['move files', yesNo(effective.move)],
    ['tv destination', describeTarget(targets.episode)],
    ['movie destination', describeTarget(targets.movie)],
    ['language', effective.language],
    ['region', effective.region ?? ''],
    ['video only', yesNo(effective.filters.videoOnly)],
    ['skip samples', yesNo(effective.filters.excludeSamples)],
  ];
  if (output.format === 'tsv') rows.forEach((row) => output.record(row));
  else rows.forEach(([key, value]) => output.write(`${`${key}:`.padEnd(19)} ${value}\n`));
  return EXIT.ok;
}
