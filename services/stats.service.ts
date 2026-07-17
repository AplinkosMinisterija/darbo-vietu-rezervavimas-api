'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { AuthUser, requireAdminHook } from '../utils/auth';

const db = knex(knexConfig);

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DayPoint {
  date: string; // 'YYYY-MM-DD'
  reserved: number;
}

/**
 * Expands a [from, to] date range into one entry per calendar day, taking
 * counts from `reservedByDate` and filling gaps with 0. Iterates in UTC so
 * local DST switches can never skip or double a day.
 */
export function buildDaySeries(
  from: string,
  to: string,
  reservedByDate: Map<string, number>,
): DayPoint[] {
  const days: DayPoint[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.push({ date, reserved: reservedByDate.get(date) ?? 0 });
  }
  return days;
}

export interface StatsKpi {
  totalReservations: number;
  /** Mean occupancy over Mon–Fri days only, percent 0–100, 1 decimal. */
  workdayAvgOccupancyPct: number;
  /** First day holding the range maximum; null when nothing is reserved. */
  peakDay: { date: string; reserved: number } | null;
}

export function computeKpis(days: DayPoint[], capacity: number): StatsKpi {
  let total = 0;
  let workdayReserved = 0;
  let workdayCount = 0;
  let peak: StatsKpi['peakDay'] = null;

  for (const d of days) {
    total += d.reserved;
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) {
      workdayReserved += d.reserved;
      workdayCount += 1;
    }
    if (d.reserved > 0 && (!peak || d.reserved > peak.reserved)) {
      peak = { date: d.date, reserved: d.reserved };
    }
  }

  const denominator = capacity * workdayCount;
  const pct = denominator > 0 ? Math.round((workdayReserved / denominator) * 1000) / 10 : 0;

  return { totalReservations: total, workdayAvgOccupancyPct: pct, peakDay: peak };
}

/** Inclusive day span cap for admin stats queries — ~5 years. */
const MAX_RANGE_DAYS = 1827;

/**
 * Validates an admin stats [from, to] range (shape is already gateway-checked
 * against DATE_PATTERN). Throws 400 INVALID_RANGE on from > to or a span
 * larger than MAX_RANGE_DAYS.
 */
export function assertValidRange(from: string, to: string): void {
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!(spanDays >= 1 && spanDays <= MAX_RANGE_DAYS)) {
    throw new Errors.MoleculerClientError('Neteisingas laikotarpis.', 400, 'INVALID_RANGE', {
      from,
      to,
      maxDays: MAX_RANGE_DAYS,
    });
  }
}

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

    const [capacityRows, perDay, floorTotals, floorReserved, topRooms, userAgg, rangeRows] =
      await Promise.all([
        db('rooms')
          .whereNull('deleted_at')
          .select(db.raw('COALESCE(SUM(desk_count), 0)::int AS capacity')),
        db('reservations as res')
          .join('rooms as r', 'r.id', 'res.room_id')
          .whereNull('r.deleted_at')
          .whereBetween('res.date', [from, to])
          .groupByRaw(`to_char(res.date, 'YYYY-MM-DD')`)
          .select(db.raw(`to_char(res.date, 'YYYY-MM-DD') AS ds, COUNT(res.id)::int AS reserved`)),
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
        Promise.all([
          db('reservations as res')
            .join('rooms as r', 'r.id', 'res.room_id')
            .whereNull('r.deleted_at')
            .whereBetween('res.date', [from, to])
            .select(db.raw('COUNT(DISTINCT res.user_id)::int AS reserving')),
          db('users')
            .whereNull('deleted_at')
            .select(db.raw('COUNT(*)::int AS active')),
        ]),
        db('reservations').select(
          db.raw(
            `to_char(MIN(date), 'YYYY-MM-DD') AS min_date, to_char(MAX(date), 'YYYY-MM-DD') AS max_date`,
          ),
        ),
      ]);

    const capacity = Number((capacityRows as any[])[0]?.capacity) || 0;
    const reservedByDate = new Map<string, number>(
      (perDay as any[]).map((r) => [String(r.ds), Number(r.reserved) || 0]),
    );
    const days = buildDaySeries(from, to, reservedByDate);

    const reservedFloorMap = new Map<string, number>(
      (floorReserved as any[]).map((r) => [String(r.floor), Number(r.reserved) || 0]),
    );
    const byFloor = (floorTotals as any[]).map((r) => ({
      floor: Number(r.floor),
      capacity: Number(r.capacity) || 0,
      reserved: reservedFloorMap.get(String(r.floor)) ?? 0,
    }));

    const [reservingRows, activeRows] = userAgg as [any[], any[]];
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
        reservingUsers: Number(reservingRows[0]?.reserving) || 0,
        activeUsers: Number(activeRows[0]?.active) || 0,
      },
    };
  }
}
