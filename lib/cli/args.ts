import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export const EXIT = { ok: 0, error: 1, usage: 2, unresolved: 3, cancelled: 130 };

/** A mistake in the command line; reported with a pointer to --help and exit code 2. */
export class UsageError extends Error {}

const OPTIONS = {
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
  'audio-fix': { type: 'boolean' },
  'no-audio-fix': { type: 'boolean' },
  cleanup: { type: 'boolean' },
  wait: { type: 'string' },
  format: { type: 'string' },
  absolute: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  port: { type: 'string' },
  start: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const satisfies ParseArgsOptionsConfig;

export function parseCli(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Parsed command-line options. */
export type CliValues = ReturnType<typeof parseCli>['values'];

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('Expected input on stdin, but stdin is a terminal');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Non-blank lines, or NUL-separated records with `nul`. */
export function splitRecords(text: string, nul: boolean | undefined): string[] {
  return text.split(nul ? '\0' : /\r?\n/).filter((record) => record.trim() !== '');
}
