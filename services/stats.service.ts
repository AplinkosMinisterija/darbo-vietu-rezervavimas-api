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
    // LEFT JOIN reservations on (room_id + date) so floors with zero
    // bookings still appear with reserved=0. COUNT(res.id) ignores NULL
    // joins automatically.
    const rows = await db('rooms as r')
      .leftJoin('reservations as res', function () {
        this.on('res.room_id', '=', 'r.id').andOn('res.date', '=', db.raw('?', [ctx.params.date]));
      })
      .whereNull('r.deleted_at')
      .groupBy('r.floor')
      .orderBy('r.floor', 'asc')
      .select(
        'r.floor',
        db.raw('SUM(r.desk_count)::int AS total'),
        db.raw('COUNT(res.id)::int AS reserved'),
      );

    const result: Record<string, { total: number; reserved: number }> = {};
    for (const row of rows as any[]) {
      result[String(row.floor)] = {
        total: Number(row.total) || 0,
        reserved: Number(row.reserved) || 0,
      };
    }
    return result;
  }
}
