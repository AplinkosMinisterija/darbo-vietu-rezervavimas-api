'use strict';

import { serialize, CookieSerializeOptions, parse as cookieParse } from 'cookie';

/** HttpOnly cookie carrying the signed session JWT. */
export const SESSION_COOKIE_NAME = 'stalu_session';

/** Short-lived cookie carrying the OAuth state value for CSRF protection. */
export const OAUTH_STATE_COOKIE_NAME = 'stalu_oauth_state';

/** Default session cookie lifetime, mirrors signSession() default. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** OAuth state cookie lifetime — 10 minutes for the full redirect round-trip. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

/**
 * Whether to emit the Secure attribute on Set-Cookie. Defaults to true in
 * production. Can be forced via `COOKIE_SECURE=0|1` for staging tunnels that
 * terminate TLS upstream and forward plain HTTP.
 */
export function shouldUseSecureCookie(): boolean {
  if (process.env.COOKIE_SECURE === '0') return false;
  if (process.env.COOKIE_SECURE === '1') return true;
  return process.env.NODE_ENV === 'production';
}

function buildBaseOptions(maxAgeSeconds: number): CookieSerializeOptions {
  // SameSite=Lax (not Strict) is required for the OAuth flow:
  // - State cookie must be sent on the Microsoft → callback navigation (cross-site initiated)
  // - Session cookie must be sent on the callback → / redirect (initiated by external response)
  // Strict would break both. Lax still blocks CSRF (no cookie on cross-site POST/AJAX)
  // and keeps full XSS protection via HttpOnly.
  const opts: CookieSerializeOptions = {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
  const domain = (process.env.COOKIE_DOMAIN || '').trim();
  if (domain) opts.domain = domain;
  return opts;
}

/**
 * Serializes the session cookie:
 *   HttpOnly        — JS can't read it; XSS payload can't exfiltrate the token.
 *   Secure          — sent only over HTTPS in production.
 *   SameSite=Strict — eliminates CSRF against state-changing endpoints.
 *   Path=/          — sent to all paths on the issuing origin.
 *   Domain          — optional, controlled by COOKIE_DOMAIN env (empty = per-host).
 */
export function serializeSessionCookie(token: string, maxAgeSeconds = SESSION_MAX_AGE_SECONDS): string {
  return serialize(SESSION_COOKIE_NAME, token, buildBaseOptions(maxAgeSeconds));
}

/**
 * Serializes the OAuth state cookie. Same attrs as the session cookie but
 * a shorter Max-Age — only needs to survive the Microsoft round-trip.
 */
export function serializeOAuthStateCookie(state: string, maxAgeSeconds = OAUTH_STATE_MAX_AGE_SECONDS): string {
  return serialize(OAUTH_STATE_COOKIE_NAME, state, buildBaseOptions(maxAgeSeconds));
}

/**
 * Serializes a deletion cookie for the given name. Empty value with Max-Age=0
 * triggers browser-side cookie removal. Domain/Path/SameSite must match the
 * cookie being cleared, so we reuse the base options with maxAge=0.
 */
export function serializeClearCookie(name: string): string {
  const opts = buildBaseOptions(0);
  opts.maxAge = 0;
  opts.expires = new Date(0);
  return serialize(name, '', opts);
}

/**
 * Parses a `Cookie:` request header into a flat name → value map.
 * Returns an empty object on missing / malformed input.
 */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  try {
    return cookieParse(header) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Helper to append a Set-Cookie value to `ctx.meta.$responseHeaders` without
 * clobbering any existing Set-Cookie (e.g. emitting the session cookie
 * alongside a clear-cookie for the OAuth state in the callback handler).
 *
 * Node's HTTP layer sends one Set-Cookie response header per array element,
 * so combining cookies as an array is the canonical pattern.
 */
export function appendSetCookieToMeta(meta: any, cookieString: string): void {
  const existing = meta?.$responseHeaders?.['Set-Cookie'];
  const next = existing
    ? Array.isArray(existing)
      ? [...existing, cookieString]
      : [existing, cookieString]
    : cookieString;
  meta.$responseHeaders = {
    ...(meta?.$responseHeaders || {}),
    'Set-Cookie': next,
  };
}
