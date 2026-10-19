#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TOKEN_NAMES } from '../lib/format.js';
import { loadEnvFile, readSecret } from '../lib/config.js';
import { MetadataClient, normalizeLanguage, normalizeRegion } from '../lib/metadata.js';
import {
  applyRenames,
  buildPreview,
  DEFAULT_PATTERNS,
  InputError,
  parseRelativePath,
  resolveRoot,
  resolveTarget,
  scanFolder,
  undoLast,
} from '../lib/renamer.js';
import { activeTargets, loadSettings } from '../lib/settings.js';

const EXIT = { ok: 0, error: 1, usage: 2, unresolved: 3, cancelled: 130 };
const FORMATS = ['table', 'json', 'jsonl', 'tsv'];
const PROBLEM_STATUSES = new Set(['error', 'conflict']);

const HELP = `media-renamer — rename movie and TV episode files from public metadata

Usage:
  media-renamer scan     <dir> [options]
  media-renamer preview  <dir> [file...] [options]
  media-renamer apply    <dir> [file...] [options]
  media-renamer apply    <dir> --plan <file|-> [options]
  media-renamer undo     <dir> [options]
  media-renamer settings [--format json]
  media-renamer pick     [--start <dir>]
  media-renamer serve    [--port <n>]

Commands:
  scan      List media files and what was parsed from their names
  preview   Look up metadata and print proposed names (changes nothing)
  apply     Rename files; uses a fresh preview, or a plan from --plan
  undo      Reverse the last applied batch in <dir>
  settings  Show the effective defaults (saved settings over environment)
  pick      Open the system folder dialog and print the chosen path
            (macOS: AppleScript, Windows: PowerShell, Linux: zenity or kdialog)
  serve     Start the local web app on 127.0.0.1

Input:
  [file...]                 Files to process, relative to <dir> or absolute
  --stdin                   Read file paths from stdin (one per line)
  -0, --null                Records on stdin/output are NUL-separated
  --no-recursive            Do not descend into subfolders when scanning
  --plan <file|->           Apply a plan produced by "preview --format json|jsonl"

Filters (also applied to files given as arguments or on stdin):
  --video-only              Only process video files (.mkv, .mp4, .avi, …); skip subtitles
  --all-types               Process video and subtitle files (overrides the default)
  --include-samples         Do not skip release samples. By default "Sample(s)" folders and
                            files like movie-sample.mkv are skipped

Destination (TV episodes and movies can go to different folders):
  --tv-target <dir>         Move TV episodes into <dir>
  --movie-target <dir>      Move movies into <dir>
  -t, --target <dir>        Move both kinds into <dir>
                            An empty value ('') renames that kind in place.
                            Moved files start at the destination root; renamed-in-place
                            files keep their subfolder. Moves across disks/mounts copy,
                            verify, then delete.

Naming:
  --episode-pattern <p>     Built-in default: "${DEFAULT_PATTERNS.episode}"
  --movie-pattern <p>       Built-in default: "${DEFAULT_PATTERNS.movie}"
  --language <code>         Metadata language, e.g. de-DE, fr, en-US (built-in: en-US)
  --region <CC>             Release region for movie matching, e.g. DE
  Tokens: ${TOKEN_NAMES.map((t) => `{${t}}`).join(' ')}  ({on} = original title)
  A "/" in a pattern creates folders, e.g. "{n}/Season {s}/{s00e00} {t}".
  Localised TV titles need a TMDB key; without one TVmaze (English) is used.

Defaults (flags override them):
  Saved settings — written by the web UI's "Save as default" — override environment
  variables, which override built-ins. "media-renamer settings" shows the result.
  MEDIA_RENAMER_CONFIG_DIR       Folder of settings.json (default: per-user config folder)
  MEDIA_RENAMER_TV_TARGET        Default TV destination
  MEDIA_RENAMER_MOVIE_TARGET     Default movie destination
  MEDIA_RENAMER_TARGET           Default destination for both
  MEDIA_RENAMER_EPISODE_PATTERN  Default episode pattern
  MEDIA_RENAMER_MOVIE_PATTERN    Default movie pattern
  MEDIA_RENAMER_LANGUAGE / MEDIA_RENAMER_REGION
  MEDIA_RENAMER_VIDEO_ONLY / MEDIA_RENAMER_INCLUDE_SAMPLES

Secrets (environment only, never command-line flags):
  TMDB_API_KEY              TMDB API key or v4 read token for movie lookups
  TMDB_API_KEY_FILE         File containing the key (e.g. a Docker secret)
  MEDIA_RENAMER_ENV_FILE    KEY=value file to load (default: .env next to the app)

Behaviour:
  --include-warnings        Also apply items that only matched the parsed name
  --strict                  Exit 3 (and do not apply) if any item is an error or conflict
  --dry-run                 With apply: print what would be renamed, change nothing

Output:
  --format <f>              table | json | jsonl | tsv (default: table on a TTY, else json)
  --absolute                Print absolute paths instead of paths relative to <dir>
  -q, --quiet               No progress messages on stderr

Exit codes: 0 success, 1 error, 2 usage error, 3 completed with unresolved items,
            130 cancelled (Ctrl-C). Cancelling keeps the file being copied at its
            original location; files already moved can be undone.

Examples:
  media-renamer preview "$(media-renamer pick)"
  media-renamer apply ~/Downloads --tv-target ~/Media/TV --movie-target ~/Media/Movies \\
    --episode-pattern '{n}/Season {s}/{n} - {s00e00} - {t}' --movie-pattern '{n} ({y})/{n} ({y})'
  media-renamer preview ~/Downloads --format tsv
  find . -name '*.mkv' -print0 | media-renamer preview . --stdin -0 --format jsonl
  media-renamer preview ~/TV --format json > plan.json && media-renamer apply ~/TV --plan plan.json
  media-renamer preview ~/TV --format jsonl | jq -c 'select(.match != null)' | media-renamer apply ~/TV --plan -
`;

