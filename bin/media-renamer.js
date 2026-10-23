#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { EXIT, parseCli, UsageError } from '../lib/cli/args.js';
import { FOLDER_COMMANDS } from '../lib/cli/commands.js';
import { buildContext } from '../lib/cli/context.js';
import { HELP } from '../lib/cli/help.js';
import { createOutput, printSettings } from '../lib/cli/output.js';
import { loadEnvFile } from '../lib/config.js';
import { loadSettings } from '../lib/settings.js';

async function printVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  return EXIT.ok;
}

async function pick(values) {
  const { pickFolderNative } = await import('../lib/native-dialog.js');
  const result = await pickFolderNative({ start: values.start });
  if (!result.path) {
    if (!values.quiet) process.stderr.write('No folder selected\n');
    return EXIT.error;
  }
  process.stdout.write(`${result.path}${values.null ? '\0' : '\n'}`);
  return EXIT.ok;
}

async function serve(values) {
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new UsageError('--port must be an integer between 0 and 65535');
  }
  const { startServer } = await import('../server.js');
  await startServer(port === undefined ? {} : { port });
  return null; // Keep running; the server exits on SIGTERM/SIGINT.
}

/** Resolves to the exit code, or null while the server keeps running. */
async function main(argv) {
  const { values, positionals } = parseCli(argv);
  loadEnvFile();
  if (values.version) return printVersion();
  const [command, directory, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }
  if (command === 'pick') {
    if (directory) throw new UsageError('pick takes no positional arguments; use --start <dir>');
    return pick(values);
  }
  if (command === 'serve') return serve(values);
  if (command !== 'settings' && !Object.hasOwn(FOLDER_COMMANDS, command)) throw new UsageError(`Unknown command: ${command}`);

  const output = createOutput(values);
  const settings = await loadSettings(process.env);
  for (const problem of settings.saved.problems) output.log(`warning: ${problem}`);
  if (command === 'settings') {
    if (directory) throw new UsageError('settings takes no arguments');
    return printSettings(settings, output);
  }
  if (!directory) throw new UsageError(`${command} requires a <dir> argument`);
  const ctx = await buildContext(command, directory, values, settings.effective);
  return FOLDER_COMMANDS[command](ctx, rest, values, output);
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
