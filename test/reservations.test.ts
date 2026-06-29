'use strict';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { ServiceBroker } from 'moleculer';
import type { Knex } from 'knex';
import { randomUUID } from 'crypto';
import {
  startTestBroker,
  stopTestBroker,
  makeDb,
  resetTables,
  seedUser,
  seedRoom,
  assignRoom,
  callAs,
  type SeededUser,
  type SeededRoom,
} from './helpers/broker';
import { UserRole } from '../types/constants';
import { computeRecurringDates } from '../services/reservations.service';

// Characterization integration tests for the `reservations` service. These pin
// the CURRENT behaviour (bugs included) so the upcoming HR port has a safety
// net. Where a genuine bug is asserted it is marked `KNOWN BUG` with a note to
// fix on port. Actions are called directly through the broker with a forced
// `ctx.meta.user` (same shape the gateway injects), so gateway-level
// EndpointType gating is NOT exercised — only in-handler authz is.

let broker: ServiceBroker;
let db: Knex;

beforeAll(async () => {
  db = makeDb();
  broker = await startTestBroker();
});

afterAll(async () => {
  await stopTestBroker(broker);
  await db.destroy();
});

beforeEach(async () => {
  await resetTables(db);
});

const FUTURE = '2030-01-15';
const FUTURE_2 = '2030-01-16';
const PAST = '2020-01-01';

// --- local helpers (harness has no seeders for these tables) ---

async function seedRoomManager(
  userId: string,
  roomId: string,
  source: 'manual' | 'auto' = 'manual',
): Promise<void> {
  // knexSnakeCaseMappers translates camelCase → snake_case columns.
  await db('room_managers').insert({ userId, roomId, source });
}

async function seedReservation(opts: {
  userId: string;
  roomId: string;
  deskNumber: number;
  date: string;
}): Promise<string> {
  const [row] = await db('reservations')
    .insert({
      userId: opts.userId,
      roomId: opts.roomId,
      deskNumber: opts.deskNumber,
      date: opts.date,
    })
    .returning('id');
  return row.id;
}

async function currentDate(): Promise<string> {
  const res: any = await db.raw("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS today");
  return res.rows[0].today;
}

// KNOWN BUG (TZ off-by-one): the service projects DB `date` columns through
// `ymd()`. node-postgres parses a `DATE` into a LOCAL-midnight JS Date, but
// `ymd()` reads getUTC* components — so in any timezone EAST of UTC the
// rendered string is shifted back one day (stored 2030-01-15 → "2030-01-14"
// here in Europe/Vilnius). This helper replicates that exact transform so the
// characterization assertions are stable across runner timezones. On the HR
// port this must be fixed (project the date as the stored YYYY-MM-DD) and these
// expectations will then equal the input string verbatim.
function projectedDate(stored: string): string {
  const [y, m, d] = stored.split('-').map(Number);
  const local = new Date(y, m - 1, d); // mirrors pg-types DATE parser (local midnight)
  const yy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ============================================================================
// createReservation
// ============================================================================
describe('reservations.createReservation', () => {
  it('happy path: USER reserves a desk in a shared room (DB row created)', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });

    await callAs(broker, u, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 2,
      date: FUTURE,
    });

    const rows = await db('reservations');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomId: room.id, deskNumber: 2, userId: u.id });
  });

  it('happy path: assigned non-shared room works', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 2 });
    await assignRoom(db, u.id, room.id);

    await callAs(broker, u, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });

    const rows = await db('reservations');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomId: room.id, deskNumber: 1, userId: u.id });
  });

  it('KNOWN BUG: return payload drops roomId/deskNumber/userId/createdAt (snake_case read on camelCase row) — fix on HR port', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });

    const res: any = await callAs(broker, u, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });

    // Handler reads created.room_id / desk_number / user_id / created_at, but
    // knexSnakeCaseMappers returns camelCase keys → these come back undefined.
    expect(res.id).toBeTruthy();
    expect(res.roomId).toBeUndefined();
    expect(res.deskNumber).toBeUndefined();
    expect(res.userId).toBeUndefined();
    expect(res.createdAt).toBeUndefined();
  });

  it('ROOM_NOT_FOUND (404) for unknown room', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    await expect(
      callAs(broker, u, 'reservations.createReservation', {
        roomId: randomUUID(),
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'ROOM_NOT_FOUND' });
  });

  it('DATE_IN_PAST (400) for a past date', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    await expect(
      callAs(broker, u, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 1,
        date: PAST,
      }),
    ).rejects.toMatchObject({ code: 400, type: 'DATE_IN_PAST' });
  });

  it('INVALID_DESK_NUMBER (400) when deskNumber exceeds room desk_count', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 2 });
    await expect(
      callAs(broker, u, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 3,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 400, type: 'INVALID_DESK_NUMBER' });
  });

  it('NO_ROOM_ACCESS (403) for non-shared room without assignment', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 2 });
    await expect(
      callAs(broker, u, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 403, type: 'NO_ROOM_ACCESS' });
  });

  it('DESK_TAKEN (409) when two users grab the same desk on the same date', async () => {
    const u1 = await seedUser(db, { email: 'a@am.lt' });
    const u2 = await seedUser(db, { email: 'b@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });

    await callAs(broker, u1, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });
    await expect(
      callAs(broker, u2, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 409, type: 'DESK_TAKEN' });
  });

  it('USER_HAS_RESERVATION (409) when same user reserves twice on the same date', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });

    await callAs(broker, u, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });
    await expect(
      callAs(broker, u, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 2,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 409, type: 'USER_HAS_RESERVATION' });
  });

  it('NOT_AUTHENTICATED (401) when no user in meta', async () => {
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    await expect(
      callAs(broker, null, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 401, type: 'NOT_AUTHENTICATED' });
  });
});

