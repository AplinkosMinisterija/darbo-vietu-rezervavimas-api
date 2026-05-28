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
 * Emergency admin login.
 *
 * Fallback path when Microsoft OAuth is unavailable (Azure secret expired,
 * tenant outage, etc.). Logs the user in as a pre-designated ADMIN account
 * using a bcrypt-hashed password stored in env. Never replaces Microsoft
 * OAuth for normal use — there is no link from the main UI to this page;
 * the URL `/admin/emergency-login` is a bookmark.
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

interface EmergencyEnv {
  username: string;
  passwordHash: string;
  email: string;
  displayName: string;
}

function readEmergencyEnv(): EmergencyEnv | null {
  const username = (process.env.EMERGENCY_ADMIN_USERNAME || '').trim();
  const passwordHash = (process.env.EMERGENCY_ADMIN_PASSWORD_HASH || '').trim();
  const email = (process.env.EMERGENCY_ADMIN_EMAIL || '').trim().toLowerCase();
  const displayName = (process.env.EMERGENCY_ADMIN_DISPLAY_NAME || 'Emergency Admin').trim();

  if (!username || !passwordHash || !email) {
    return null;
  }
  return { username, passwordHash, email, displayName };
}

type EmergencyAuthMeta = {
  user?: any;
  $statusCode?: number;
  $responseHeaders?: Record<string, string | string[]>;
  $responseType?: string;
};

export default class EmergencyAuthService extends Service {
  private db = knex(knexConfig as any);

  public constructor(broker: ServiceBroker) {
    super(broker);
    this.parseServiceSchema({
      name: 'emergencyAuth',
      actions: {
        emergencyLogin: {
          rest: 'POST /auth/emergency-login',
          params: {
            username: { type: 'string', min: 1, max: 64 },
            password: { type: 'string', min: 1, max: 256 },
          },
          handler: this.handleEmergencyLogin,
        },
      },
      stopped: async () => {
        await this.db.destroy().catch(() => undefined);
      },
    });
  }

  private async handleEmergencyLogin(
    ctx: Context<{ username: string; password: string }, EmergencyAuthMeta>,
  ): Promise<{ ok: true } | never> {
    const env = readEmergencyEnv();
    if (!env) {
      throw new Errors.MoleculerClientError(
        'Emergency login disabled (env vars not configured).',
        503,
        'EMERGENCY_LOGIN_DISABLED',
      );
    }

    const ip = this.resolveIp(ctx);
    const limit = checkAndRecordAttempt(ip);
    if (!limit.allowed) {
      await this.audit({
        action: 'EMERGENCY_LOGIN_RATE_LIMITED',
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
        action: 'EMERGENCY_LOGIN_FAILED',
        payload: { ip, username },
      });
      throw new Errors.MoleculerClientError(
        'Neteisingas vartotojo vardas arba slaptažodis.',
        401,
        'INVALID_CREDENTIALS',
      );
    }

    clearAttempts(ip);

    const user = await this.findOrCreateEmergencyUser(env);
    const token = signSession({
      sub: user.id,
      role: UserRole.ADMIN,
      jti: randomUUID(),
    });
    const cookie = serializeSessionCookie(token);
    appendSetCookieToMeta(ctx.meta as any, cookie);
    ctx.meta.$statusCode = 200;

    await this.audit({
      action: 'EMERGENCY_LOGIN_SUCCESS',
      payload: { ip, userId: user.id, email: user.email },
      userId: user.id,
    });

    return { ok: true };
  }

  private resolveIp(ctx: Context<unknown, EmergencyAuthMeta>): string {
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

  private async findOrCreateEmergencyUser(env: EmergencyEnv) {
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
