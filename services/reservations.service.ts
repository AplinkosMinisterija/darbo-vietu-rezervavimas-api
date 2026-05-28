'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import knex from 'knex';
import DatabaseMixin from '../mixins/database.mixin';
import knexConfig from '../knexfile';
import { EndpointType, UserRole } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';

const db = knex(knexConfig);

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
}

/**
 * Cross-user reservation listing for a single date. Returns enough info to
 * render "kas užimta": id, roomId, deskNumber, date, user.displayName,
 * createdAt. Critically we do NOT leak `user.email` — display name is
 * already shown on the prototype tooltip and the email is treated as PII
 * (the FE renders only displayName).
 */
// knexfile uses knexSnakeCaseMappers — column names come back camelCased.
// `r.room_id AS user_id` round-trips as `userId`, `u.display_name AS user_display_name`
// becomes `userDisplayName`, etc.
function projectReservationWithUser(row: any) {
  return {
    id: row.id,
    roomId: row.roomId,
    deskNumber: row.deskNumber,
    date: row.date,
    user: {
      id: row.userId,
      displayName: row.userDisplayName,
    },
    createdAt: row.createdAt,
  };
}

function projectReservationWithRoom(row: any) {
  return {
    id: row.id,
    roomId: row.roomId,
    deskNumber: row.deskNumber,
    date: row.date,
    room: {
      number: row.roomNumber,
      name: row.roomName,
      floor: row.roomFloor,
    },
    createdAt: row.createdAt,
  };
}

function projectAdminReservation(row: any) {
  return {
    id: row.id,
    roomId: row.roomId,
    deskNumber: row.deskNumber,
    date: row.date,
    user: {
      id: row.userId,
      displayName: row.userDisplayName,
      email: row.userEmail,
    },
    room: {
      number: row.roomNumber,
      name: row.roomName,
      floor: row.roomFloor,
    },
    createdAt: row.createdAt,
  };
}