// ============================================================================
// cancelReservation
// ============================================================================
describe('reservations.cancelReservation', () => {
  it('owner can cancel their own upcoming reservation', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    const id = await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    const res: any = await callAs(broker, u, 'reservations.cancelReservation', { id });
    expect(res).toEqual({ ok: true });
    expect(await db('reservations').where({ id })).toHaveLength(0);
  });

  it('ADMIN can cancel any user reservation', async () => {
    const owner = await seedUser(db, { email: 'owner@am.lt' });
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    const id = await seedReservation({ userId: owner.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    await callAs(broker, admin, 'reservations.cancelReservation', { id });
    expect(await db('reservations').where({ id })).toHaveLength(0);
  });

  it('room manager can cancel a reservation in a room they manage', async () => {
    const owner = await seedUser(db, { email: 'owner@am.lt' });
    const manager = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    await seedRoomManager(manager.id, room.id);
    const id = await seedReservation({ userId: owner.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    await callAs(broker, manager, 'reservations.cancelReservation', { id });
    expect(await db('reservations').where({ id })).toHaveLength(0);
  });

  it("FORBIDDEN (403) when a stranger tries to cancel someone else's reservation", async () => {
    const owner = await seedUser(db, { email: 'owner@am.lt' });
    const stranger = await seedUser(db, { email: 'x@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    const id = await seedReservation({ userId: owner.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    await expect(
      callAs(broker, stranger, 'reservations.cancelReservation', { id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
    expect(await db('reservations').where({ id })).toHaveLength(1);
  });

  it('NOT_FOUND (404) for an unknown reservation id', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    await expect(
      callAs(broker, u, 'reservations.cancelReservation', { id: randomUUID() }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });

  it('CANNOT_CANCEL_PAST (400) for a past reservation (even the owner)', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });
    const id = await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 1, date: PAST });

    await expect(
      callAs(broker, u, 'reservations.cancelReservation', { id }),
    ).rejects.toMatchObject({ code: 400, type: 'CANNOT_CANCEL_PAST' });
    expect(await db('reservations').where({ id })).toHaveLength(1);
  });

  it('NOT_AUTHENTICATED (401) when no user in meta', async () => {
    await expect(
      callAs(broker, null, 'reservations.cancelReservation', { id: randomUUID() }),
    ).rejects.toMatchObject({ code: 401, type: 'NOT_AUTHENTICATED' });
  });
});

// ============================================================================
// mine
// ============================================================================
describe('reservations.mine', () => {
  it('returns only the caller upcoming reservations (excludes past & other users)', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const other = await seedUser(db, { email: 'b@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });

    await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 1, date: FUTURE });
    await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 2, date: PAST }); // past → hidden
    await seedReservation({ userId: other.id, roomId: room.id, deskNumber: 3, date: FUTURE }); // other → hidden

    const res: any[] = await callAs(broker, u, 'reservations.mine', {});
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      roomId: room.id,
      deskNumber: 1,
      date: projectedDate(FUTURE), // KNOWN BUG: ymd() TZ off-by-one (see helper)
      room: { number: room.number, name: room.name, floor: room.floor },
    });
    // mine projection is correct (camelCase reads) — roomId/deskNumber present.
    expect(res[0].roomId).toBeTruthy();
    expect(res[0].deskNumber).toBe(1);
    expect(typeof res[0].date).toBe('string');
  });

  it('returns upcoming sorted by date ascending', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 2, date: FUTURE_2 });
    await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    const res: any[] = await callAs(broker, u, 'reservations.mine', {});
    // Sorted by the actual stored date asc; rendered strings carry the ymd()
    // TZ off-by-one (KNOWN BUG) but ordering is unaffected.
    expect(res.map((r) => r.date)).toEqual([projectedDate(FUTURE), projectedDate(FUTURE_2)]);
  });

  it('NOT_AUTHENTICATED (401) when no user in meta', async () => {
    await expect(callAs(broker, null, 'reservations.mine', {})).rejects.toMatchObject({
      code: 401,
      type: 'NOT_AUTHENTICATED',
    });
  });
});

