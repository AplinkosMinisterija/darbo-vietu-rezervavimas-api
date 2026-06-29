'use strict';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { ServiceBroker } from 'moleculer';
import type { Knex } from 'knex';
import {
  startTestBroker,
  stopTestBroker,
  makeDb,
  resetTables,
  seedUser,
  seedRoom,
  callAs,
} from './helpers/broker';

// Harness verifikacija — įrodo, kad broker boot + throwaway PG + callAs meta.user
// + DB unique boundary veikia. Tikras domeno padengimas — atskiruose failuose.

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

describe('harness smoke · reservations', () => {
  it('USER rezervuoja stalą shared patalpoje', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'T1', isShared: true, deskCount: 3 });

    await callAs(broker, u, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });

    // Verifikuojam per DB (return payload turi žinomą bug'ą — žr. žemiau).
    const rows = await db('reservations');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomId: room.id, deskNumber: 1, userId: u.id });
  });

  it('KNOWN BUG: createReservation return payload numeta roomId/deskNumber/userId (snake_case read ant camelCase row)', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'T1', isShared: true, deskCount: 3 });

    const res: any = await callAs(broker, u, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });

    // Charakterizacija: dabartinė (buggy) elgsena — knexSnakeCaseMappers grąžina
    // camelCase, bet handleris skaito created.room_id/desk_number/user_id → undefined.
    // Portuojant į HR — TAISYTI (ir šis testas tada pasikeis į teisingą shape).
    expect(res.id).toBeTruthy();
    expect(res.roomId).toBeUndefined();
    expect(res.deskNumber).toBeUndefined();
    expect(res.userId).toBeUndefined();
  });

  it('to paties stalo dvigubas rezervavimas → DESK_TAKEN (DB unique boundary)', async () => {
    const u1 = await seedUser(db, { email: 'a@am.lt' });
    const u2 = await seedUser(db, { email: 'b@am.lt' });
    const room = await seedRoom(db, { number: 'T1', isShared: true, deskCount: 3 });

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

  it('non-shared patalpa be assignment → NO_ROOM_ACCESS', async () => {
    const u = await seedUser(db, { email: 'a@am.lt' });
    const room = await seedRoom(db, { number: 'T2', isShared: false, deskCount: 2 });

    await expect(
      callAs(broker, u, 'reservations.createReservation', {
        roomId: room.id,
        deskNumber: 1,
        date: FUTURE,
      }),
    ).rejects.toMatchObject({ type: 'NO_ROOM_ACCESS' });
  });
});
