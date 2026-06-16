'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import knex from 'knex';
import DatabaseMixin from '../mixins/database.mixin';
import knexConfig from '../knexfile';
import { EndpointType, UserRole } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';
import { isRoomManager } from '../utils/roomAccess';

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
// PG `DATE` columns come back as JS Date objects via pg driver. FE expects a
// plain `YYYY-MM-DD` string (passed straight into URL params, displayed via
// parseYmd). Coerce in one place rather than touching every consumer.
function ymd(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// knexfile uses knexSnakeCaseMappers — column names come back camelCased.
// `r.room_id AS user_id` round-trips as `userId`, `u.display_name AS user_display_name`
// becomes `userDisplayName`, etc.
function projectReservationWithUser(row: any) {
  return {
    id: row.id,
    roomId: row.roomId,
    deskNumber: row.deskNumber,
    date: ymd(row.date),
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
    date: ymd(row.date),
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
    date: ymd(row.date),
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
   * Admin: assign a reservation to ANY user (admin override). Unlike the
   * user-facing create, this does NOT require the target user to have room
   * access — an admin can place anyone in any room/desk. Physical constraints
   * still hold: the room/user must exist, the date can't be in the past, the
   * desk must be within the room's desk_count, and the DB uniques (one desk
   * per date, one reservation per user per date) translate to clean 409s.
   */
  @Action({
    rest: 'POST /assign',
    auth: true,
    // USER-gated; handler enforces admin OR manager-of-(target room).
    types: [EndpointType.USER],
    params: {
      userId: { type: 'uuid' },
      roomId: { type: 'uuid' },
      deskNumber: { type: 'number', integer: true, convert: true, min: 1 },
      date: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async adminAssign(
    ctx: Context<
      { userId: string; roomId: string; deskNumber: number; date: string },
      UserAuthMeta
    >,
  ) {
    // Only an admin or the target room's manager may assign reservations here.
    const isAdmin = ctx.meta?._systemTransition === true || ctx.meta?.user?.role === UserRole.ADMIN;
    if (!isAdmin) {
      const uid = ctx.meta?.user?.id;
      if (!uid || !(await isRoomManager(db, uid, ctx.params.roomId))) {
        throw new Errors.MoleculerClientError(
          'Rezervuoti šioje patalpoje gali tik administratorius arba jos vadovas.',
          403,
          'FORBIDDEN',
        );
      }
    }

    const userRows = await db('users')
      .where({ id: ctx.params.userId })
      .whereNull('deleted_at')
      .limit(1);
    if (userRows.length === 0) {
      throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'USER_NOT_FOUND');
    }
    const user = userRows[0];

    const roomRows = await db('rooms')
      .where({ id: ctx.params.roomId })
      .whereNull('deleted_at')
      .limit(1);
    if (roomRows.length === 0) {
      throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'ROOM_NOT_FOUND');
    }
    const room = roomRows[0];

    // Date not in the past (compared against PG CURRENT_DATE, same as the
    // user-facing create — avoids client/server timezone skew).
    const [{ is_past: isPast }] = await db
      .raw<{ rows: any[] }>('SELECT (?::date < CURRENT_DATE) AS is_past', [ctx.params.date])
      .then((res: any) => res.rows);
    if (isPast) {
      throw new Errors.MoleculerClientError(
        'Negalima rezervuoti praėjusiai datai',
        400,
        'DATE_IN_PAST',
      );
    }

    // Desk within range (knexSnakeCaseMappers → camelCase: room.deskCount).
    if (ctx.params.deskNumber > room.deskCount) {
      throw new Errors.MoleculerClientError('Tokios darbo vietos nėra', 400, 'INVALID_DESK_NUMBER');
    }

    try {
      const [created] = await db('reservations')
        .insert({
          user_id: ctx.params.userId,
          room_id: ctx.params.roomId,
          desk_number: ctx.params.deskNumber,
          date: ctx.params.date,
        })
        .returning('*');

      await this.safeAuditLog(ctx, 'ADMIN_ASSIGN_RESERVATION', {
        reservationId: created.id,
        targetUserId: ctx.params.userId,
        roomId: ctx.params.roomId,
        deskNumber: ctx.params.deskNumber,
        date: ctx.params.date,
      });

      // Shape mirrors projectAdminReservation so the FE can drop it straight
      // into the admin list.
      return {
        id: created.id,
        roomId: created.roomId,
        deskNumber: created.deskNumber,
        date: ymd(created.date),
        user: { id: user.id, displayName: user.displayName, email: user.email },
        room: { number: room.number, name: room.name, floor: room.floor },
        createdAt: created.createdAt,
      };
    } catch (err: any) {
      if (err?.code === '23505') {
        const c: string = err.constraint || '';
        if (c.includes('user_date')) {
          throw new Errors.MoleculerClientError(
            'Šis naudotojas jau turi rezervaciją tai dienai',
            409,
            'USER_HAS_RESERVATION',
          );
        }
        throw new Errors.MoleculerClientError(
          'Ši darbo vieta tą dieną jau rezervuota',
          409,
          'DESK_TAKEN',
        );
      }
      throw err;
    }
  }

  /**
   * Admin or room-manager: bulk-assign a user to a room on the given WEEKDAYS
   * (1=Mon … 5=Fri) for the next `weeks` weeks — for standing/recurring
   * schedules without clicking each calendar date. Honours a fixed deskNumber
   * if given, else auto-picks the lowest free desk each day. Skips days the user
   * already has a reservation, or where no desk is free. Returns a summary.
   */
  @Action({
    rest: 'POST /assign-recurring',
    auth: true,
    types: [EndpointType.USER],
    params: {
      userId: { type: 'uuid' },
      roomId: { type: 'uuid' },
      deskNumber: { type: 'number', integer: true, convert: true, min: 1, optional: true },
      weekdays: {
        type: 'array',
        items: { type: 'number', integer: true, convert: true, min: 1, max: 5 },
        min: 1,
        max: 5,
      },
      weeks: { type: 'number', integer: true, convert: true, min: 1, max: 12 },
    },
  })
  async assignRecurring(
    ctx: Context<
      { userId: string; roomId: string; deskNumber?: number; weekdays: number[]; weeks: number },
      UserAuthMeta
    >,
  ) {
    // Same gate as adminAssign: admin OR the target room's manager.
    const isAdmin = ctx.meta?._systemTransition === true || ctx.meta?.user?.role === UserRole.ADMIN;
    if (!isAdmin) {
      const uid = ctx.meta?.user?.id;
      if (!uid || !(await isRoomManager(db, uid, ctx.params.roomId))) {
        throw new Errors.MoleculerClientError(
          'Rezervuoti šioje patalpoje gali tik administratorius arba jos vadovas.',
          403,
          'FORBIDDEN',
        );
      }
    }

    const userRows = await db('users').where({ id: ctx.params.userId }).whereNull('deleted_at').limit(1);
    if (userRows.length === 0) {
      throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'USER_NOT_FOUND');
    }
    const roomRows = await db('rooms').where({ id: ctx.params.roomId }).whereNull('deleted_at').limit(1);
    if (roomRows.length === 0) {
      throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'ROOM_NOT_FOUND');
    }
    const room = roomRows[0];
    const cap: number = room.deskCount;
    if (ctx.params.deskNumber && ctx.params.deskNumber > cap) {
      throw new Errors.MoleculerClientError('Tokios darbo vietos nėra', 400, 'INVALID_DESK_NUMBER');
    }

    // Target dates: from server CURRENT_DATE (avoids TZ skew), the next
    // `weeks` weeks, keeping dates whose ISO weekday (Mon=1..Sun=7) is selected.
    const wanted = new Set(ctx.params.weekdays);
    const [{ today }] = await db
      .raw<{ rows: Array<{ today: string }> }>("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS today")
      .then((r: any) => r.rows);
    const base = new Date(`${today}T00:00:00Z`);
    const dates: string[] = [];
    for (let i = 0; i < ctx.params.weeks * 7; i += 1) {
      const d = new Date(base);
      d.setUTCDate(base.getUTCDate() + i);
      const dow = d.getUTCDay();
      const iso = dow === 0 ? 7 : dow;
      if (wanted.has(iso)) dates.push(d.toISOString().slice(0, 10));
    }

    // Preload: which of these dates the user already has, and desk occupancy.
    const mine = new Set(
      (await db('reservations').where({ user_id: ctx.params.userId }).whereIn('date', dates)
        .select(db.raw("to_char(date,'YYYY-MM-DD') as ds")) as any[]).map((r) => r.ds),
    );
    const occ = (await db('reservations').where({ room_id: ctx.params.roomId }).whereIn('date', dates)
      .select('desk_number', db.raw("to_char(date,'YYYY-MM-DD') as ds")) as any[]);
    const takenByDate = new Map<string, Set<number>>();
    for (const o of occ) {
      if (!takenByDate.has(o.ds)) takenByDate.set(o.ds, new Set());
      takenByDate.get(o.ds)!.add(Number(o.desk_number));
    }

    let created = 0;
    let skippedExisting = 0;
    let noDesk = 0;
    for (const date of dates) {
      if (mine.has(date)) {
        skippedExisting += 1;
        continue;
      }
      const taken = takenByDate.get(date) ?? new Set<number>();
      let desk = 0;
      if (ctx.params.deskNumber) {
        if (!taken.has(ctx.params.deskNumber)) desk = ctx.params.deskNumber;
      } else {
        for (let n = 1; n <= cap; n += 1) {
          if (!taken.has(n)) {
            desk = n;
            break;
          }
        }
      }
      if (!desk) {
        noDesk += 1;
        continue;
      }
      try {
        await db('reservations').insert({
          user_id: ctx.params.userId,
          room_id: ctx.params.roomId,
          desk_number: desk,
          date,
        });
        taken.add(desk);
        takenByDate.set(date, taken);
        mine.add(date);
        created += 1;
      } catch (err: any) {
        // 23505 = raced into a unique (room+desk+date or user+date) → skip.
        if (err?.code === '23505') skippedExisting += 1;
        else throw err;
      }
    }

    await this.safeAuditLog(ctx, 'ASSIGN_RECURRING', {
      targetUserId: ctx.params.userId,
      roomId: ctx.params.roomId,
      weekdays: ctx.params.weekdays,
      weeks: ctx.params.weeks,
      created,
      skippedExisting,
      noDesk,
    });
    return { created, skippedExisting, noDesk };
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
    // knexSnakeCaseMappers returns camelCase keys (room.deskCount / room.isShared);
    // reading snake_case here was a bug — it left shared rooms unrecognised, so a
    // shared room (309) wrongly demanded an assignment (403 NO_ROOM_ACCESS).
    if (ctx.params.deskNumber > room.deskCount) {
      throw new Errors.MoleculerClientError(
        'Tokios darbo vietos nėra',
        400,
        'INVALID_DESK_NUMBER',
      );
    }

    // 4. Access — shared room OR explicit assignment.
    if (!room.isShared) {
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
            'Ši darbo vieta tą dieną jau rezervuota',
            409,
            'DESK_TAKEN',
          );
        }
        throw new Errors.MoleculerClientError(
          'Ši darbo vieta tą dieną jau rezervuota',
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

    // knexSnakeCaseMappers: row columns come back camelCased.
    const isOwner = String(reservation.userId) === String(ctx.meta.user.id);
    const isAdmin = ctx.meta.user.role === UserRole.ADMIN;
    // A room manager may also cancel reservations in the room(s) they manage.
    const isManager =
      !isOwner && !isAdmin && (await isRoomManager(db, ctx.meta.user.id, reservation.roomId));
    if (!isOwner && !isAdmin && !isManager) {
      throw new Errors.MoleculerClientError(
        'Negalima atšaukti svetimos rezervacijos.',
        403,
        'FORBIDDEN',
      );
    }

    // Past reservations are immutable — both for users (would orphan their
    // own history) and admins (audit-log substitute).
    const pastCheck = await db.raw<{ rows: Array<{ is_past: boolean }> }>(
      "SELECT (?::date < CURRENT_DATE) AS is_past",
      [reservation.date],
    );
    if (pastCheck.rows[0]?.is_past) {
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
      ownerId: reservation.userId,
      roomId: reservation.roomId,
      deskNumber: reservation.deskNumber,
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