// ============================================================================
// byDate
// ============================================================================
describe('reservations.byDate', () => {
  it('returns the day grid and does NOT leak user.email (PII) — only displayName', async () => {
    const u1 = await seedUser(db, { email: 'a@am.lt', displayName: 'Alice' });
    const u2 = await seedUser(db, { email: 'b@am.lt', displayName: 'Bob' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await seedReservation({ userId: u2.id, roomId: room.id, deskNumber: 2, date: FUTURE });
    await seedReservation({ userId: u1.id, roomId: room.id, deskNumber: 1, date: FUTURE });
    await seedReservation({ userId: u1.id, roomId: room.id, deskNumber: 3, date: FUTURE_2 }); // other day

    const res: any[] = await callAs(broker, u1, 'reservations.byDate', { date: FUTURE });
    expect(res).toHaveLength(2);
    // Ordered by room_id then desk_number.
    expect(res.map((r) => r.deskNumber)).toEqual([1, 2]);
    for (const item of res) {
      expect(item.user).toHaveProperty('displayName');
      expect(item.user).not.toHaveProperty('email');
      expect(item).not.toHaveProperty('user.email');
      expect(typeof item.date).toBe('string');
    }
    expect(res[0].user.displayName).toBe('Alice');
  });

  it('returns empty array for a date with no reservations', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const res: any[] = await callAs(broker, u, 'reservations.byDate', { date: FUTURE });
    expect(res).toEqual([]);
  });

  it('KNOWN BUG: rendered date is off-by-one vs the stored/queried date in TZ east of UTC — fix on HR port', async () => {
    // Reproduces the ymd() timezone defect end-to-end: we store & query by
    // FUTURE, but the projected `date` string does NOT equal FUTURE whenever the
    // runner TZ is east of UTC (it is here — Europe/Vilnius). On the HR port the
    // projection must round-trip the stored YYYY-MM-DD and this expectation flips
    // to `toBe(FUTURE)`.
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    const res: any[] = await callAs(broker, u, 'reservations.byDate', { date: FUTURE });
    expect(res).toHaveLength(1);
    const offset = new Date(`${FUTURE}T00:00:00`).getTimezoneOffset(); // <0 east of UTC
    if (offset < 0) {
      expect(res[0].date).not.toBe(FUTURE);
    }
    expect(res[0].date).toBe(projectedDate(FUTURE));
  });
});

// ============================================================================
// listAll (admin browse)
// ============================================================================
describe('reservations.listAll', () => {
  it('FORBIDDEN (403) for a non-admin caller', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    await expect(callAs(broker, u, 'reservations.listAll', {})).rejects.toMatchObject({
      code: 403,
      type: 'FORBIDDEN',
    });
  });

  it('ADMIN gets {items, total} including user.email (admin surface)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'a@am.lt', displayName: 'Alice' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await seedReservation({ userId: u.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    const res: any = await callAs(broker, admin, 'reservations.listAll', {});
    expect(res.total).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      roomId: room.id,
      deskNumber: 1,
      date: projectedDate(FUTURE), // KNOWN BUG: ymd() TZ off-by-one (see helper)
      user: { id: u.id, displayName: 'Alice', email: 'a@am.lt' },
      room: { number: room.number, name: room.name, floor: room.floor },
    });
  });

  it('filters by roomId, userId and date range', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u1 = await seedUser(db, { email: 'a@am.lt' });
    const u2 = await seedUser(db, { email: 'b@am.lt' });
    const r1 = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    const r2 = await seedRoom(db, { number: 'S2', isShared: true, deskCount: 5 });
    await seedReservation({ userId: u1.id, roomId: r1.id, deskNumber: 1, date: FUTURE });
    await seedReservation({ userId: u2.id, roomId: r2.id, deskNumber: 1, date: FUTURE });
    await seedReservation({ userId: u1.id, roomId: r1.id, deskNumber: 2, date: FUTURE_2 });

    const byRoom: any = await callAs(broker, admin, 'reservations.listAll', { roomId: r2.id });
    expect(byRoom.total).toBe(1);
    expect(byRoom.items[0].roomId).toBe(r2.id);

    const byUser: any = await callAs(broker, admin, 'reservations.listAll', { userId: u1.id });
    expect(byUser.total).toBe(2);

    const byDateRange: any = await callAs(broker, admin, 'reservations.listAll', {
      dateFrom: FUTURE,
      dateTo: FUTURE,
    });
    expect(byDateRange.total).toBe(2);
    // SQL filter uses the real stored date (matches); rendered date carries the
    // ymd() TZ off-by-one (KNOWN BUG).
    expect(byDateRange.items.every((i: any) => i.date === projectedDate(FUTURE))).toBe(true);
  });
});

