'use strict';

import { Service, ServiceBroker, Context, Errors } from 'moleculer';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import knex from 'knex';
import knexConfig from '../knexfile';
import { signSession } from '../utils/auth';
import { serializeSessionCookie, appendSetCookieToMeta } from '../utils/cookies';
import { UserRole } from '../types/constants';

/**
 * Admin login (username + password).
 *
 * Separate from the Microsoft OAuth flow used by regular @am.lt users.
 * Admins ALWAYS log in via /admin/login — Microsoft accounts are treated
 * as USER role regardless of email. Bcrypt-hashed password in env, no DB
 * password column.
 *
 * Security:
 *  - bcrypt(12) password verification, constant-time via bcrypt's own impl
 *  - per-IP rate limit (5 attempts / 15 min, in-memory Map — fine for single
 *    instance, replace with Redis if horizontal scale becomes a thing)
 *  - audit log entry on EVERY attempt (success + fail)
 *  - same SameSite=Lax session cookie as the Microsoft flow
 *  - returns 401 (not 403) on bad creds to avoid leaking username validity
 */

interface AttemptRecord {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, AttemptRecord>();

function checkAndRecordAttempt(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts.entries()) {
    if (rec.resetAt < now) attempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

interface AdminEnv {
  username: string;
  passwordHash: string;
  email: string;
  displayName: string;
}

function readAdminEnv(): AdminEnv | null {
  const username = (process.env.ADMIN_USERNAME || '').trim();
  const passwordHash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const displayName = (process.env.ADMIN_DISPLAY_NAME || 'Administratorius').trim();

  if (!username || !passwordHash || !email) {
    return null;
  }
  return { username, passwordHash, email, displayName };
}

type AdminAuthMeta = {
  user?: any;
  $statusCode?: number;
  $responseHeaders?: Record<string, string | string[]>;
  $responseType?: string;
};

export default class AdminAuthService extends Service {
  private db = knex(knexConfig as any);

  public constructor(broker: ServiceBroker) {
    super(broker);
    this.parseServiceSchema({
      name: 'adminAuth',
      actions: {
        adminLogin: {
          // No `rest:` — explicit alias in api.service.ts publishes this
          // as `POST /api/auth/admin-login` (autoAliases would prepend
          // the service name, giving `/api/adminAuth/auth/admin-login`).
          auth: false,
          params: {
            username: { type: 'string', min: 1, max: 64 },
            password: { type: 'string', min: 1, max: 256 },
          },
          handler: this.handleAdminLogin,
        },
      },
      stopped: async () => {
        await this.db.destroy().catch(() => undefined);
      },
    });
  }

  private async handleAdminLogin(
    ctx: Context<{ username: string; password: string }, AdminAuthMeta>,
  ): Promise<{ ok: true } | never> {
    const env = readAdminEnv();
    if (!env) {
      throw new Errors.MoleculerClientError(
        'Admin login disabled (env vars not configured).',
        503,
        'ADMIN_LOGIN_DISABLED',
      );
    }

    const ip = this.resolveIp(ctx);
    const limit = checkAndRecordAttempt(ip);
    if (!limit.allowed) {
      await this.audit({
        action: 'ADMIN_LOGIN_RATE_LIMITED',
        payload: { ip, retryAfterSec: limit.retryAfterSec },
      });
      throw new Errors.MoleculerClientError(
        `Per daug bandymų. Pabandyk po ${limit.retryAfterSec ?? 900} sek.`,
        429,
        'RATE_LIMITED',
      );
    }

    const { username, password } = ctx.params;
    const usernameMatches = username === env.username;
    const passwordMatches = await bcrypt.compare(password, env.passwordHash);

    if (!usernameMatches || !passwordMatches) {
      await this.audit({
        action: 'ADMIN_LOGIN_FAILED',
        payload: { ip, username },
      });
      throw new Errors.MoleculerClientError(
        'Neteisingas vartotojo vardas arba slaptažodis.',
        401,
        'INVALID_CREDENTIALS',
      );
    }

    clearAttempts(ip);

    const user = await this.findOrCreateAdminUser(env);
    const token = signSession({
      sub: user.id,
      role: UserRole.ADMIN,
      jti: randomUUID(),
    });
    const cookie = serializeSessionCookie(token);
    appendSetCookieToMeta(ctx.meta as any, cookie);
    ctx.meta.$statusCode = 200;

    await this.audit({
      action: 'ADMIN_LOGIN_SUCCESS',
      payload: { ip, userId: user.id, email: user.email },
      userId: user.id,
    });

    return { ok: true };
  }

  private resolveIp(ctx: Context<unknown, AdminAuthMeta>): string {
    const meta = ctx.meta as any;
    const headers = meta?.headers ?? meta?.parentCtx?.params?.req?.headers ?? {};
    const xff = headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
    return (
      headers['x-real-ip'] ||
      meta?.parentCtx?.params?.req?.connection?.remoteAddress ||
      'unknown'
    );
  }

  private async findOrCreateAdminUser(env: AdminEnv) {
    const existing = await this.db('users').where('email', env.email).first();
    if (existing) {
      if (existing.role !== UserRole.ADMIN) {
        await this.db('users').where('id', existing.id).update({ role: UserRole.ADMIN, updated_at: this.db.fn.now() });
      }
      return existing;
    }
    const [created] = await this.db('users')
      .insert({
        email: env.email,
        display_name: env.displayName,
        role: UserRole.ADMIN,
      })
      .returning('*');
    return created;
  }

  private async audit(opts: { action: string; payload: unknown; userId?: string }) {
    try {
      await this.broker.call(
        'audit.log',
        { action: opts.action, payload: opts.payload, userId: opts.userId },
        { meta: { _systemTransition: true } } as any,
      );
    } catch (err) {
      this.logger.warn('audit.log failed', err);
    }
  }
}
