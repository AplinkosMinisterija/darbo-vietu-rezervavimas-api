'use strict';

import jwt, { Algorithm, SignOptions } from 'jsonwebtoken';
import { Context, Errors } from 'moleculer';
import { UserRole } from '../types/constants';

/**
 * JWT signing algorithm. Pinned so `jwt.verify` rejects tokens signed with a
 * different algorithm (defense against algorithm-confusion attacks if the
 * project later adds an RS256 key path).
 *
 * HS512 chosen over HS256 for a generous output size (no realistic perf cost
 * on this workload, and the longer MAC reduces accidental truncation risk
 * if a logging layer ever truncates the token).
 */
export const JWT_ALGORITHM: Algorithm = 'HS512';

/** Minimum secret length we will accept. HS512 needs >=64 bytes for full
 *  security but 32 bytes is the practical floor most ops actually meet —
 *  the fail-fast below enforces this. */
const MIN_SECRET_LENGTH = 32;

const PLACEHOLDER_SECRET = 'dev-jwt-secret-change-me';

/**
 * Returns the JWT signing secret, fail-fast on misconfiguration.
 *
 * Production: throws if env is unset, equal to the public placeholder, or
 * shorter than `MIN_SECRET_LENGTH`. Non-production: tolerates the
 * placeholder with a one-time console warning so local dev / tests work
 * without bootstrap wiring.
 */
let warnedAboutPlaceholder = false;
export function getJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';

  if (!fromEnv || fromEnv === PLACEHOLDER_SECRET) {
    if (isProd) {
      throw new Error(
        'JWT_SECRET env var must be set to a non-placeholder value in production. ' +
          'Refusing to start with a known-public default.',
      );
    }
    if (!warnedAboutPlaceholder) {
      // eslint-disable-next-line no-console
      console.warn(
        '[auth] WARNING: JWT_SECRET is unset or equal to the placeholder. ' +
          'Tokens are forgeable. Set JWT_SECRET before deploying.',
      );
      warnedAboutPlaceholder = true;
    }
    return PLACEHOLDER_SECRET;
  }
  if (fromEnv.length < MIN_SECRET_LENGTH) {
    if (isProd) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production.`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[auth] WARNING: JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} chars.`,
    );
  }
  return fromEnv;
}

/**
 * Session JWT payload. Kept intentionally small so a stolen token reveals
 * the minimum useful data — server-side `users.me` re-loads the full row
 * (with `display_name`, `allowedRooms`, etc.) on every request.
 */
export interface SessionPayload {
  sub: string;
  role: UserRole;
  /** JWT ID — random per token for future revocation list. */
  jti?: string;
}

/**
 * Signs a session JWT. Default 8h matches the spec (single workday).
 */
export function signSession(
  payload: SessionPayload,
  expiresIn: SignOptions['expiresIn'] = '8h',
): string {
  return jwt.sign(payload as object, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn,
  });
}

export type VerifyResult =
  | { ok: true; payload: SessionPayload & jwt.JwtPayload }
  | { ok: false; reason: 'expired' | 'invalid' };

/**
 * Verifies a session JWT. Returns a tagged result so callers can branch on
 * `reason: 'expired'` to surface a 401 with `code=TOKEN_EXPIRED`, distinct
 * from generic `invalid` (forged/tampered/wrong-secret).
 */
export function verifySession(token: string): VerifyResult {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
    }) as SessionPayload & jwt.JwtPayload;
    return { ok: true, payload: decoded };
  } catch (e: any) {
    if (e?.name === 'TokenExpiredError') return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Authenticated user as attached to `ctx.meta.user` by `api.service.ts`.
 * Phase 0: only the JWT payload is decoded; phase 1 will hydrate the full
 * `users` row.
 */
export interface AuthUser {
  id: string;
  role: UserRole;
  email?: string;
  displayName?: string;
}

/**
 * Moleculer `before` hook for admin-only actions.
 *
 * Stricter than the `EndpointType.ADMIN` gate — this enforces the role
 * even on internal `ctx.call` invocations (gateway authorize() does not
 * fire on internal calls). Throws 401 with a Lithuanian message.
 *
 * Internal trusted callers (auth flows, system transitions) can opt out
 * via `ctx.meta._systemTransition = true` — but ONLY set this flag inline
 * in code, never from request input.
 */
export function requireAdminHook<P = any>(ctx: Context<P, { user?: AuthUser; _systemTransition?: boolean }>) {
  if (ctx.meta?._systemTransition) return ctx;
  const role = ctx.meta?.user?.role;
  if (role !== UserRole.ADMIN) {
    throw new Errors.MoleculerClientError(
      'Šį veiksmą gali atlikti tik administratorius.',
      403,
      'FORBIDDEN',
    );
  }
  return ctx;
}