// ============================================================================
// adminAssign (POST /assign)
// ============================================================================
describe('reservations.adminAssign', () => {
  it('ADMIN can assign ANY user to a non-shared room WITHOUT an assignment', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt', displayName: 'Tina' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });

    const res: any = await callAs(broker, admin, 'reservations.adminAssign', {
      userId: target.id,
      roomId: room.id,
      deskNumber: 2,
      date: FUTURE,
    });

    // adminAssign return reads camelCase keys → shape is correct (contrast with
    // createReservation's KNOWN BUG).
    expect(res.roomId).toBe(room.id);
    expect(res.deskNumber).toBe(2);
    expect(res.date).toBe(projectedDate(FUTURE)); // KNOWN BUG: ymd() TZ off-by-one (see helper)
    expect(res.user).toMatchObject({ id: target.id, displayName: 'Tina', email: 't@am.lt' });
    expect(await db('reservations')).toHaveLength(1);
  });

  it("room manager of the target room can assign for any user", async () => {
    const manager = await seedUser(db, { email: 'mgr@am.lt' });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });
    await seedRoomManager(manager.id, room.id);

    await callAs(broker, manager, 'reservations.adminAssign', {
      userId: target.id,
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });
    expect(await db('reservations')).toHaveLength(1);
  });

  it('FORBIDDEN (403) for a plain user (not admin, not manager of the room)', async () => {
    const plain = await seedUser(db, { email: 'p@am.lt' });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });

    await expect(
      callAs(broker, plain, 'reservations.adminAssign', {
        userId: target.id,
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('USER_NOT_FOUND (404) for an unknown target user', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });
    await expect(
      callAs(broker, admin, 'reservations.adminAssign', {
        userId: randomUUID(),
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('ROOM_NOT_FOUND (404) for an unknown room', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    await expect(
      callAs(broker, admin, 'reservations.adminAssign', {
        userId: target.id,
        roomId: randomUUID(),
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'ROOM_NOT_FOUND' });
  });

  it('DATE_IN_PAST (400) for a past date', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });
    await expect(
      callAs(broker, admin, 'reservations.adminAssign', {
        userId: target.id,
        roomId: room.id,
        deskNumber: 1,
        date: PAST,
      }),
    ).rejects.toMatchObject({ code: 400, type: 'DATE_IN_PAST' });
  });

  it('INVALID_DESK_NUMBER (400) when deskNumber exceeds room desk_count', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 2 });
    await expect(
      callAs(broker, admin, 'reservations.adminAssign', {
        userId: target.id,
        roomId: room.id,
        deskNumber: 3,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 400, type: 'INVALID_DESK_NUMBER' });
  });

  it('DESK_TAKEN (409) when the desk is already booked that day', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const a = await seedUser(db, { email: 'a@am.lt' });
    const b = await seedUser(db, { email: 'b@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });
    await seedReservation({ userId: a.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    await expect(
      callAs(broker, admin, 'reservations.adminAssign', {
        userId: b.id,
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 409, type: 'DESK_TAKEN' });
  });

  it('USER_HAS_RESERVATION (409) when the target already has a reservation that day', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 3 });
    await seedReservation({ userId: target.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    await expect(
      callAs(broker, admin, 'reservations.adminAssign', {
        userId: target.id,
        roomId: room.id,
        deskNumber: 2,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 409, type: 'USER_HAS_RESERVATION' });
  });
});

// ============================================================================
// assignRecurring (best-effort, no transaction)
// ============================================================================
describe('reservations.assignRecurring', () => {
  it('ADMIN bulk-assigns: created === number of target dates on an empty room', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 10 });

    const today = await currentDate();
    const weekdays = [1, 2, 3, 4, 5];
    const weeks = 2;
    const expected = computeRecurringDates(today, weekdays, weeks);

    const res: any = await callAs(broker, admin, 'reservations.assignRecurring', {
      userId: target.id,
      roomId: room.id,
      weekdays,
      weeks,
    });

    expect(res.created).toBe(expected.length);
    expect(res.skippedExisting).toBe(0);
    expect(res.noDesk).toBe(0);
    expect(await db('reservations').where({ userId: target.id })).toHaveLength(expected.length);
  });

  it('skips dates where the target already holds a reservation', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 10 });
    const other = await seedRoom(db, { number: 'S2', isShared: true, deskCount: 10 });

    const today = await currentDate();
    const weekdays = [1, 2, 3, 4, 5];
    const weeks = 2;
    const expected = computeRecurringDates(today, weekdays, weeks);
    // Pre-book the target on the first target date (in a different room).
    await seedReservation({ userId: target.id, roomId: other.id, deskNumber: 1, date: expected[0] });

    const res: any = await callAs(broker, admin, 'reservations.assignRecurring', {
      userId: target.id,
      roomId: room.id,
      weekdays,
      weeks,
    });

    expect(res.skippedExisting).toBe(1);
    expect(res.created).toBe(expected.length - 1);
  });

  it('counts noDesk for dates with no free desk (fixed deskNumber already taken)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const occupier = await seedUser(db, { email: 'o@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 3 });

    const today = await currentDate();
    const weekdays = [1, 2, 3, 4, 5];
    const weeks = 2;
    const expected = computeRecurringDates(today, weekdays, weeks);
    // Occupy desk 2 on the first target date; request a FIXED desk 2.
    await seedReservation({ userId: occupier.id, roomId: room.id, deskNumber: 2, date: expected[0] });

    const res: any = await callAs(broker, admin, 'reservations.assignRecurring', {
      userId: target.id,
      roomId: room.id,
      deskNumber: 2,
      weekdays,
      weeks,
    });

    expect(res.noDesk).toBe(1);
    expect(res.created).toBe(expected.length - 1);
  });

  it('FORBIDDEN (403) for a plain user', async () => {
    const plain = await seedUser(db, { email: 'p@am.lt' });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await expect(
      callAs(broker, plain, 'reservations.assignRecurring', {
        userId: target.id,
        roomId: room.id,
        weekdays: [1, 2, 3, 4, 5],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('room manager of the room can assign-recurring', async () => {
    const manager = await seedUser(db, { email: 'mgr@am.lt' });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await seedRoomManager(manager.id, room.id);

    const res: any = await callAs(broker, manager, 'reservations.assignRecurring', {
      userId: target.id,
      roomId: room.id,
      weekdays: [1, 2, 3, 4, 5],
      weeks: 1,
    });
    expect(res.created).toBeGreaterThanOrEqual(0);
  });

  it('INVALID_DESK_NUMBER (400) when fixed deskNumber exceeds capacity', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const target = await seedUser(db, { email: 't@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 2 });
    await expect(
      callAs(broker, admin, 'reservations.assignRecurring', {
        userId: target.id,
        roomId: room.id,
        deskNumber: 5,
        weekdays: [1, 2, 3, 4, 5],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 400, type: 'INVALID_DESK_NUMBER' });
  });

  it('USER_NOT_FOUND (404) / ROOM_NOT_FOUND (404)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    const target = await seedUser(db, { email: 't@am.lt' });

    await expect(
      callAs(broker, admin, 'reservations.assignRecurring', {
        userId: randomUUID(),
        roomId: room.id,
        weekdays: [1],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });

    await expect(
      callAs(broker, admin, 'reservations.assignRecurring', {
        userId: target.id,
        roomId: randomUUID(),
        weekdays: [1],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'ROOM_NOT_FOUND' });
  });
});

// ============================================================================
// reserveRecurring (self, all-or-nothing, transactional)
// ============================================================================
describe('reservations.reserveRecurring', () => {
  it('self happy path: creates a reservation for every target date (shared room)', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 10 });

    const today = await currentDate();
    const weekdays = [1, 2, 3, 4, 5];
    const weeks = 2;
    const expected = computeRecurringDates(today, weekdays, weeks);

    const res: any = await callAs(broker, u, 'reservations.reserveRecurring', {
      roomId: room.id,
      weekdays,
      weeks,
    });

    expect(res.created).toBe(expected.length);
    expect(res.dates).toEqual(expected);
    expect(await db('reservations').where({ userId: u.id })).toHaveLength(expected.length);
  });

  it('NO_ROOM_ACCESS (403) for a non-shared room without assignment', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 5 });
    await expect(
      callAs(broker, u, 'reservations.reserveRecurring', {
        roomId: room.id,
        weekdays: [1, 2, 3, 4, 5],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 403, type: 'NO_ROOM_ACCESS' });
  });

  it('assigned non-shared room works', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'P1', isShared: false, deskCount: 5 });
    await assignRoom(db, u.id, room.id);

    const res: any = await callAs(broker, u, 'reservations.reserveRecurring', {
      roomId: room.id,
      weekdays: [1, 2, 3, 4, 5],
      weeks: 1,
    });
    expect(res.created).toBeGreaterThanOrEqual(1);
  });

  it('ALL-OR-NOTHING: RECURRING_CONFLICT when the user already holds one of the dates → nothing created', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 10 });
    const other = await seedRoom(db, { number: 'S2', isShared: true, deskCount: 10 });

    const today = await currentDate();
    const weekdays = [1, 2, 3, 4, 5];
    const weeks = 2;
    const expected = computeRecurringDates(today, weekdays, weeks);
    // Pre-existing reservation (different room) on a target date.
    await seedReservation({ userId: u.id, roomId: other.id, deskNumber: 1, date: expected[0] });

    await expect(
      callAs(broker, u, 'reservations.reserveRecurring', { roomId: room.id, weekdays, weeks }),
    ).rejects.toMatchObject({
      code: 409,
      type: 'RECURRING_CONFLICT',
      data: { alreadyBooked: [expected[0]] },
    });

    // Nothing new created — only the pre-seeded row remains.
    expect(await db('reservations').where({ userId: u.id })).toHaveLength(1);
  });

  it('ALL-OR-NOTHING: RECURRING_CONFLICT when a target date is full → nothing created', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const occupier = await seedUser(db, { email: 'o@am.lt' });
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 1 });

    const today = await currentDate();
    const weekdays = [1, 2, 3, 4, 5];
    const weeks = 2;
    const expected = computeRecurringDates(today, weekdays, weeks);
    // The single desk on the first target date is taken → room full that day.
    await seedReservation({ userId: occupier.id, roomId: room.id, deskNumber: 1, date: expected[0] });

    await expect(
      callAs(broker, u, 'reservations.reserveRecurring', { roomId: room.id, weekdays, weeks }),
    ).rejects.toMatchObject({
      code: 409,
      type: 'RECURRING_CONFLICT',
      data: { full: [expected[0]] },
    });

    expect(await db('reservations').where({ userId: u.id })).toHaveLength(0);
  });

  it('ROOM_NOT_FOUND (404) for an unknown room', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    await expect(
      callAs(broker, u, 'reservations.reserveRecurring', {
        roomId: randomUUID(),
        weekdays: [1],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'ROOM_NOT_FOUND' });
  });

  it('NOT_AUTHENTICATED (401) when no user in meta', async () => {
    const room = await seedRoom(db, { number: 'S1', isShared: true, deskCount: 5 });
    await expect(
      callAs(broker, null, 'reservations.reserveRecurring', {
        roomId: room.id,
        weekdays: [1],
        weeks: 1,
      }),
    ).rejects.toMatchObject({ code: 401, type: 'NOT_AUTHENTICATED' });
  });
});
