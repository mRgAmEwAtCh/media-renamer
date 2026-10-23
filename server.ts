import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAuthenticated, loginCookie, passwordMatches } from './lib/auth.ts';
import { hostnameOf, loadConfig, loadEnvFile } from './lib/config.ts';
import type { Config, ConfigOverrides } from './lib/config.ts';
import { InputError } from './lib/errors.ts';
import { JobManager } from './lib/jobs.ts';
import { MetadataClient } from './lib/metadata.ts';
import { actionNeeded, Push } from './lib/push.ts';
import { createContext } from './lib/server/context.ts';
import type { MetadataFactory } from './lib/server/context.ts';
import { createHook } from './lib/server/hook.ts';
import { readJson, redirect, send } from './lib/server/http.ts';
import type { Routes } from './lib/server/http.ts';
import { fileRoutes } from './lib/server/routes/files.ts';
import { jobRoutes } from './lib/server/routes/jobs.ts';
import { pushRoutes } from './lib/server/routes/push.ts';
import { settingsRoutes } from './lib/server/routes/settings.ts';
import { logSettings, logStartup } from './lib/server/startup.ts';
import { isPublicFile, isStaticFile, serveStatic } from './lib/server/static.ts';

/** The HTTP server, with its job queue so callers (and tests) can reach it. */
export type MediaRenamerServer = http.Server & { jobs: JobManager };

export interface ServerOptions {
  jobs?: JobManager;
  createMetadata?: MetadataFactory;
  push?: Push;
}

function fail(response: ServerResponse, error: unknown): void {
  const status = (error as InputError).status ?? (error instanceof InputError ? 400 : 500);
  if (status === 500) console.error(error);
  return send(response, status, { error: (error as Error).message });
}

export function createServer(
  config: Config,
  { jobs = new JobManager(), createMetadata = (options) => new MetadataClient(options), push = new Push(config.pushFile) }: ServerOptions = {},
): MediaRenamerServer {
  const context = createContext(config, { jobs, createMetadata, push });
  const routes: Routes = { ...settingsRoutes(context), ...fileRoutes(context), ...jobRoutes(context), ...pushRoutes(context) };
  const { hook, resume } = createHook(context);
  jobs.resume ??= resume;
  jobs.onFinish ??= async (job) => {
    const message = actionNeeded(job);
    if (message) await push.notify({ ...message, url: '/' });
  };

  async function login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { password } = await readJson(request);
    if (!passwordMatches(password, config.password)) return send(response, 401, { error: 'Wrong password' });
    return send(response, 200, { ok: true }, undefined, { 'Set-Cookie': loginCookie(config.password) });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Reject unknown Host headers so web pages cannot reach this API via DNS rebinding.
    if (config.allowedHosts && !config.allowedHosts.has(hostnameOf(request.headers.host))) {
      return send(response, 421, { error: 'Unexpected Host header; add it to MEDIA_RENAMER_ALLOWED_HOSTS' });
    }
    const { pathname } = new URL(request.url!, 'http://localhost');
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
  }) as MediaRenamerServer;
  server.jobs = jobs;
  return server;
}

/** On SIGTERM/SIGINT: stop accepting requests, let the running job finish its file, then exit. */
function handleShutdown(server: MediaRenamerServer, config: Config): void {
  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
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

export function startServer(overrides: ConfigOverrides = {}): Promise<MediaRenamerServer> {
  loadEnvFile();
  const config = loadConfig(process.env, overrides);
  if (config.umask !== null) process.umask(config.umask);
  for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);

  return new Promise<MediaRenamerServer>((resolve, reject) => {
    const server = createServer(config, { jobs: new JobManager({ storeFile: config.jobsFile }) });
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const { port } = server.address() as AddressInfo;
      const shown = ['0.0.0.0', '::'].includes(config.host) ? os.hostname() : config.host;
      logStartup(config, { shown, port });
      server.jobs.restore().catch((error: unknown) => process.stderr.write(`warning: could not restore jobs: ${(error as Error).message}\n`));
      logSettings(config);
      handleShutdown(server, config);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
