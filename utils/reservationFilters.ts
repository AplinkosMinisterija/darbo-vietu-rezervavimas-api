'use strict';

import type { Knex } from 'knex';

export interface ReservationFilterParams {
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  roomId?: string;
  floor?: number;
  shared?: boolean;
}

/**
 * Admin rezervacijų sąrašo filtrai. Užklausa jau turi `leftJoin('rooms as room')`
 * — `floor`/`shared` remiasi tuo alias'u. `undefined` tikrinam eksplicitiškai:
 * `floor: 0` ir `shared: false` yra validūs filtrai, o ne „nefiltruojam".
 */
export function applyReservationFilters(
  query: Knex.QueryBuilder,
  params: ReservationFilterParams,
): Knex.QueryBuilder {
  if (params.dateFrom) query.andWhere('r.date', '>=', params.dateFrom);
  if (params.dateTo) query.andWhere('r.date', '<=', params.dateTo);
  if (params.userId) query.andWhere('r.user_id', params.userId);
  if (params.roomId) query.andWhere('r.room_id', params.roomId);
  if (params.floor !== undefined) query.andWhere('room.floor', params.floor);
  if (params.shared !== undefined) query.andWhere('room.is_shared', params.shared);
  return query;
}
