'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import knex from 'knex';
import DatabaseMixin from '../mixins/database.mixin';
import knexConfig from '../knexfile';
import { EndpointType, UserRole } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';
import { isRoomManager } from '../utils/roomAccess';

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
      floor: { type: 'number', integer: true, min: 0, max: 10, required: true },
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
      floor: { type: 'number', integer: true, convert: true, min: 0, max: 10 },
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
    // USER-gated at the gateway; the handler enforces admin OR room-manager.
    types: [EndpointType.USER],
    params: {
      id: 'string',
      number: { type: 'string', min: 1, max: 32, optional: true },
      name: { type: 'string', min: 1, max: 200, optional: true },
      floor: { type: 'number', integer: true, convert: true, min: 0, max: 10, optional: true },
      deskCount: { type: 'number', integer: true, convert: true, min: 0, optional: true },
      isShared: { type: 'boolean', convert: true, optional: true },
    },
  })
  async updateRoom(
    ctx: Context<
      {
        id: string;
        number?: string;
        name?: string;
        floor?: number;
        deskCount?: number;
        isShared?: boolean;
      },
      UserAuthMeta
    >,
  ) {
    // Authorization: admins may edit everything; a room MANAGER may edit only
    // their own room's desk count + name (number/floor/isShared stay admin-only).
    const isAdmin = ctx.meta?._systemTransition === true || ctx.meta?.user?.role === UserRole.ADMIN;
    if (!isAdmin) {
      const userId = ctx.meta?.user?.id;
      if (!userId || !(await isRoomManager(db, userId, ctx.params.id))) {
        throw new Errors.MoleculerClientError(
          'Šią patalpą gali redaguoti tik administratorius arba jos vadovas.',
          403,
          'FORBIDDEN',
        );
      }
      if (
        ctx.params.number !== undefined ||
        ctx.params.floor !== undefined ||
        ctx.params.isShared !== undefined
      ) {
        throw new Errors.MoleculerClientError(
          'Vadovas gali keisti tik darbo vietų skaičių ir pavadinimą.',
          403,
          'MANAGER_FIELD_FORBIDDEN',
        );
      }
    }

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
          `Darbo vietos ${lo}..${hi} turi būsimas rezervacijas, atšaukite prieš mažinant`,
          409,
          'DESK_HAS_FUTURE_RESERVATIONS',
        );
      }
    }

    const updatePayload: any = { updated_at: db.fn.now() };
    if (ctx.params.number !== undefined) updatePayload.number = ctx.params.number;
    if (ctx.params.name !== undefined) updatePayload.name = ctx.params.name;
    if (ctx.params.floor !== undefined) updatePayload.floor = ctx.params.floor;
    if (ctx.params.deskCount !== undefined) updatePayload.desk_count = ctx.params.deskCount;
    if (ctx.params.isShared !== undefined) updatePayload.is_shared = ctx.params.isShared;

    let updated: any;
    try {
      [updated] = await db('rooms')
        .where({ id: ctx.params.id })
        .update(updatePayload)
        .returning('*');
    } catch (err: any) {
      // `number` is uniquely indexed — a rename collision surfaces as 23505.
      if (err?.code === '23505') {
        throw new Errors.MoleculerClientError(
          'Tokia patalpa jau registruota',
          409,
          'NUMBER_TAKEN',
        );
      }
      throw err;
    }

    await this.safeAuditLog(ctx, 'ADMIN_UPDATE_ROOM', {
      roomId: updated.id,
      changes: {
        number: ctx.params.number,
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

  /**
   * Admin or room-manager: list users assigned to a room (the room's "members"
   * the manager schedules). 404 if the room is gone.
   */
  @Action({
    rest: 'GET /:id/members',
    auth: true,
    types: [EndpointType.USER],
    params: { id: 'string' },
  })
  async listMembers(ctx: Context<{ id: string }, UserAuthMeta>) {
    await this.assertManageRoom(ctx, ctx.params.id);
    const room = await db('rooms').where({ id: ctx.params.id }).whereNull('deleted_at').first();
    if (!room) throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'NOT_FOUND');
    const rows = await db('user_room_assignments as a')
      .join('users as u', 'u.id', 'a.userId')
      .where('a.roomId', ctx.params.id)
      .whereNull('u.deletedAt')
      .orderBy('u.displayName', 'asc')
      .select('u.id', 'u.displayName', 'u.email');
    return rows.map((u: any) => ({ id: u.id, displayName: u.displayName, email: u.email }));
  }

  /**
   * Admin or room-manager: assign a user to this room (room membership).
   * Idempotent.
   */
  @Action({
    rest: 'POST /:id/members',
    auth: true,
    types: [EndpointType.USER],
    params: { id: 'string', userId: { type: 'uuid' } },
  })
  async addMember(ctx: Context<{ id: string; userId: string }, UserAuthMeta>) {
    await this.assertManageRoom(ctx, ctx.params.id);
    const room = await db('rooms').where({ id: ctx.params.id }).whereNull('deleted_at').first();
    if (!room) throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'NOT_FOUND');
    const u = await db('users').where({ id: ctx.params.userId }).whereNull('deleted_at').first();
    if (!u) throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'USER_NOT_FOUND');
    await db('user_room_assignments')
      .insert({ user_id: ctx.params.userId, room_id: ctx.params.id })
      .onConflict(['user_id', 'room_id'])
      .ignore();
    await this.safeAuditLog(ctx, 'ROOM_ADD_MEMBER', { roomId: ctx.params.id, userId: ctx.params.userId });
    return { ok: true };
  }

  /**
   * Admin or room-manager: remove a user's assignment to this room.
   */
  @Action({
    rest: 'DELETE /:id/members/:userId',
    auth: true,
    types: [EndpointType.USER],
    params: { id: 'string', userId: 'string' },
  })
  async removeMember(ctx: Context<{ id: string; userId: string }, UserAuthMeta>) {
    await this.assertManageRoom(ctx, ctx.params.id);
    await db('user_room_assignments')
      .where({ user_id: ctx.params.userId, room_id: ctx.params.id })
      .delete();
    await this.safeAuditLog(ctx, 'ROOM_REMOVE_MEMBER', { roomId: ctx.params.id, userId: ctx.params.userId });
    return { ok: true };
  }

  /**
   * Admin or room-manager: reservations in this room over a date range (for the
   * manager's schedule view). Includes the booked user's name.
   */
  @Action({
    rest: 'GET /:id/reservations',
    auth: true,
    types: [EndpointType.USER],
    params: {
      id: 'string',
      dateFrom: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true },
      dateTo: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true },
    },
  })
  async roomReservations(
    ctx: Context<{ id: string; dateFrom?: string; dateTo?: string }, UserAuthMeta>,
  ) {
    await this.assertManageRoom(ctx, ctx.params.id);
    const q = db('reservations as res')
      .join('users as u', 'u.id', 'res.userId')
      .where('res.roomId', ctx.params.id);
    if (ctx.params.dateFrom) q.andWhere('res.date', '>=', ctx.params.dateFrom);
    if (ctx.params.dateTo) q.andWhere('res.date', '<=', ctx.params.dateTo);
    const rows = await q
      .orderBy([{ column: 'res.date', order: 'asc' }, { column: 'res.deskNumber', order: 'asc' }])
      .select('res.id', 'res.deskNumber', 'res.date', 'u.id as userId', 'u.displayName as userDisplayName');
    return rows.map((r: any) => ({
      id: r.id,
      deskNumber: r.deskNumber,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      user: { id: r.userId, displayName: r.userDisplayName },
    }));
  }

  // --- helpers ---

  /**
   * Authorization gate for room-scoped management: passes for admins (and
   * trusted internal calls) and for users who manage `roomId`. Throws 403
   * otherwise.
   */
  @Method
  async assertManageRoom(ctx: Context<any, UserAuthMeta>, roomId: string) {
    if (ctx.meta?._systemTransition === true || ctx.meta?.user?.role === UserRole.ADMIN) return;
    const userId = ctx.meta?.user?.id;
    if (!userId || !(await isRoomManager(db, userId, roomId))) {
      throw new Errors.MoleculerClientError(
        'Šią patalpą gali tvarkyti tik administratorius arba jos vadovas.',
        403,
        'FORBIDDEN',
      );
    }
  }

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
