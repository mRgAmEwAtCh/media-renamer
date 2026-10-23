import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { InputError } from '../errors.ts';

/** A parsed request body; its fields are unchecked client input. */
export type RequestBody = Record<string, unknown>;
/** A POST /api/… handler; its result is sent as JSON. */
export type Route = (body: RequestBody) => Promise<unknown>;
export type Routes = Record<string, Route>;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Send a response; JSON bodies are serialised. */
export function send(response: ServerResponse, status: number, body: unknown, contentType: string = JSON_TYPE, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Type': contentType });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : (body as string | Buffer));
}

export const redirect = (response: ServerResponse, location: string): void => send(response, 302, '', 'text/plain', { Location: location });

async function readRaw(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InputError('Request body too large', { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(request: IncomingMessage): Promise<RequestBody> {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new InputError('Content-Type must be application/json', { status: 415 });
  }
  const text = await readRaw(request);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new InputError('Request body is not valid JSON');
  }
}

/** JSON, or a form post such as `curl --data-urlencode "ARCHIVE_PATH=…"`. */
export async function readJsonOrForm(request: IncomingMessage): Promise<RequestBody> {
  const type = String(request.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(await readRaw(request)));
  return readJson(request);
}