class UsageError extends Error {}

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        stdin: { type: 'boolean' },
        null: { type: 'boolean', short: '0' },
        'no-recursive': { type: 'boolean' },
        'video-only': { type: 'boolean' },
        'all-types': { type: 'boolean' },
        'include-samples': { type: 'boolean' },
        plan: { type: 'string' },
        target: { type: 'string', short: 't' },
        'tv-target': { type: 'string' },
        'movie-target': { type: 'string' },
        'episode-pattern': { type: 'string' },
        'movie-pattern': { type: 'string' },
        language: { type: 'string' },
        region: { type: 'string' },
        'include-warnings': { type: 'boolean' },
        strict: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        format: { type: 'string' },
        absolute: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        port: { type: 'string' },
        start: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('Expected input on stdin, but stdin is a terminal');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function splitRecords(text, nul) {
  return text.split(nul ? '\0' : /\r?\n/).filter((record) => record.trim() !== '');
}

function createOutput(values) {
  const format = values.format ?? (process.stdout.isTTY ? 'table' : 'json');
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of: ${FORMATS.join(', ')}`);
  const separator = values.null ? '\0' : '\n';
  return {
    format,
    log: (message) => values.quiet || process.stderr.write(`${message}\n`),
    write: (text) => process.stdout.write(text),
    record: (fields) => process.stdout.write(`${fields.map((f) => String(f ?? '')).join('\t')}${separator}`),
  };
}

const display = (base, rel, absolute) => (rel && absolute ? path.join(base, rel) : rel);

function itemForOutput(ctx, item, absolute) {
  return {
    ...item,
    rel: display(ctx.root, item.rel, absolute),
    newRel: display(item.target ?? ctx.root, item.newRel, absolute),
  };
}

const describeTarget = (target) => target ?? 'rename in place';

function describeTargets(targets) {
  if (!targets.episode && !targets.movie) return '';
  return ` Destinations: TV → ${describeTarget(targets.episode)}, movies → ${describeTarget(targets.movie)}`;
}

/** The one destination shared by all renames (null when in place or spread over several). */
function sharedTarget(renames) {
  const distinct = [...new Set(renames.map((r) => r.target ?? null))];
  return distinct.length === 1 ? distinct[0] : null;
}

async function collectFiles(ctx, positionals, values, output) {
  const files = [...positionals];
  if (values.stdin) files.push(...splitRecords(await readStdin(), values.null));
  if (files.length) return files;
  const { files: scanned, truncated, excluded } = await scanFolder(ctx.root, { recursive: !values['no-recursive'], ...ctx.filters });
  if (truncated) output.log(`warning: stopped after ${scanned.length} files`);
  logExcluded(excluded, output);
  return scanned;
}

function logExcluded(excluded, output) {
  const parts = [];
  if (excluded.samples) parts.push(`${excluded.samples} sample file(s)`);
  if (excluded.nonVideo) parts.push(`${excluded.nonVideo} non-video file(s)`);
  if (parts.length) output.log(`Skipped ${parts.join(' and ')} (filters)`);
}

async function preview(ctx, positionals, values, output) {
  const files = await collectFiles(ctx, positionals, values, output);
  output.log(`Looking up ${files.length} file(s) in ${ctx.language}${ctx.region ? `/${ctx.region}` : ''}…${describeTargets(ctx.targets)}`);
  const metadata = new MetadataClient({ tmdbKey: readSecret(process.env, 'TMDB_API_KEY'), language: ctx.language, region: ctx.region });
  return buildPreview({ root: ctx.root, targets: ctx.targets, files, patterns: ctx.patterns, filters: ctx.filters, metadata });
}

function printItems(ctx, items, values, output) {
  const shown = items.map((item) => itemForOutput(ctx, item, values.absolute));
  if (output.format === 'json') {
    return output.write(`${JSON.stringify({ root: ctx.root, targets: ctx.targets, items: shown }, null, 2)}\n`);
  }
  if (output.format === 'jsonl') return shown.forEach((item) => output.write(`${JSON.stringify(item)}\n`));
  if (output.format === 'tsv') {
    return shown.forEach((i) => output.record([i.status, i.rel, i.newRel, i.match ?? i.message, i.target ?? '']));
  }
  for (const [index, item] of shown.entries()) {
    output.write(`${item.status.padEnd(9)} ${item.rel}\n`);
    const target = items[index].target;
    if (item.newRel && (target || item.newRel !== item.rel)) {
      output.write(`${' '.repeat(10)}→ ${target && !values.absolute ? path.join(target, item.newRel) : item.newRel}\n`);
    }
    const note = [item.match, item.message].filter(Boolean).join(' — ');
    if (note) output.write(`${' '.repeat(10)}${note}\n`);
  }
  const counts = Object.entries(Object.groupBy(items, (i) => i.status)).map(([s, list]) => `${list.length} ${s}`);
  output.log(`\n${counts.join(', ') || 'no files'}`);
}

function printRenames(ctx, result, values, output, { reverse = false } = {}) {
  const renames = result.renames.map((rename) => {
    const destination = rename.target ?? ctx.root;
    const [fromBase, toBase] = reverse ? [destination, ctx.root] : [ctx.root, destination];
    return {
      from: display(fromBase, rename.from, values.absolute),
      to: display(toBase, rename.to, values.absolute),
      target: rename.target ?? null,
    };
  });
  if (output.format === 'json') {
    return output.write(`${JSON.stringify({ root: ctx.root, targets: ctx.targets, ...result, renames }, null, 2)}\n`);
  }
  if (output.format === 'jsonl') return renames.forEach((r) => output.write(`${JSON.stringify(r)}\n`));
  if (output.format === 'tsv') return renames.forEach((r) => output.record([r.from, r.to, r.target ?? '']));
  for (const [index, r] of renames.entries()) {
    const { target } = result.renames[index];
    const inTarget = (rel) => (target && !values.absolute ? path.join(target, rel) : rel);
    output.write(reverse ? `${inTarget(r.from)}\n  → ${r.to}\n` : `${r.from}\n  → ${inTarget(r.to)}\n`);
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Progress on stderr: a live line on a terminal, one line per file otherwise. */
function createProgressReporter(values) {
  if (values.quiet) return { update() {}, end() {} };
  const live = process.stderr.isTTY;
  let lastFile = null;
  let lastDraw = 0;
  return {
    update(p) {
      if (!p.current) return;
      if (!live) {
        if (p.current.from !== lastFile) process.stderr.write(`[${p.filesDone + 1}/${p.filesTotal}] ${p.current.from} → ${p.current.to}\n`);
        lastFile = p.current.from;
        return;
      }
      const now = Date.now();
      if (now - lastDraw < 200 && p.current.bytesDone < p.current.bytesTotal) return;
      lastDraw = now;
      const done = p.bytesDone + p.current.bytesDone;
      const percent = p.bytesTotal ? Math.floor((done / p.bytesTotal) * 100) : 0;
      const line = `[${p.filesDone + 1}/${p.filesTotal}] ${percent}% ${formatBytes(done)}/${formatBytes(p.bytesTotal)}  ${p.current.to}`;
      process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns || 100) - 1)}`);
    },
    end() {
      if (live && lastDraw) process.stderr.write('\r\x1b[2K');
    },
  };
}

