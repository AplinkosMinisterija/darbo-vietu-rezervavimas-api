'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import knex from 'knex';
import DatabaseMixin from '../mixins/database.mixin';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';

/**
 * Shared Knex handle. Writes go through Knex directly so we can run the
 * "future reservation" pre-flight check + the table mutation in one
 * transaction — DbService's built-in actions don't compose well with
 * cross-table validation.
 */
const db = knex(knexConfig);

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
}

/**
 * Field projection that goes back over the wire. Mirrors the prototype:
 * id, number, name, floor, deskCount, isShared, createdAt. `deleted_at`
 * is filtered server-side and never exposed.
 */
function normalizeRoomRow(row: any) {
  if (!row) return null;
  // knexfile uses knexSnakeCaseMappers — rows come back camelCased already.
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    floor: row.floor,
    deskCount: row.deskCount,
    isShared: row.isShared,
    createdAt: row.createdAt,
  };
}

@Service({
  name: 'rooms',
  mixins: [DatabaseMixin({ collection: 'rooms' })],
  settings: {
    fields: {
      id: { type: 'string', primaryKey: true, columnType: 'uuid', readonly: true },
      number: { type: 'string', required: true },
      name: { type: 'string', required: true },
      floor: { type: 'number', integer: true, min: 1, max: 10, required: true },
      deskCount: {
        type: 'number',
        integer: true,
        min: 0,
        columnName: 'desk_count',
        required: true,
      },
      isShared: { type: 'boolean', columnName: 'is_shared', default: false },
      createdAt: { type: 'date', columnName: 'created_at', readonly: true },
    },
  },
  hooks: {
    before: {
      // The DbService built-in mutators are locked to ADMIN. The custom
      // actions below have their own `requireAdminHook` call inline so the
      // gate also fires when invoked via REST aliases.
      create: 'requireAdminHookMethod',
      update: 'requireAdminHookMethod',
      replace: 'requireAdminHookMethod',
      remove: 'requireAdminHookMethod',
    },
  },
  actions: {
    create: { auth: true, types: [EndpointType.ADMIN] },
    update: { auth: true, types: [EndpointType.ADMIN] },
    replace: { auth: true, types: [EndpointType.ADMIN] },
    remove: { auth: true, types: [EndpointType.ADMIN] },
  },
})
export default class RoomsService extends moleculer.Service {
  @Method
  requireAdminHookMethod(ctx: Context<any, UserAuthMeta>) {
    return requireAdminHook(ctx);
  }

