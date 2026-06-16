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