/** Run a job with Ctrl-C/SIGTERM wired to a clean cancel. */
async function runCancellable(output, task) {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    output.log('\nCancelling… the file being copied stays at its original location.');
    controller.abort();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    return await task(controller.signal);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

/** Configured destination for an item's kind; items without a kind need one shared destination. */
function targetForKind(ctx, kind, rel) {
  if (kind === 'episode' || kind === 'movie') return ctx.targets[kind];
  if (ctx.targets.episode === ctx.targets.movie) return ctx.targets.episode;
  throw new InputError(`Plan item ${rel} has neither a kind nor a target; pass one --target for all files`);
}

async function loadPlan(ctx, source) {
  const text = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = splitRecords(text, false).map((line) => JSON.parse(line));
    } catch {
      throw new InputError('Plan must be JSON or JSON Lines from "preview"');
    }
  }
  if (parsed && !Array.isArray(parsed) && !parsed.items && !parsed.renames && ('rel' in parsed || 'from' in parsed)) {
    parsed = [parsed]; // A single JSON Lines record is also valid JSON.
  }
  const header = parsed && !Array.isArray(parsed) ? parsed : {};
  if (header.root && (await resolveRoot(header.root)) !== ctx.root) {
    throw new InputError(`Plan was made for ${header.root}, not ${ctx.root}`);
  }
  const entries = Array.isArray(parsed) ? parsed : (parsed?.items ?? parsed?.renames);
  if (!Array.isArray(entries)) throw new InputError('Plan has no items');

  const resolved = new Map();
  const resolve = async (value) => {
    const key = String(value ?? '');
    if (!resolved.has(key)) resolved.set(key, await resolveTarget(ctx.root, value));
    return resolved.get(key);
  };
  const headerTargets = header.targets && typeof header.targets === 'object' ? header.targets : null;

  // Destinations come from the plan item, then the plan header, then --target flags or defaults.
  const items = [];
  for (const entry of entries) {
    const rel = entry.from ?? entry.rel;
    const kind = entry.kind ?? null;
    let target;
    if (Object.hasOwn(entry, 'target')) target = await resolve(entry.target);
    else if (headerTargets && Object.hasOwn(headerTargets, kind ?? '')) target = await resolve(headerTargets[kind]);
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
      newRel: entry.to ?? entry.newRel,
      kind,
      target,
      status: entry.status ?? 'ok',
      match: entry.match ?? null,
      message: entry.message ?? null,
    });
  }
  return { items };
}