  /**
   * Paginated room list. Every authenticated user sees every room — the
   * room layout itself isn't PII; only reservation attribution is.
   * Soft-deleted rows are filtered out.
   */
  @Action({
    rest: 'GET /',
    auth: true,
    types: [EndpointType.USER],
    params: {
      limit: { type: 'number', integer: true, convert: true, optional: true, min: 1, max: 500 },
      offset: { type: 'number', integer: true, convert: true, optional: true, min: 0 },
    },
  })
  async listRooms(
    ctx: Context<{ limit?: number; offset?: number }, UserAuthMeta>,
  ) {
    const limit = ctx.params.limit ?? 200;
    const offset = ctx.params.offset ?? 0;

    const baseQuery = db('rooms').whereNull('deleted_at');
    const [{ count }] = await baseQuery.clone().count<{ count: string }[]>('id as count');
    const rows = await baseQuery
      .clone()
      .orderBy([
        { column: 'floor', order: 'asc' },
        { column: 'number', order: 'asc' },
      ])
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map(normalizeRoomRow),
      total: Number(count),
    };
  }

  /**
   * Single-room lookup. Returns 404 if the room was soft-deleted — the
   * route is a UI deep-link target and stale links should fail loudly.
   */
  @Action({
    rest: 'GET /:id',
    auth: true,
    types: [EndpointType.USER],
    params: { id: 'string' },
  })
  async getRoom(ctx: Context<{ id: string }, UserAuthMeta>) {
    const rows = await db('rooms')
      .where({ id: ctx.params.id })
      .whereNull('deleted_at')
      .limit(1);
    if (rows.length === 0) {
      throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'NOT_FOUND');
    }
    return normalizeRoomRow(rows[0]);
  }

  /**
   * Admin: create a new room. `number` is uniquely indexed at the DB level
   * so we let PG raise `23505` and translate it into a clean 409 — beats
   * a pre-check that races against a concurrent insert.
   */
  @Action({
    rest: 'POST /',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      number: { type: 'string', min: 1, max: 32 },
      name: { type: 'string', min: 1, max: 200 },
      floor: { type: 'number', integer: true, convert: true, min: 1, max: 10 },
      deskCount: { type: 'number', integer: true, convert: true, min: 0 },
      isShared: { type: 'boolean', convert: true, optional: true, default: false },
    },
  })
  async createRoom(
    ctx: Context<
      { number: string; name: string; floor: number; deskCount: number; isShared?: boolean },
      UserAuthMeta
    >,
  ) {
    requireAdminHook(ctx);
    try {
      const [created] = await db('rooms')
        .insert({
          number: ctx.params.number,
          name: ctx.params.name,
          floor: ctx.params.floor,
          desk_count: ctx.params.deskCount,
          is_shared: ctx.params.isShared ?? false,
        })
        .returning('*');

      await this.safeAuditLog(ctx, 'ADMIN_CREATE_ROOM', {
        roomId: created.id,
        number: created.number,
        name: created.name,
        floor: created.floor,
        deskCount: created.deskCount,
        isShared: created.isShared,
      });

      return normalizeRoomRow(created);
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new Errors.MoleculerClientError(
          'Tokia patalpa jau registruota',
          409,
          'NUMBER_TAKEN',
        );
      }
      throw err;
    }
  }

  /**
   * Admin: partial update. Defensive default — if the new `deskCount`
   * would orphan future reservations on desks N+1..M, refuse with 409
   * and ask the admin to cancel them first. Auto-cancelling the
   * reservations server-side would silently drop user expectations.
   */
  @Action({
    rest: 'PUT /:id',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      id: 'string',
      name: { type: 'string', min: 1, max: 200, optional: true },
      floor: { type: 'number', integer: true, convert: true, min: 1, max: 10, optional: true },
      deskCount: { type: 'number', integer: true, convert: true, min: 0, optional: true },
      isShared: { type: 'boolean', convert: true, optional: true },
    },
  })
  async updateRoom(
    ctx: Context<
      {
        id: string;
        name?: string;
        floor?: number;
        deskCount?: number;
        isShared?: boolean;
      },
      UserAuthMeta
    >,
  ) {
    requireAdminHook(ctx);

    const existingRows = await db('rooms')
      .where({ id: ctx.params.id })
      .whereNull('deleted_at')
      .limit(1);
    if (existingRows.length === 0) {
      throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'NOT_FOUND');
    }
    const existing = existingRows[0];

    // Only check future reservations when desk_count is actually shrinking.
    if (typeof ctx.params.deskCount === 'number' && ctx.params.deskCount < existing.deskCount) {
      const orphans = await db('reservations')
        .where({ room_id: ctx.params.id })
        .andWhere('date', '>=', db.raw('CURRENT_DATE'))
        .andWhere('desk_number', '>', ctx.params.deskCount)
        .select('desk_number', 'date');

      if (orphans.length > 0) {
        const lo = Math.min(...orphans.map((r: any) => Number(r.deskNumber)));
        const hi = Math.max(...orphans.map((r: any) => Number(r.deskNumber)));
        throw new Errors.MoleculerClientError(
          `Stalai ${lo}..${hi} turi būsimas rezervacijas, atšaukite prieš mažinant`,
          409,
          'DESK_HAS_FUTURE_RESERVATIONS',
        );
      }
    }

    const updatePayload: any = { updated_at: db.fn.now() };
    if (ctx.params.name !== undefined) updatePayload.name = ctx.params.name;
    if (ctx.params.floor !== undefined) updatePayload.floor = ctx.params.floor;
    if (ctx.params.deskCount !== undefined) updatePayload.desk_count = ctx.params.deskCount;
    if (ctx.params.isShared !== undefined) updatePayload.is_shared = ctx.params.isShared;

    const [updated] = await db('rooms')
      .where({ id: ctx.params.id })
      .update(updatePayload)
      .returning('*');

    await this.safeAuditLog(ctx, 'ADMIN_UPDATE_ROOM', {
      roomId: updated.id,
      changes: {
        name: ctx.params.name,
        floor: ctx.params.floor,
        deskCount: ctx.params.deskCount,
        isShared: ctx.params.isShared,
      },
    });

    return normalizeRoomRow(updated);
  }

  /**
   * Admin: soft-delete. Same defensive posture as updateRoom — refuse if
   * any future reservation exists. Past reservations are retained for
   * audit/history (room row survives, just filtered from listings).
   */
  @Action({
    rest: 'DELETE /:id',
    auth: true,
    types: [EndpointType.ADMIN],
    params: { id: 'string' },
  })
  async deleteRoom(ctx: Context<{ id: string }, UserAuthMeta>) {
    requireAdminHook(ctx);

    const existingRows = await db('rooms')
      .where({ id: ctx.params.id })
      .whereNull('deleted_at')
      .limit(1);
    if (existingRows.length === 0) {
      throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'NOT_FOUND');
    }

    const futureCount = await db('reservations')
      .where({ room_id: ctx.params.id })
      .andWhere('date', '>=', db.raw('CURRENT_DATE'))
      .count<{ count: string }[]>('id as count');

    if (Number(futureCount[0].count) > 0) {
      throw new Errors.MoleculerClientError(
        'Yra būsimų rezervacijų, atšaukite prieš trindami',
        409,
        'ROOM_HAS_FUTURE_RESERVATIONS',
      );
    }

    await db('rooms')
      .where({ id: ctx.params.id })
      .update({ deleted_at: db.fn.now(), updated_at: db.fn.now() });

    await this.safeAuditLog(ctx, 'ADMIN_DELETE_ROOM', { roomId: ctx.params.id });

    return { ok: true };
  }

  // --- helpers ---

  @Method
  async safeAuditLog(ctx: Context<any, UserAuthMeta>, action: string, payload: any) {
    try {
      await ctx.broker.call(
        'audit.log',
        { userId: ctx.meta?.user?.id, action, payload },
        { meta: { _systemTransition: true } } as any,
      );
    } catch (err: any) {
      this.logger.warn(`[rooms] audit.log failed: ${err?.message || err}`);
    }
  }
}
