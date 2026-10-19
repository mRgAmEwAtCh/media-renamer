import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { configDir, envSettings, settingsFilePath } from './settings.js';

export { envFlag, filterDefaults } from './settings.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1']);

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Load KEY=value pairs from MEDIA_RENAMER_ENV_FILE or the project's .env file.
 * Variables already present in the environment always win.
 */
export function loadEnvFile(env = process.env) {
  const file = env.MEDIA_RENAMER_ENV_FILE || path.join(PROJECT_DIR, '.env');
  if (!existsSync(file)) {
    if (env.MEDIA_RENAMER_ENV_FILE) throw new Error(`MEDIA_RENAMER_ENV_FILE not found: ${file}`);
    return null;
  }
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}

/** Read VAR, or the contents of VAR_FILE (Docker secrets style). */
export function readSecret(env, name) {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error(`Cannot read ${name}_FILE (${file}): ${error.message}`);
  }
}

/**
 * Server settings from environment variables.
 *
 * HOST                          Bind address (default 127.0.0.1; 0.0.0.0 in Docker)
 * PORT                          Listen port (default 4173)
 * MEDIA_RENAMER_ROOTS           Comma-separated folders the web app may browse and rename in
 * MEDIA_RENAMER_ALLOWED_HOSTS   Comma-separated hostnames accepted in the Host header, or *
 * MEDIA_RENAMER_PASSWORD[_FILE] Require this password (login page, or Basic auth with any user name)
 * MEDIA_RENAMER_CONFIG_DIR      Folder for saved settings (settings.json) and job history (jobs.json);
 *                               default: per-user config folder
 * MEDIA_RENAMER_HOOK_TOKEN[_FILE] Enables POST /api/hooks/extracted; callers send it as a Bearer token
 * MEDIA_RENAMER_PATH_MAP        Translate paths sent by other containers, e.g. /Downloads=/media/Downloads
 * MEDIA_RENAMER_STABLE_SECONDS  How long files must stop changing before an import starts (default 10)
 * MEDIA_RENAMER_FFMPEG / _FFPROBE Paths of ffmpeg and ffprobe for the audio fix (default: from PATH)
 * TMDB_API_KEY[_FILE]           TMDB API key or v4 read token for movie lookups (server-side only)
 * UMASK                         Octal umask for folders created by renames, e.g. 002
 * MEDIA_RENAMER_SHUTDOWN_GRACE  Seconds a running job may finish its current file on stop (default 8;
 *                               keep it below Docker's stop_grace_period)
 *
 * Naming, destination, language and filter defaults are read by envSettings() in settings.js.
 */
export function loadConfig(env = process.env, overrides = {}) {
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  const port = overrides.port ?? Number(env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);

  const roots = list(env.MEDIA_RENAMER_ROOTS).map((root) => {
    if (!path.isAbsolute(root)) throw new Error(`MEDIA_RENAMER_ROOTS entries must be absolute: ${root}`);
    return path.resolve(root);
  });

  const configuredHosts = list(env.MEDIA_RENAMER_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  const publicBind = !LOOPBACK_BIND.has(host);
  const anyHost = configuredHosts.includes('*') || (publicBind && configuredHosts.length === 0);

  let umask = null;
  if (env.UMASK) {
    if (!/^[0-7]{3,4}$/.test(env.UMASK)) throw new Error(`Invalid UMASK (expected octal like 002): ${env.UMASK}`);
    umask = Number.parseInt(env.UMASK, 8);
  }

  const graceSeconds = Number(env.MEDIA_RENAMER_SHUTDOWN_GRACE ?? 8);
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
    throw new Error(`Invalid MEDIA_RENAMER_SHUTDOWN_GRACE (seconds): ${env.MEDIA_RENAMER_SHUTDOWN_GRACE}`);
  }

  const password = readSecret(env, 'MEDIA_RENAMER_PASSWORD');
  const hookToken = readSecret(env, 'MEDIA_RENAMER_HOOK_TOKEN');
  const stableSeconds = Number(env.MEDIA_RENAMER_STABLE_SECONDS ?? 10);
  if (!Number.isFinite(stableSeconds) || stableSeconds < 0) {
    throw new Error(`Invalid MEDIA_RENAMER_STABLE_SECONDS: ${env.MEDIA_RENAMER_STABLE_SECONDS}`);
  }
  const defaults = envSettings(env);
  return {
    host,
    port,
    roots,
    allowedHosts: anyHost ? null : new Set([...LOOPBACK_HOSTS, ...configuredHosts]),
    password,
    tmdbKey: readSecret(env, 'TMDB_API_KEY'),
    envSettings: defaults,
    settingsFile: settingsFilePath(env),
    jobsFile: path.join(configDir(env), 'jobs.json'),
    pushFile: path.join(configDir(env), 'push.json'),
    hookToken,
    pathMap: parsePathMap(env.MEDIA_RENAMER_PATH_MAP),
    stableSeconds,
    audioTools: { ffmpeg: env.MEDIA_RENAMER_FFMPEG?.trim() || 'ffmpeg', ffprobe: env.MEDIA_RENAMER_FFPROBE?.trim() || 'ffprobe' },
    filters: defaults.filters,
    language: defaults.language,
    region: defaults.region,
    shutdownGraceMs: graceSeconds * 1000,
    umask,
    warnings: [
      ...(publicBind && !password ? ['No MEDIA_RENAMER_PASSWORD set: anyone who can reach this port can rename files.'] : []),
      ...(anyHost && publicBind && configuredHosts.length === 0
        ? ['MEDIA_RENAMER_ALLOWED_HOSTS not set: accepting any Host header. Set it to your NAS hostname/IP.']
        : []),
      ...(publicBind && roots.length === 0 ? ['MEDIA_RENAMER_ROOTS not set: the whole filesystem can be browsed.'] : []),
      ...(hookToken && hookToken.length < 20 ? ['MEDIA_RENAMER_HOOK_TOKEN is short; use at least 20 random characters.'] : []),
    ],
  };
}

/** Parse MEDIA_RENAMER_PATH_MAP ("/Downloads=/media/Downloads,…"), longest prefix first. */
export function parsePathMap(value) {
  return list(value)
    .map((pair) => {
      const separator = pair.indexOf('=');
      const from = pair.slice(0, separator).trim();
      const to = pair.slice(separator + 1).trim();
      if (separator < 1 || !path.isAbsolute(from) || !path.isAbsolute(to)) {
        throw new Error(`Invalid MEDIA_RENAMER_PATH_MAP entry "${pair}" (expected /from=/to)`);
      }
      return { from: path.resolve(from), to: path.resolve(to) };
    })
    .sort((a, b) => b.from.length - a.from.length);
}

/** Translate a path as seen by another container (e.g. JDownloader) into ours. */
export function mapPath(input, pathMap) {
  const resolved = path.resolve(input);
  for (const { from, to } of pathMap) {
    if (resolved === from || resolved.startsWith(`${from}${path.sep}`)) return path.join(to, path.relative(from, resolved));
  }
  return resolved;
}

/** Hostname from a Host header, without port; IPv6 brackets removed. */
export function hostnameOf(hostHeader) {
  const value = String(hostHeader ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.replace(/:\d+$/, '');
}