function selectRenames(items, values) {
  const allowed = new Set(values['include-warnings'] ? ['ok', 'warning'] : ['ok']);
  return items
    .filter((item) => allowed.has(item.status) && item.newRel && (item.target || item.newRel !== item.rel))
    .map((item) => ({ from: item.rel, to: item.newRel, target: item.target ?? null }));
}

const commands = {
  settings: null, // handled in main(): needs no <dir>
  async scan(ctx, positionals, values, output) {
    const { root } = ctx;
    if (positionals.length) throw new UsageError('scan takes only <dir>');
    const { files, truncated, excluded } = await scanFolder(root, { recursive: !values['no-recursive'], ...ctx.filters });
    if (truncated) output.log(`warning: stopped after ${files.length} files`);
    logExcluded(excluded, output);
    const entries = files.map((rel) => ({ rel: display(root, rel, values.absolute), parsed: parseRelativePath(rel) }));
    if (output.format === 'json') {
      output.write(`${JSON.stringify({ root, truncated, excluded, filters: ctx.filters, files: entries }, null, 2)}\n`);
    } else if (output.format === 'jsonl') entries.forEach((e) => output.write(`${JSON.stringify(e)}\n`));
    else if (output.format === 'tsv') {
      entries.forEach(({ rel, parsed: p }) => output.record([rel, p.kind, p.title, p.year, p.season, p.episode]));
    } else {
      for (const { rel, parsed: p } of entries) {
        const detail = p.kind === 'episode' ? `${p.title} S${p.season}E${p.episode}` : `${p.title}${p.year ? ` (${p.year})` : ''}`;
        output.write(`${p.kind.padEnd(8)} ${rel}  [${detail}]\n`);
      }
    }
    return EXIT.ok;
  },

  async preview(ctx, positionals, values, output) {
    const items = await preview(ctx, positionals, values, output);
    printItems(ctx, items, values, output);
    return values.strict && items.some((i) => PROBLEM_STATUSES.has(i.status)) ? EXIT.unresolved : EXIT.ok;
  },

  async apply(ctx, positionals, values, output) {
    if (values.plan && (positionals.length || values.stdin)) {
      throw new UsageError('--plan cannot be combined with file arguments or --stdin');
    }
    const items = values.plan ? (await loadPlan(ctx, values.plan)).items : await preview(ctx, positionals, values, output);
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
    const reporter = createProgressReporter(values);
    let result;
    try {
      result = await runCancellable(output, (signal) =>
        applyRenames(ctx.root, renames, { signal, onProgress: reporter.update, owner: 'CLI' }),
      );
    } finally {
      reporter.end();
    }
    if (result.cancelled) output.log(`Cancelled after ${result.renamed} file(s)${where}.`);
    else output.log(`${verb[0].toUpperCase()}${verb.slice(1)} ${result.renamed} file(s)${where}.`);
    result.failed.forEach((f) => output.log(`failed ${f.from}: ${f.reason}`));
    if (result.renamed) output.log(`Undo with: media-renamer undo ${JSON.stringify(ctx.root)}`);
    printRenames(ctx, result, values, output);
    if (result.cancelled) return EXIT.cancelled;
    return result.failed.length ? EXIT.unresolved : EXIT.ok;
  },

  async undo(ctx, positionals, values, output) {
    if (positionals.length) throw new UsageError('undo takes only <dir>');
    const reporter = createProgressReporter(values);
    let result;
    try {
      result = await runCancellable(output, (signal) => undoLast(ctx.root, { signal, onProgress: reporter.update, owner: 'CLI' }));
    } finally {
      reporter.end();
    }
    output.log(`${result.cancelled ? 'Undo cancelled. ' : ''}Restored ${result.restored} file(s) from the batch of ${result.batchAt}`);
    result.skipped.forEach((s) => output.log(`skipped ${s.from}: ${s.reason}`));
    if (result.remaining) output.log(`${result.remaining} file(s) still to restore; run undo again.`);
    printRenames(ctx, result, values, output, { reverse: true });
    if (result.cancelled) return EXIT.cancelled;
    return result.skipped.length ? EXIT.unresolved : EXIT.ok;
  },
};