/**
 * YYYY-MM-DD validator — used by Moleculer params validation. The DB column
 * is `date` so we accept the ISO date string and let PG parse it.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Service({
  name: 'reservations',
  // Reservations table is read-heavy via REST and write-heavy via the
  // custom `create`/`cancel` actions. We keep DbService for parity but lock
  // every built-in action behind ADMIN — the public REST surface is the
  // explicit `@Action` handlers below.
  mixins: [DatabaseMixin({ collection: 'reservations' })],
  settings: {
    fields: {
      id: { type: 'string', primaryKey: true, columnType: 'uuid', readonly: true },
      userId: { type: 'string', columnName: 'user_id', required: true },
      roomId: { type: 'string', columnName: 'room_id', required: true },
      deskNumber: { type: 'number', integer: true, min: 1, columnName: 'desk_number', required: true },
      date: { type: 'string', required: true },
      createdAt: { type: 'date', columnName: 'created_at', readonly: true },
    },
  },
  hooks: {
    before: {
      create: 'requireAdminHookMethod',
      update: 'requireAdminHookMethod',
      replace: 'requireAdminHookMethod',
      remove: 'requireAdminHookMethod',
      list: 'requireAdminHookMethod',
      find: 'requireAdminHookMethod',
      get: 'requireAdminHookMethod',
      resolve: 'requireAdminHookMethod',
      count: 'requireAdminHookMethod',
    },
  },
  actions: {
    create: { auth: true, types: [EndpointType.ADMIN] },
    update: { auth: true, types: [EndpointType.ADMIN] },
    replace: { auth: true, types: [EndpointType.ADMIN] },
    remove: { auth: true, types: [EndpointType.ADMIN] },
    list: { auth: true, types: [EndpointType.ADMIN] },
    find: { auth: true, types: [EndpointType.ADMIN] },
    get: { auth: true, types: [EndpointType.ADMIN] },
    resolve: { auth: true, types: [EndpointType.ADMIN] },
    count: { auth: true, types: [EndpointType.ADMIN] },
  },
})
export default class ReservationsService extends moleculer.Service {
  @Method
  requireAdminHookMethod(ctx: Context<any, UserAuthMeta>) {
    return requireAdminHook(ctx);
  }

  /**
   * Reservations on a single date — used by the day-view grid. Every
   * authenticated user can see who occupies each desk (displayName only,
   * no email).
   */
  @Action({
    rest: 'GET /',
    auth: true,
    types: [EndpointType.USER],
    params: {
      date: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async byDate(ctx: Context<{ date: string }, UserAuthMeta>) {
    const rows = await db('reservations as r')
      .leftJoin('users as u', 'u.id', 'r.user_id')
      .where({ 'r.date': ctx.params.date })
      .orderBy(['r.room_id', 'r.desk_number'])
      .select(
        'r.id',
        'r.room_id',
        'r.desk_number',
        'r.date',
        'r.user_id',
        'r.created_at',
        'u.display_name as user_display_name',
      );
    return rows.map(projectReservationWithUser);
  }

  /**
   * Current user's upcoming reservations. Past reservations are hidden —
   * the FE "mano rezervacijos" panel only shows what's actionable.
   */
  @Action({
    rest: 'GET /mine',
    auth: true,
    types: [EndpointType.USER],
  })
  async mine(ctx: Context<{}, UserAuthMeta>) {
    if (!ctx.meta?.user?.id) {
      throw new Errors.MoleculerClientError('Neprisijungta.', 401, 'NOT_AUTHENTICATED');
    }
    const rows = await db('reservations as r')
      .leftJoin('rooms as room', 'room.id', 'r.room_id')
      .where({ 'r.user_id': ctx.meta.user.id })
      .andWhere('r.date', '>=', db.raw('CURRENT_DATE'))
      .orderBy('r.date', 'asc')
      .select(
        'r.id',
        'r.room_id',
        'r.desk_number',
        'r.date',
        'r.created_at',
        'room.number as room_number',
        'room.name as room_name',
        'room.floor as room_floor',
      );
    return rows.map(projectReservationWithRoom);
  }

  /**
   * Admin: cross-cutting reservation browser. Joins users + rooms so the
   * admin UI doesn't need follow-up lookups. Filters: dateFrom, dateTo,
   * userId, roomId.
   */
  @Action({
    rest: 'GET /all',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      dateFrom: { type: 'string', pattern: DATE_PATTERN, optional: true },
      dateTo: { type: 'string', pattern: DATE_PATTERN, optional: true },
      userId: { type: 'string', optional: true },
      roomId: { type: 'string', optional: true },
      limit: { type: 'number', integer: true, convert: true, optional: true, min: 1, max: 500 },
      offset: { type: 'number', integer: true, convert: true, optional: true, min: 0 },
    },
  })
  async listAll(
    ctx: Context<
      {
        dateFrom?: string;
        dateTo?: string;
        userId?: string;
        roomId?: string;
        limit?: number;
        offset?: number;
      },
      UserAuthMeta
    >,
  ) {
    requireAdminHook(ctx);
    const limit = ctx.params.limit ?? 100;
    const offset = ctx.params.offset ?? 0;

    const baseQuery = db('reservations as r')
      .leftJoin('users as u', 'u.id', 'r.user_id')
      .leftJoin('rooms as room', 'room.id', 'r.room_id');

    if (ctx.params.dateFrom) baseQuery.andWhere('r.date', '>=', ctx.params.dateFrom);
    if (ctx.params.dateTo) baseQuery.andWhere('r.date', '<=', ctx.params.dateTo);
    if (ctx.params.userId) baseQuery.andWhere('r.user_id', ctx.params.userId);
    if (ctx.params.roomId) baseQuery.andWhere('r.room_id', ctx.params.roomId);

    const [{ count }] = await baseQuery.clone().count<{ count: string }[]>('r.id as count');
    const rows = await baseQuery
      .clone()
      .orderBy([
        { column: 'r.date', order: 'desc' },
        { column: 'r.created_at', order: 'desc' },
      ])
      .limit(limit)
      .offset(offset)
      .select(
        'r.id',
        'r.room_id',
        'r.desk_number',
        'r.date',
        'r.user_id',
        'r.created_at',
        'u.display_name as user_display_name',
        'u.email as user_email',
        'room.number as room_number',
        'room.name as room_name',
        'room.floor as room_floor',
      );

    return {
      items: rows.map(projectAdminReservation),
      total: Number(count),
    };
  }

  /**
   * User-facing create. Validation flow:
   *
   *   1. Room exists + not soft-deleted (404).
   *   2. Date is today or later (400 DATE_IN_PAST).
   *   3. deskNumber within the room's current desk_count (400 INVALID_DESK_NUMBER).
   *   4. User has access — room.is_shared OR user_room_assignments row (403 NO_ROOM_ACCESS).
   *   5. DB-level uniques translated:
   *        - reservations_room_desk_date_unique → 409 DESK_TAKEN
   *        - reservations_user_date_unique → 409 USER_HAS_RESERVATION
   *
   * The DB constraints are the actual race-proof boundary; the pre-checks
   * exist for clean error codes and to short-circuit obviously invalid
   * requests without burning a unique-index probe.
   */
  @Action({
    rest: 'POST /',
    auth: true,
    types: [EndpointType.USER],
    params: {
      roomId: { type: 'string' },
      deskNumber: { type: 'number', integer: true, convert: true, min: 1 },
      date: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async createReservation(
    ctx: Context<{ roomId: string; deskNumber: number; date: string }, UserAuthMeta>,
  ) {
    if (!ctx.meta?.user?.id) {
      throw new Errors.MoleculerClientError('Neprisijungta.', 401, 'NOT_AUTHENTICATED');
    }
    const userId = ctx.meta.user.id;

    // 1. Room exists?
    const roomRows = await db('rooms')
      .where({ id: ctx.params.roomId })
      .whereNull('deleted_at')
      .limit(1);
    if (roomRows.length === 0) {
      throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'ROOM_NOT_FOUND');
    }
    const room = roomRows[0];

    // 2. Date not in the past. Compared against PG's CURRENT_DATE in
    // server's timezone — matches the unique-constraint semantics and
    // avoids the client/server timezone-skew trap.
    const [{ is_past: isPast }] = await db.raw<{ rows: any[] }>(
      "SELECT (?::date < CURRENT_DATE) AS is_past",
      [ctx.params.date],
    ).then((res: any) => res.rows);
    if (isPast) {
      throw new Errors.MoleculerClientError(
        'Negalima rezervuoti praėjusiai datai',
        400,
        'DATE_IN_PAST',
      );
    }

    // 3. Desk number in range.
    if (ctx.params.deskNumber > room.desk_count) {
      throw new Errors.MoleculerClientError(
        'Tokio stalo nėra',
        400,
        'INVALID_DESK_NUMBER',
      );
    }

    // 4. Access — shared room OR explicit assignment.
    if (!room.is_shared) {
      const assignmentRows = await db('user_room_assignments')
        .where({ user_id: userId, room_id: room.id })
        .limit(1);
      if (assignmentRows.length === 0) {
        throw new Errors.MoleculerClientError(
          'Tu negali rezervuoti šioje patalpoje',
          403,
          'NO_ROOM_ACCESS',
        );
      }
    }

    // 5. Insert — let DB uniques translate to friendly conflict codes.
    try {
      const [created] = await db('reservations')
        .insert({
          user_id: userId,
          room_id: room.id,
          desk_number: ctx.params.deskNumber,
          date: ctx.params.date,
        })
        .returning('*');

      await this.safeAuditLog(ctx, 'RESERVE', {
        reservationId: created.id,
        roomId: created.room_id,
        deskNumber: created.desk_number,
        date: created.date,
      });

      return {
        id: created.id,
        roomId: created.room_id,
        deskNumber: created.desk_number,
        date: created.date,
        userId: created.user_id,
        createdAt: created.created_at,
      };
    } catch (err: any) {
      if (err?.code === '23505') {
        // PG hints at the constraint via err.constraint — we map by name so
        // the FE can show a precise message ("kitas user'is paėmė šitą stalą"
        // vs "tu jau turi rezervaciją tai dienai"). Falling back to a
        // generic 409 if the constraint name is unrecognized.
        const c: string = err.constraint || '';
        if (c.includes('user_date')) {
          throw new Errors.MoleculerClientError(
            'Jau turi rezervaciją tai dienai',
            409,
            'USER_HAS_RESERVATION',
          );
        }
        if (c.includes('room_desk_date')) {
          throw new Errors.MoleculerClientError(
            'Šis stalas tą dieną jau rezervuotas',
            409,
            'DESK_TAKEN',
          );
        }
        throw new Errors.MoleculerClientError(
          'Šis stalas tą dieną jau rezervuotas',
          409,
          'DESK_TAKEN',
        );
      }
      throw err;
    }
  }

  /**
   * Cancel a reservation. The owner can cancel their own; an ADMIN can
   * cancel anyone's. Past reservations are kept as historical record
   * (the unique constraints don't fire on past dates, so retaining them
   * is purely a UX policy).
   */
  @Action({
    rest: 'DELETE /:id',
    auth: true,
    types: [EndpointType.USER],
    params: { id: 'string' },
  })
  async cancelReservation(ctx: Context<{ id: string }, UserAuthMeta>) {
    if (!ctx.meta?.user?.id) {
      throw new Errors.MoleculerClientError('Neprisijungta.', 401, 'NOT_AUTHENTICATED');
    }
    const rows = await db('reservations').where({ id: ctx.params.id }).limit(1);
    if (rows.length === 0) {
      throw new Errors.MoleculerClientError('Rezervacija nerasta.', 404, 'NOT_FOUND');
    }
    const reservation = rows[0];

    const isOwner = String(reservation.user_id) === String(ctx.meta.user.id);
    const isAdmin = ctx.meta.user.role === UserRole.ADMIN;
    if (!isOwner && !isAdmin) {
      throw new Errors.MoleculerClientError(
        'Negalima atšaukti svetimos rezervacijos.',
        403,
        'FORBIDDEN',
      );
    }

    // Past reservations are immutable — both for users (would orphan their
    // own history) and admins (audit-log substitute).
    const [{ is_past: isPast }] = await db
      .raw<{ rows: any[] }>("SELECT (?::date < CURRENT_DATE) AS is_past", [reservation.date])
      .then((res: any) => res.rows);
    if (isPast) {
      throw new Errors.MoleculerClientError(
        'Negalima atšaukti praėjusios rezervacijos',
        400,
        'CANNOT_CANCEL_PAST',
      );
    }

    await db('reservations').where({ id: ctx.params.id }).delete();

    const action = isOwner ? 'CANCEL' : 'ADMIN_CANCEL_RESERVATION';
    await this.safeAuditLog(ctx, action, {
      reservationId: reservation.id,
      ownerId: reservation.user_id,
      roomId: reservation.room_id,
      deskNumber: reservation.desk_number,
      date: reservation.date,
    });

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
      this.logger.warn(`[reservations] audit.log failed: ${err?.message || err}`);
    }
  }
}
