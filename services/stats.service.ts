'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { AuthUser, requireAdminHook } from '../utils/auth';
import {
  DayPoint,
  assertValidRange,
  buildDaySeries,
  buildStatsWorkbook,
  computeKpis,
} from '../utils/stats';

const db = knex(knexConfig);

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
  // moleculer-web reads these to stream a binary response instead of JSON.
  $responseType?: string;
  $responseHeaders?: Record<string, string>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Floor-level aggregation for the "Apžvalga" dashboard tab. Single SQL
 * round-trip:
 *
 *   - `total`     — Σ rooms.desk_count grouped by floor (active rooms only)
 *   - `reserved`  — COUNT reservations on the given date, joined per-room
 *
 * Read-only; not a DbService — no shape to mirror beyond the response.
 */
@Service({
  name: 'stats',
})
export default class StatsService extends moleculer.Service {
  /**
   * Returns `{ '1': { total, reserved }, '2': { ... }, ... }` for every
   * floor that has at least one non-deleted room. The FE expects string
   * keys (object spread over floor numbers); we serialise as JSON object
   * with string-coerced keys.
   */
  @Action({
    rest: 'GET /',
    auth: true,
    // Apžvalga (per-floor occupancy) is available to every authenticated
    // user — it shows only aggregate desk counts, no per-person PII.
    types: [EndpointType.USER],
    params: {
      date: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async byFloor(ctx: Context<{ date: string }, UserAuthMeta>) {
    // Two SEPARATE aggregations. Joining reservations into the desk-count SUM
    // fans the room row out once per reservation, so SUM(desk_count) would be
    // multiplied by the bookings-per-room — the "458 vietų" inflation bug.
    const totals = await db('rooms')
      .whereNull('deleted_at')
      .groupBy('floor')
      .orderBy('floor', 'asc')
      .select('floor', db.raw('SUM(desk_count)::int AS total'));

    const reservedRows = await db('reservations as res')
      .join('rooms as r', 'r.id', 'res.room_id')
      .whereNull('r.deleted_at')
      .where('res.date', ctx.params.date)
      .groupBy('r.floor')
      .select('r.floor', db.raw('COUNT(res.id)::int AS reserved'));

    const reservedByFloor = new Map<string, number>(
      (reservedRows as any[]).map((r) => [String(r.floor), Number(r.reserved) || 0]),
    );

    const result: Record<string, { total: number; reserved: number }> = {};
    for (const row of totals as any[]) {
      const f = String(row.floor);
      result[f] = { total: Number(row.total) || 0, reserved: reservedByFloor.get(f) ?? 0 };
    }
    return result;
  }

  /**
   * Admin dashboard aggregate for an arbitrary [from, to] date range. One
   * response powers the whole "Statistika" page; week/month bucketing is done
   * client-side from `days`, so granularity switches need no refetch.
   *
   * Known limitation (by design): capacity reflects the CURRENT room
   * configuration — historical desk_count changes aren't stored, so occupancy
   * percentages for past periods are computed against today's capacity.
   */
  @Action({
    rest: 'GET /admin',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      from: { type: 'string', pattern: DATE_PATTERN },
      to: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async adminOverview(ctx: Context<{ from: string; to: string }, UserAuthMeta>) {
    // Defense in depth: the gateway ADMIN gate doesn't fire on internal
    // ctx.call invocations — the hook does (mirrors export.service.ts).
    requireAdminHook(ctx);
    const { from, to } = ctx.params;
    assertValidRange(from, to);

    const [capacity, days, floorTotals, floorReserved, topRooms, users, rangeRows] =
      await Promise.all([
        this.queryCapacity(),
        this.queryDaySeries(from, to),
        db('rooms')
          .whereNull('deleted_at')
          .groupBy('floor')
          .orderBy('floor', 'asc')
          .select('floor', db.raw('SUM(desk_count)::int AS capacity')),
        // Separate aggregation from the capacity SUM — joining reservations
        // into it would fan rooms out per booking (the "458 vietų" bug).
        db('reservations as res')
          .join('rooms as r', 'r.id', 'res.room_id')
          .whereNull('r.deleted_at')
          .whereBetween('res.date', [from, to])
          .groupBy('r.floor')
          .select('r.floor', db.raw('COUNT(res.id)::int AS reserved')),
        db('reservations as res')
          .join('rooms as r', 'r.id', 'res.room_id')
          .whereNull('r.deleted_at')
          .whereBetween('res.date', [from, to])
          .groupBy('r.id', 'r.number', 'r.name', 'r.desk_count')
          .select(
            'r.id as roomId',
            'r.number',
            'r.name',
            db.raw('r.desk_count::int AS "deskCount"'),
            db.raw('COUNT(res.id)::int AS reserved'),
          )
          .orderBy([
            { column: 'reserved', order: 'desc' },
            { column: 'r.number', order: 'asc' },
          ])
          .limit(10),
        this.queryUserCounts(from, to),
        db('reservations').select(
          db.raw(
            `to_char(MIN(date), 'YYYY-MM-DD') AS min_date, to_char(MAX(date), 'YYYY-MM-DD') AS max_date`,
          ),
        ),
      ]);

    const reservedFloorMap = new Map<string, number>(
      (floorReserved as any[]).map((r) => [String(r.floor), Number(r.reserved) || 0]),
    );
    const byFloor = (floorTotals as any[]).map((r) => ({
      floor: Number(r.floor),
      capacity: Number(r.capacity) || 0,
      reserved: reservedFloorMap.get(String(r.floor)) ?? 0,
    }));

    const range = (rangeRows as any[])[0] ?? {};

    return {
      capacity,
      range: { minDate: range.minDate ?? null, maxDate: range.maxDate ?? null },
      days,
      byFloor,
      topRooms: (topRooms as any[]).map((r) => ({
        roomId: String(r.roomId),
        number: String(r.number),
        name: String(r.name ?? ''),
        deskCount: Number(r.deskCount) || 0,
        reserved: Number(r.reserved) || 0,
      })),
      kpi: {
        ...computeKpis(days, capacity),
        reservingUsers: users.reservingUsers,
        activeUsers: users.activeUsers,
      },
    };
  }

  /**
   * Occupancy Excel export for the same [from, to] range as `adminOverview`.
   * Returns the workbook as an attachment download (Buffer +
   * `$responseHeaders`, mirroring export.service.ts).
   */
  @Action({
    rest: 'GET /admin/xlsx',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      from: { type: 'string', pattern: DATE_PATTERN },
      to: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async adminXlsx(ctx: Context<{ from: string; to: string }, UserAuthMeta>) {
    requireAdminHook(ctx);
    const { from, to } = ctx.params;
    assertValidRange(from, to);

    const [capacity, days, users, roomRows, roomReserved, detail] = await Promise.all([
      this.queryCapacity(),
      this.queryDaySeries(from, to),
      this.queryUserCounts(from, to),
      db('rooms')
        .whereNull('deleted_at')
        .orderBy([
          { column: 'floor', order: 'asc' },
          { column: 'number', order: 'asc' },
        ])
        .select('id', 'number', 'name', 'floor', db.raw('desk_count::int AS "deskCount"')),
      db('reservations as res')
        .join('rooms as r', 'r.id', 'res.room_id')
        .whereNull('r.deleted_at')
        .whereBetween('res.date', [from, to])
        .groupBy('res.room_id')
        .select('res.roomId', db.raw('COUNT(res.id)::int AS reserved')),
      db('reservations as res')
        .join('rooms as r', 'r.id', 'res.room_id')
        .join('users as u', 'u.id', 'res.user_id')
        .whereNull('r.deleted_at')
        .whereBetween('res.date', [from, to])
        .orderBy([
          { column: 'res.date', order: 'asc' },
          { column: 'u.displayName', order: 'asc' },
        ])
        .select(
          db.raw(`to_char(res.date, 'YYYY-MM-DD') AS date`),
          'u.displayName as displayName',
          'u.email as email',
          'r.number as roomNumber',
          'r.name as roomName',
          'res.deskNumber as deskNumber',
        ),
    ]);

    const reservedByRoom = new Map<string, number>(
      (roomReserved as any[]).map((r) => [String(r.roomId), Number(r.reserved) || 0]),
    );
    const rooms = (roomRows as any[]).map((r) => ({
      number: String(r.number),
      name: String(r.name ?? ''),
      floor: Number(r.floor),
      deskCount: Number(r.deskCount) || 0,
      reserved: reservedByRoom.get(String(r.id)) ?? 0,
    }));

    const workbook = buildStatsWorkbook({
      from,
      to,
      capacity,
      days,
      rooms,
      kpi: {
        ...computeKpis(days, capacity),
        reservingUsers: users.reservingUsers,
        activeUsers: users.activeUsers,
      },
      detail: (detail as any[]).map((r) => ({
        date: String(r.date),
        displayName: String(r.displayName ?? ''),
        email: String(r.email ?? ''),
        roomNumber: String(r.roomNumber),
        roomName: String(r.roomName ?? ''),
        deskNumber: Number(r.deskNumber) || 0,
      })),
    });
    const buffer = await workbook.xlsx.writeBuffer();

    ctx.meta.$responseHeaders = {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="uzimtumo-ataskaita-${from}--${to}.xlsx"`,
    };

    return buffer;
  }

  /** Σ desk_count over active rooms — today's single-day capacity. */
  @Method
  async queryCapacity(): Promise<number> {
    const rows = await db('rooms')
      .whereNull('deleted_at')
      .select(db.raw('COALESCE(SUM(desk_count), 0)::int AS capacity'));
    return Number((rows as any[])[0]?.capacity) || 0;
  }

  /** Per-day reserved counts (active rooms only), gaps filled with 0. */
  @Method
  async queryDaySeries(from: string, to: string): Promise<DayPoint[]> {
    const rows = await db('reservations as res')
      .join('rooms as r', 'r.id', 'res.room_id')
      .whereNull('r.deleted_at')
      .whereBetween('res.date', [from, to])
      .groupByRaw(`to_char(res.date, 'YYYY-MM-DD')`)
      .select(db.raw(`to_char(res.date, 'YYYY-MM-DD') AS ds, COUNT(res.id)::int AS reserved`));
    const reservedByDate = new Map<string, number>(
      (rows as any[]).map((r) => [String(r.ds), Number(r.reserved) || 0]),
    );
    return buildDaySeries(from, to, reservedByDate);
  }

  /** Distinct users reserving in range vs all active users. */
  @Method
  async queryUserCounts(
    from: string,
    to: string,
  ): Promise<{ reservingUsers: number; activeUsers: number }> {
    const [reservingRows, activeRows] = await Promise.all([
      db('reservations as res')
        .join('rooms as r', 'r.id', 'res.room_id')
        .whereNull('r.deleted_at')
        .whereBetween('res.date', [from, to])
        .select(db.raw('COUNT(DISTINCT res.user_id)::int AS reserving')),
      db('users').whereNull('deleted_at').select(db.raw('COUNT(*)::int AS active')),
    ]);
    return {
      reservingUsers: Number((reservingRows as any[])[0]?.reserving) || 0,
      activeUsers: Number((activeRows as any[])[0]?.active) || 0,
    };
  }
}