async function main(argv) {
  const { values, positionals } = parseCli(argv);
  loadEnvFile();
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return EXIT.ok;
  }
  const [command, directory, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }
  if (command === 'pick') {
    if (directory) throw new UsageError('pick takes no positional arguments; use --start <dir>');
    const { pickFolderNative } = await import('../lib/native-dialog.js');
    const result = await pickFolderNative({ start: values.start });
    if (!result.path) {
      if (!values.quiet) process.stderr.write('No folder selected\n');
      return EXIT.error;
    }
    process.stdout.write(`${result.path}${values.null ? '\0' : '\n'}`);
    return EXIT.ok;
  }
  if (command === 'serve') {
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new UsageError('--port must be an integer between 0 and 65535');
    }
    const { startServer } = await import('../server.js');
    await startServer(port === undefined ? {} : { port });
    return null;
  }
  if (!Object.hasOwn(commands, command)) throw new UsageError(`Unknown command: ${command}`);
  const output = createOutput(values);
  const { file, saved, defaults, effective } = await loadSettings(process.env);
  for (const problem of saved.problems) output.log(`warning: ${problem}`);
  if (command === 'settings') {
    if (directory) throw new UsageError('settings takes no arguments');
    return printSettings({ file, saved, defaults, effective }, output);
  }
  if (!directory) throw new UsageError(`${command} requires a <dir> argument`);
  const root = await resolveRoot(directory);

  const targetFlags = ['target', 'tv-target', 'movie-target'].filter((name) => values[name] !== undefined);
  const usesTargets = ['preview', 'apply'].includes(command);
  if (targetFlags.length && !usesTargets) throw new UsageError(`--${targetFlags[0]} is only used by preview and apply`);
  const wanted = activeTargets(effective);
  if (values.target !== undefined) Object.assign(wanted, { episode: values.target, movie: values.target });
  if (values['tv-target'] !== undefined) wanted.episode = values['tv-target'];
  if (values['movie-target'] !== undefined) wanted.movie = values['movie-target'];
  const targets = usesTargets
    ? { episode: await resolveTarget(root, wanted.episode), movie: await resolveTarget(root, wanted.movie) }
    : { episode: null, movie: null };

  if (values['video-only'] && values['all-types']) throw new UsageError('--video-only and --all-types cannot be combined');
  const filters = {
    videoOnly: values['video-only'] ? true : values['all-types'] ? false : effective.filters.videoOnly,
    excludeSamples: values['include-samples'] ? false : effective.filters.excludeSamples,
  };
  const patterns = {
    episode: values['episode-pattern'] ?? effective.patterns.episode,
    movie: values['movie-pattern'] ?? effective.patterns.movie,
  };
  let language;
  let region;
  try {
    language = normalizeLanguage(values.language) ?? effective.language;
    region = values.region !== undefined ? normalizeRegion(values.region) : effective.region;
  } catch (error) {
    throw new UsageError(error.message);
  }
  const ctx = { root, targets, explicitTarget: targetFlags.length > 0, filters, patterns, language, region };
  return commands[command](ctx, rest, values, output);
}

function printSettings({ file, saved, defaults, effective }, output) {
  if (output.format === 'json' || output.format === 'jsonl') {
    const document = { file, saved: saved.exists, savedAt: saved.savedAt, settings: effective, defaults, problems: saved.problems };
    output.write(`${JSON.stringify(document, null, output.format === 'json' ? 2 : 0)}\n`);
    return EXIT.ok;
  }
  const yesNo = (value) => (value ? 'yes' : 'no');
  const targets = activeTargets(effective);
  const rows = [
    ['settings file', `${file}${saved.exists ? `${saved.savedAt ? ` (saved ${saved.savedAt})` : ''}` : ' (not saved; environment/built-in defaults)'}`],
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

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`media-renamer: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write('Run "media-renamer --help" for usage.\n');
    process.exitCode = error instanceof UsageError ? EXIT.usage : EXIT.error;
  },
);
