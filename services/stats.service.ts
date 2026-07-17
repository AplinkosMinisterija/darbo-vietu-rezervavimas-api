'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { AuthUser } from '../utils/auth';

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
}
