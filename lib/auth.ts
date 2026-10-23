import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const COOKIE = 'media_renamer_session';
const same = (a: string, b: string): boolean => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
// Derived from the password, so changing the password ends every login.
const sessionValue = (password: string): string => createHmac('sha256', 'media-renamer-session').update(password).digest('base64url');

/** Logged in through the login page (cookie) or Basic auth (`curl -u any:password`). */
export function isAuthenticated(request: IncomingMessage, password: string): boolean {
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization ?? '');
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    return same(decoded.slice(decoded.indexOf(':') + 1), password);
  }
  const cookie = /(?:^|;\s*)media_renamer_session=([^;]+)/.exec(request.headers.cookie ?? '');
  return cookie !== null && same(cookie[1], sessionValue(password));
}

export const passwordMatches = (candidate: unknown, password: string): boolean => typeof candidate === 'string' && same(candidate, password);

export const loginCookie = (password: string): string =>
  `${COOKIE}=${sessionValue(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
