'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';

const db = knex(knexConfig);

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
}

/**
 * Append-only audit log. Records security-sensitive admin actions
 * (ADMIN_ASSIGN_ROOM, ADMIN_SET_ROLE, ADMIN_CANCEL_RESERVATION). The table
 * has no UPDATE / DELETE actions — entries are forever, indexed by
 * `created_at`, `action` and `user_id` for the admin browse UI.
 *
 * Not a DbService — the data flow is one-way and trivial. Direct Knex
 * is simpler than wrestling DbService's hooks for a write-only logger.
 */
@Service({
  name: 'audit',
})
export default class AuditService extends moleculer.Service {
  /**
   * Internal: record an audit row. Best-effort — never throws, so a logging
   * outage doesn't break the calling admin action. Errors are logged so an
   * operator can spot a persistent fault.
   */
  @Action({
    auth: false,
    params: {
      userId: { type: 'string', optional: true },
      action: { type: 'string', min: 1, max: 100 },
      payload: { type: 'any', optional: true },
    },
  })
  async log(
    ctx: Context<
      { userId?: string; action: string; payload?: any },
      UserAuthMeta
    >,
  ) {
    if (!ctx.meta?._systemTransition) {
      // Auditing is internal — public REST exposure would let any
      // authenticated user inject log entries to drown signal in noise.
      throw new Errors.MoleculerClientError(
        'audit.log is internal-only.',
        403,
        'INTERNAL_ONLY',
      );
    }
    try {
      await db('audit_log').insert({
        user_id: ctx.params.userId || null,
        action: ctx.params.action,
        payload: ctx.params.payload ?? {},
      });
    } catch (err: any) {
      this.logger.warn(
        `[audit] insert failed for action=${ctx.params.action}: ${err?.message || err}`,
      );
    }
  }

  /**
   * Admin browse: paginated audit log with optional filters.
   */
  @Action({
    rest: 'GET /',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      action: { type: 'string', optional: true, max: 100 },
      userId: { type: 'string', optional: true },
      limit: { type: 'number', integer: true, convert: true, optional: true, min: 1, max: 500 },
      offset: { type: 'number', integer: true, convert: true, optional: true, min: 0 },
    },
  })
  async listAudit(
    ctx: Context<
      { action?: string; userId?: string; limit?: number; offset?: number },
      UserAuthMeta
    >,
  ) {
    requireAdminHook(ctx);
    const limit = ctx.params.limit ?? 100;
    const offset = ctx.params.offset ?? 0;

    const baseQuery = db('audit_log');
    if (ctx.params.action) baseQuery.where({ action: ctx.params.action });
    if (ctx.params.userId) baseQuery.where({ user_id: ctx.params.userId });

    const [{ count }] = await baseQuery.clone().count<{ count: string }[]>('id as count');
    const rows = await baseQuery
      .clone()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    return {
      // knexSnakeCaseMappers converts row keys to camelCase.
      items: rows.map((r: any) => ({
        id: r.id,
        userId: r.userId,
        action: r.action,
        payload: r.payload,
        createdAt: r.createdAt,
      })),
      total: Number(count),
    };
  }
}
