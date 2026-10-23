import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAuthenticated, loginCookie, passwordMatches } from './lib/auth.js';
import { hostnameOf, loadConfig, loadEnvFile } from './lib/config.js';
import { InputError } from './lib/errors.js';
import { JobManager } from './lib/jobs.js';
import { MetadataClient } from './lib/metadata.js';
import { actionNeeded, Push } from './lib/push.js';
import { createContext } from './lib/server/context.js';
import { createHook } from './lib/server/hook.js';
import { readJson, redirect, send } from './lib/server/http.js';
import { fileRoutes } from './lib/server/routes/files.js';
import { jobRoutes } from './lib/server/routes/jobs.js';
import { pushRoutes } from './lib/server/routes/push.js';
import { settingsRoutes } from './lib/server/routes/settings.js';
import { logSettings, logStartup } from './lib/server/startup.js';
import { isPublicFile, isStaticFile, serveStatic } from './lib/server/static.js';

function fail(response, error) {
  const status = error.status ?? (error instanceof InputError ? 400 : 500);
  if (status === 500) console.error(error);
  return send(response, status, { error: error.message });
}

export function createServer(
  config,
  { jobs = new JobManager(), createMetadata = (options) => new MetadataClient(options), push = new Push(config.pushFile) } = {},
) {
  const context = createContext(config, { jobs, createMetadata, push });
  const routes = { ...settingsRoutes(context), ...fileRoutes(context), ...jobRoutes(context), ...pushRoutes(context) };
  const { hook, resume } = createHook(context);
  jobs.resume ??= resume;
  jobs.onFinish ??= async (job) => {
    const message = actionNeeded(job);
    if (message) await push.notify({ ...message, url: '/' });
  };

  async function login(request, response) {
    const { password } = await readJson(request);
    if (!passwordMatches(password, config.password)) return send(response, 401, { error: 'Wrong password' });
    return send(response, 200, { ok: true }, undefined, { 'Set-Cookie': loginCookie(config.password) });
  }

  async function handle(request, response) {
    // Reject unknown Host headers so web pages cannot reach this API via DNS rebinding.
    if (config.allowedHosts && !config.allowedHosts.has(hostnameOf(request.headers.host))) {
      return send(response, 421, { error: 'Unexpected Host header; add it to MEDIA_RENAMER_ALLOWED_HOSTS' });
    }
    const { pathname } = new URL(request.url, 'http://localhost');
    const { method } = request;

    if (pathname === '/healthz' && method === 'GET') return send(response, 200, { ok: true });
    // The hook has its own token so a downloader can call it without the web password.
    if (pathname === '/api/hooks/extracted') {
      if (method !== 'POST') return send(response, 405, { error: 'Use POST' }, undefined, { Allow: 'POST' });
      return send(response, 202, await hook(request));
    }
    if (config.password && pathname === '/api/login' && method === 'POST') return login(request, response);
    if (config.password && !isAuthenticated(request, config.password)) {
      if (method === 'GET' && isPublicFile(pathname)) return serveStatic(response, pathname);
      if (method === 'GET' && pathname === '/') return redirect(response, '/login');
      return send(response, 401, { error: 'Login required' });
    }
    if (pathname === '/login') return redirect(response, '/');

    if (method === 'GET' && isStaticFile(pathname)) return serveStatic(response, pathname);
    if (method === 'POST' && Object.hasOwn(routes, pathname)) return send(response, 200, await routes[pathname](await readJson(request)));
    return send(response, 404, { error: 'Not found' });
  }

  const server = http.createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      fail(response, error);
    }
  });
  server.jobs = jobs;
  return server;
}

/** On SIGTERM/SIGINT: stop accepting requests, let the running job finish its file, then exit. */
function handleShutdown(server, config) {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (server.jobs.get(null)?.state === 'running') {
      process.stderr.write(`${signal}: letting the current file finish (up to ${Math.round(config.shutdownGraceMs / 1000)}s), then stopping the job…\n`);
    }
    await server.jobs.shutdown({ graceMs: config.shutdownGraceMs });
    server.closeAllConnections();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export function startServer(overrides = {}) {
  loadEnvFile();
  const config = loadConfig(process.env, overrides);
  if (config.umask !== null) process.umask(config.umask);
  for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);

  return new Promise((resolve, reject) => {
    const server = createServer(config, { jobs: new JobManager({ storeFile: config.jobsFile }) });
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const { port } = server.address();
      const shown = ['0.0.0.0', '::'].includes(config.host) ? os.hostname() : config.host;
      logStartup(config, { shown, port });
      server.jobs.restore().catch((error) => process.stderr.write(`warning: could not restore jobs: ${error.message}\n`));
      logSettings(config);
      handleShutdown(server, config);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
