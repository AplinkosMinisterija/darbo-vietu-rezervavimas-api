import { describe, it, expect } from 'vitest';
import knex from 'knex';
import { applyReservationFilters } from './reservationFilters';

// Builder-only instance: knex compiles SQL without ever opening a connection.
const db = knex({ client: 'pg' });
const base = () => db('reservations as r').leftJoin('rooms as room', 'room.id', 'r.room_id');

describe('applyReservationFilters', () => {
  it('adds no predicate when nothing is filtered', () => {
    expect(applyReservationFilters(base(), {}).toQuery()).not.toContain('where');
  });

  it('filters by the room floor', () => {
    expect(applyReservationFilters(base(), { floor: 3 }).toQuery()).toContain('"room"."floor" = 3');
  });

  it('keeps floor 0 — a falsy but valid floor', () => {
    expect(applyReservationFilters(base(), { floor: 0 }).toQuery()).toContain('"room"."floor" = 0');
  });

  it('keeps shared = false — a falsy but meaningful filter', () => {
    expect(applyReservationFilters(base(), { shared: false }).toQuery()).toContain(
      '"room"."is_shared" = false',
    );
  });

  it('filters by shared = true', () => {
    expect(applyReservationFilters(base(), { shared: true }).toQuery()).toContain(
      '"room"."is_shared" = true',
    );
  });

  it('combines date, user, room, floor and shared', () => {
    const sql = applyReservationFilters(base(), {
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      userId: '11111111-1111-1111-1111-111111111111',
      roomId: '22222222-2222-2222-2222-222222222222',
      floor: 2,
      shared: false,
    }).toQuery();
    expect(sql).toContain('"r"."date" >=');
    expect(sql).toContain('"r"."date" <=');
    expect(sql).toContain('"r"."user_id" =');
    expect(sql).toContain('"r"."room_id" =');
    expect(sql).toContain('"room"."floor" = 2');
    expect(sql).toContain('"room"."is_shared" = false');
  });
});
