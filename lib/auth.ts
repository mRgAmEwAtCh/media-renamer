import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'media_renamer_session';
const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
// Derived from the password, so changing the password ends every login.
const sessionValue = (password) => createHmac('sha256', 'media-renamer-session').update(password).digest('base64url');

/** Logged in through the login page (cookie) or Basic auth (`curl -u any:password`). */
export function isAuthenticated(request, password) {
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization ?? '');
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    return same(decoded.slice(decoded.indexOf(':') + 1), password);
  }
  const cookie = /(?:^|;\s*)media_renamer_session=([^;]+)/.exec(request.headers.cookie ?? '');
  return Boolean(cookie) && same(cookie[1], sessionValue(password));
}

export const passwordMatches = (candidate, password) => typeof candidate === 'string' && same(candidate, password);

export const loginCookie = (password) =>
  `${COOKIE}=${sessionValue(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
