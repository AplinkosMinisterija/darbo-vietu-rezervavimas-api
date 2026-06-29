'use strict';

import { randomUUID } from 'node:crypto';
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
  assignRoom,
  callAs,
} from './helpers/broker';
import { UserRole } from '../types/constants';

// Charakterizaciniai integraciniai testai `rooms` servisui. Kviečiam actions
// TIESIOGIAI per broker'į (gateway EndpointType gate NEvykdomas — testuojam
// action-lygio authz: requireAdminHook, admin-or-manager gate, ownership).
//
// Room-manager grant'ą kuriam įrašu į `room_managers` (user_id, room_id, source;
// source default 'manual'). Reservacijas šrink/delete guard'ams insert'inam
// tiesiai per knex.
//
// BUG'ai NEtaisomi — fiksuojami kaip `it('KNOWN BUG: ...')`.

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
const FUTURE_2 = '2030-02-20';
const PAST = '2020-01-01';

// Suteikia room-manager teises (tiesiai į room_managers; snake mapper paverčia).
async function grantManager(userId: string, roomId: string, source = 'manual') {
  await db('room_managers').insert({ userId, roomId, source });
}

// Insert'ina rezervaciją tiesiai (apeinam reservations servisą).
async function insertReservation(userId: string, roomId: string, deskNumber: number, date: string) {
  await db('reservations').insert({ userId, roomId, deskNumber, date });
}

// KNOWN BUG helper: pg `date` (OID 1082) parsinamas kaip LOKALI vidurnakčio Date
// (`new Date(y, m-1, d)`), o `roomReservations` daro `r.date.toISOString().slice(0,10)`
// → TZ rytuose nuo UTC gaunamas -1 diena. Atkartojam tą pačią (buggy) transformaciją,
// kad assertion'as būtų deterministinis bet kurioje TZ. Portuojant į HR — TAISYTI
// (naudoti TZ-saugų formatavimą, kaip reservations.service neturėtų daryti per UTC getterius).
function pgDateAsServiceReturns(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
describe('rooms.listRooms', () => {
  it('tuščia → {items:[], total:0}', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const res: any = await callAs(broker, admin, 'rooms.listRooms', {});
    expect(res).toEqual({ items: [], total: 0 });
  });

  it('grąžina rooms, surūšiuotus floor asc, number asc; pilnas shape', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    await seedRoom(db, { number: 'B', floor: 2, name: 'Antras', deskCount: 4, isShared: true });
    await seedRoom(db, { number: 'A', floor: 1, name: 'Pirmas', deskCount: 3, isShared: false });
    await seedRoom(db, { number: 'C', floor: 1, name: 'Cee', deskCount: 2 });

    const res: any = await callAs(broker, u, 'rooms.listRooms', {});
    expect(res.total).toBe(3);
    expect(res.items.map((r: any) => r.number)).toEqual(['A', 'C', 'B']); // floor1(A,C) tada floor2(B)

    const first = res.items[0];
    expect(Object.keys(first).sort()).toEqual(
      ['createdAt', 'deskCount', 'floor', 'id', 'isShared', 'name', 'number'].sort(),
    );
    expect(first).toMatchObject({
      number: 'A',
      name: 'Pirmas',
      floor: 1,
      deskCount: 3,
      isShared: false,
    });
    expect(first.id).toBeTruthy();
    expect(first.createdAt).toBeTruthy();
  });

  it('limit + offset puslapiuoja; total = pilnas count (ne puslapio)', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    for (let i = 1; i <= 5; i++) await seedRoom(db, { number: `R${i}`, floor: 1 });

    const res: any = await callAs(broker, u, 'rooms.listRooms', { limit: 2, offset: 2 });
    expect(res.total).toBe(5);
    expect(res.items).toHaveLength(2);
    expect(res.items.map((r: any) => r.number)).toEqual(['R3', 'R4']);
  });

  it('soft-deleted rooms išfiltruojami iš items ir total', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    await seedRoom(db, { number: 'LIVE', floor: 1 });
    const gone = await seedRoom(db, { number: 'DEAD', floor: 1 });
    await db('rooms').where({ id: gone.id }).update({ deletedAt: db.fn.now() });

    const res: any = await callAs(broker, u, 'rooms.listRooms', {});
    expect(res.total).toBe(1);
    expect(res.items.map((r: any) => r.number)).toEqual(['LIVE']);
  });

  it('CHARAKTERIZACIJA: action-lygyje nėra auth gate — null user gauna sąrašą (gateway EndpointType.USER dengia HTTP-lygyje)', async () => {
    await seedRoom(db, { number: 'X', floor: 1 });
    const res: any = await callAs(broker, null, 'rooms.listRooms', {});
    expect(res.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('rooms.getRoom', () => {
  it('grąžina patalpą pilnu shape', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'G1', name: 'Geras', floor: 3, deskCount: 7, isShared: true });

    const res: any = await callAs(broker, u, 'rooms.getRoom', { id: room.id });
    expect(res).toMatchObject({
      id: room.id,
      number: 'G1',
      name: 'Geras',
      floor: 3,
      deskCount: 7,
      isShared: true,
    });
    expect(res.createdAt).toBeTruthy();
  });

  it('neegzistuojanti → 404 NOT_FOUND', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    await expect(
      callAs(broker, u, 'rooms.getRoom', { id: randomUUID() }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });

  it('soft-deleted → 404 NOT_FOUND', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'D1', floor: 1 });
    await db('rooms').where({ id: room.id }).update({ deletedAt: db.fn.now() });
    await expect(
      callAs(broker, u, 'rooms.getRoom', { id: room.id }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.createRoom', () => {
  it('ADMIN sukuria → grąžina shape + persistuoja DB', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const res: any = await callAs(broker, admin, 'rooms.createRoom', {
      number: 'N1',
      name: 'Naujas',
      floor: 2,
      deskCount: 6,
      isShared: true,
    });
    expect(res).toMatchObject({ number: 'N1', name: 'Naujas', floor: 2, deskCount: 6, isShared: true });
    expect(res.id).toBeTruthy();
    expect(res.createdAt).toBeTruthy();

    const rows = await db('rooms').where({ id: res.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 'N1', deskCount: 6, isShared: true });
  });

  it('isShared default = false kai praleista', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const res: any = await callAs(broker, admin, 'rooms.createRoom', {
      number: 'N2',
      name: 'Be shared',
      floor: 1,
      deskCount: 1,
    });
    expect(res.isShared).toBe(false);
  });

  it('dublikatas number → 409 NUMBER_TAKEN', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await seedRoom(db, { number: 'DUP', floor: 1 });
    await expect(
      callAs(broker, admin, 'rooms.createRoom', { number: 'DUP', name: 'x', floor: 1, deskCount: 1 }),
    ).rejects.toMatchObject({ code: 409, type: 'NUMBER_TAKEN' });
  });

  it('eilinis USER → 403 FORBIDDEN (requireAdminHook)', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    await expect(
      callAs(broker, u, 'rooms.createRoom', { number: 'Z', name: 'x', floor: 1, deskCount: 1 }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.updateRoom', () => {
  it('ADMIN keičia visus laukus (number/name/floor/deskCount/isShared)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'U1', name: 'Sen', floor: 1, deskCount: 5, isShared: false });

    const res: any = await callAs(broker, admin, 'rooms.updateRoom', {
      id: room.id,
      number: 'U1-new',
      name: 'Nauj',
      floor: 4,
      deskCount: 8,
      isShared: true,
    });
    expect(res).toMatchObject({
      number: 'U1-new',
      name: 'Nauj',
      floor: 4,
      deskCount: 8,
      isShared: true,
    });
  });

  it('room-manager gali keisti deskCount + name', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'M1', name: 'Sen', floor: 1, deskCount: 3 });
    await grantManager(mgr.id, room.id);

    const res: any = await callAs(broker, mgr, 'rooms.updateRoom', {
      id: room.id,
      name: 'Mgr pavadinimas',
      deskCount: 9,
    });
    expect(res).toMatchObject({ name: 'Mgr pavadinimas', deskCount: 9 });
  });

  it('room-manager keičiantis floor → 403 MANAGER_FIELD_FORBIDDEN', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'M2', floor: 1, deskCount: 3 });
    await grantManager(mgr.id, room.id);
    await expect(
      callAs(broker, mgr, 'rooms.updateRoom', { id: room.id, floor: 5 }),
    ).rejects.toMatchObject({ code: 403, type: 'MANAGER_FIELD_FORBIDDEN' });
  });

  it('room-manager keičiantis isShared → 403 MANAGER_FIELD_FORBIDDEN', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'M3', floor: 1, deskCount: 3 });
    await grantManager(mgr.id, room.id);
    await expect(
      callAs(broker, mgr, 'rooms.updateRoom', { id: room.id, isShared: true }),
    ).rejects.toMatchObject({ code: 403, type: 'MANAGER_FIELD_FORBIDDEN' });
  });

  it('room-manager keičiantis number → 403 MANAGER_FIELD_FORBIDDEN', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'M4', floor: 1, deskCount: 3 });
    await grantManager(mgr.id, room.id);
    await expect(
      callAs(broker, mgr, 'rooms.updateRoom', { id: room.id, number: 'M4-x' }),
    ).rejects.toMatchObject({ code: 403, type: 'MANAGER_FIELD_FORBIDDEN' });
  });

  it('eilinis USER (ne manager) → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'M5', floor: 1, deskCount: 3 });
    await expect(
      callAs(broker, u, 'rooms.updateRoom', { id: room.id, name: 'x' }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('ADMIN, neegzistuojanti patalpa → 404 NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'rooms.updateRoom', { id: randomUUID(), name: 'x' }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });

  it('shrink guard: deskCount mažinamas žemiau būsimos rezervacijos → 409 DESK_HAS_FUTURE_RESERVATIONS', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'S1', floor: 1, deskCount: 5 });
    await insertReservation(u.id, room.id, 5, FUTURE);

    await expect(
      callAs(broker, admin, 'rooms.updateRoom', { id: room.id, deskCount: 3 }),
    ).rejects.toMatchObject({ code: 409, type: 'DESK_HAS_FUTURE_RESERVATIONS' });
  });

  it('shrink guard ignoruoja PRAEITIES rezervacijas (date < CURRENT_DATE) → leidžia mažinti', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'S2', floor: 1, deskCount: 5 });
    await insertReservation(u.id, room.id, 5, PAST);

    const res: any = await callAs(broker, admin, 'rooms.updateRoom', { id: room.id, deskCount: 3 });
    expect(res.deskCount).toBe(3);
  });

  it('shrink be orphan rezervacijų (rezervacija desk <= naujo count) → leidžia', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'S3', floor: 1, deskCount: 5 });
    await insertReservation(u.id, room.id, 2, FUTURE);

    const res: any = await callAs(broker, admin, 'rooms.updateRoom', { id: room.id, deskCount: 3 });
    expect(res.deskCount).toBe(3);
  });

  it('deskCount didinimas neaktyvuoja guard (nors yra būsimų rezervacijų)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'S4', floor: 1, deskCount: 3 });
    await insertReservation(u.id, room.id, 3, FUTURE);

    const res: any = await callAs(broker, admin, 'rooms.updateRoom', { id: room.id, deskCount: 10 });
    expect(res.deskCount).toBe(10);
  });

  it('rename į užimtą number → 409 NUMBER_TAKEN', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await seedRoom(db, { number: 'EXIST', floor: 1 });
    const room = await seedRoom(db, { number: 'OTHER', floor: 1 });
    await expect(
      callAs(broker, admin, 'rooms.updateRoom', { id: room.id, number: 'EXIST' }),
    ).rejects.toMatchObject({ code: 409, type: 'NUMBER_TAKEN' });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.deleteRoom', () => {
  it('ADMIN soft-delete → {ok:true}, patalpa dingsta iš sąrašo, deleted_at užpildytas', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'DEL1', floor: 1 });

    const res: any = await callAs(broker, admin, 'rooms.deleteRoom', { id: room.id });
    expect(res).toEqual({ ok: true });

    const row = await db('rooms').where({ id: room.id }).first();
    expect(row.deletedAt).toBeTruthy(); // eilutė lieka (soft delete)
    await expect(
      callAs(broker, admin, 'rooms.getRoom', { id: room.id }),
    ).rejects.toMatchObject({ type: 'NOT_FOUND' });
  });

  it('būsima rezervacija → 409 ROOM_HAS_FUTURE_RESERVATIONS', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'DEL2', floor: 1 });
    await insertReservation(u.id, room.id, 1, FUTURE);
    await expect(
      callAs(broker, admin, 'rooms.deleteRoom', { id: room.id }),
    ).rejects.toMatchObject({ code: 409, type: 'ROOM_HAS_FUTURE_RESERVATIONS' });
  });

  it('tik praeities rezervacija → leidžia trinti', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'DEL3', floor: 1 });
    await insertReservation(u.id, room.id, 1, PAST);
    const res: any = await callAs(broker, admin, 'rooms.deleteRoom', { id: room.id });
    expect(res).toEqual({ ok: true });
  });

  it('eilinis USER → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'DEL4', floor: 1 });
    await expect(
      callAs(broker, u, 'rooms.deleteRoom', { id: room.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('room-manager (ne admin) → 403 FORBIDDEN (delete tik admin)', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'DEL5', floor: 1 });
    await grantManager(mgr.id, room.id);
    await expect(
      callAs(broker, mgr, 'rooms.deleteRoom', { id: room.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('ADMIN, neegzistuojanti → 404 NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'rooms.deleteRoom', { id: randomUUID() }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.listMembers', () => {
  it('ADMIN mato narius (id/displayName/email), surūšiuotus pagal displayName', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'LM1', floor: 1 });
    const zoe = await seedUser(db, { email: 'zoe@am.lt', displayName: 'Zoe' });
    const ann = await seedUser(db, { email: 'ann@am.lt', displayName: 'Ann' });
    await assignRoom(db, zoe.id, room.id);
    await assignRoom(db, ann.id, room.id);

    const res: any = await callAs(broker, admin, 'rooms.listMembers', { id: room.id });
    expect(res.map((m: any) => m.displayName)).toEqual(['Ann', 'Zoe']);
    expect(res[0]).toMatchObject({ id: ann.id, displayName: 'Ann', email: 'ann@am.lt' });
  });

  it('room-manager mato narius', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'LM2', floor: 1 });
    await grantManager(mgr.id, room.id);
    const m = await seedUser(db, { email: 'm@am.lt', displayName: 'Narys' });
    await assignRoom(db, m.id, room.id);

    const res: any = await callAs(broker, mgr, 'rooms.listMembers', { id: room.id });
    expect(res).toHaveLength(1);
    expect(res[0].displayName).toBe('Narys');
  });

  it('eilinis USER → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'LM3', floor: 1 });
    await expect(
      callAs(broker, u, 'rooms.listMembers', { id: room.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('ADMIN, neegzistuojanti patalpa → 404 NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'rooms.listMembers', { id: randomUUID() }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.addMember', () => {
  it('ADMIN prideda narį → {ok:true} + eilutė user_room_assignments', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'AM1', floor: 1 });
    const m = await seedUser(db, { email: 'm@am.lt' });

    const res: any = await callAs(broker, admin, 'rooms.addMember', { id: room.id, userId: m.id });
    expect(res).toEqual({ ok: true });
    const rows = await db('user_room_assignments').where({ userId: m.id, roomId: room.id });
    expect(rows).toHaveLength(1);
  });

  it('room-manager prideda narį', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'AM2', floor: 1 });
    await grantManager(mgr.id, room.id);
    const m = await seedUser(db, { email: 'm@am.lt' });

    const res: any = await callAs(broker, mgr, 'rooms.addMember', { id: room.id, userId: m.id });
    expect(res).toEqual({ ok: true });
  });

  it('idempotentiškas: tas pats narys 2x → 1 eilutė', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'AM3', floor: 1 });
    const m = await seedUser(db, { email: 'm@am.lt' });
    await callAs(broker, admin, 'rooms.addMember', { id: room.id, userId: m.id });
    await callAs(broker, admin, 'rooms.addMember', { id: room.id, userId: m.id });
    const rows = await db('user_room_assignments').where({ userId: m.id, roomId: room.id });
    expect(rows).toHaveLength(1);
  });

  it('eilinis USER → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'AM4', floor: 1 });
    const m = await seedUser(db, { email: 'm@am.lt' });
    await expect(
      callAs(broker, u, 'rooms.addMember', { id: room.id, userId: m.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('ADMIN, neegzistuojanti patalpa → 404 NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const m = await seedUser(db, { email: 'm@am.lt' });
    await expect(
      callAs(broker, admin, 'rooms.addMember', { id: randomUUID(), userId: m.id }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });

  it('ADMIN, neegzistuojantis naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'AM5', floor: 1 });
    await expect(
      callAs(broker, admin, 'rooms.addMember', { id: room.id, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.removeMember', () => {
  it('ADMIN pašalina narį → {ok:true}, eilutė dingsta', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'RM1', floor: 1 });
    const m = await seedUser(db, { email: 'm@am.lt' });
    await assignRoom(db, m.id, room.id);

    const res: any = await callAs(broker, admin, 'rooms.removeMember', { id: room.id, userId: m.id });
    expect(res).toEqual({ ok: true });
    const rows = await db('user_room_assignments').where({ userId: m.id, roomId: room.id });
    expect(rows).toHaveLength(0);
  });

  it('room-manager pašalina narį', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'RM2', floor: 1 });
    await grantManager(mgr.id, room.id);
    const m = await seedUser(db, { email: 'm@am.lt' });
    await assignRoom(db, m.id, room.id);
    const res: any = await callAs(broker, mgr, 'rooms.removeMember', { id: room.id, userId: m.id });
    expect(res).toEqual({ ok: true });
  });

  it('ne-narys (idempotentiškas) → {ok:true} be klaidos', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'RM3', floor: 1 });
    const m = await seedUser(db, { email: 'm@am.lt' });
    const res: any = await callAs(broker, admin, 'rooms.removeMember', { id: room.id, userId: m.id });
    expect(res).toEqual({ ok: true });
  });

  it('eilinis USER → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'RM4', floor: 1 });
    const m = await seedUser(db, { email: 'm@am.lt' });
    await expect(
      callAs(broker, u, 'rooms.removeMember', { id: room.id, userId: m.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('CHARAKTERIZACIJA: ADMIN removeMember neegzistuojančioje patalpoje → {ok:true} (nėra 404 guard)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const m = await seedUser(db, { email: 'm@am.lt' });
    const res: any = await callAs(broker, admin, 'rooms.removeMember', { id: randomUUID(), userId: m.id });
    expect(res).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
describe('rooms.roomReservations', () => {
  it('KNOWN BUG: mato rezervacijas su user info ir teisinga tvarka, BET date -1 diena (toISOString ant lokalios date)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'RR1', floor: 1, deskCount: 5 });
    const a = await seedUser(db, { email: 'a@am.lt', displayName: 'Aaa' });
    const b = await seedUser(db, { email: 'b@am.lt', displayName: 'Bbb' });
    await insertReservation(a.id, room.id, 2, FUTURE);
    await insertReservation(b.id, room.id, 1, FUTURE_2);

    const res: any = await callAs(broker, admin, 'rooms.roomReservations', { id: room.id });
    expect(res).toHaveLength(2);
    // Rūšiavimas (date asc, deskNumber asc) ir user join'as TEISINGI; tik date string buggy.
    // Portuojant į HR — TAISYTI date serializaciją (turėtų grąžinti FUTURE/FUTURE_2 tiksliai).
    expect(res[0]).toMatchObject({
      deskNumber: 2,
      date: pgDateAsServiceReturns(FUTURE),
      user: { id: a.id, displayName: 'Aaa' },
    });
    expect(res[0].id).toBeTruthy();
    expect(res[1]).toMatchObject({
      deskNumber: 1,
      date: pgDateAsServiceReturns(FUTURE_2),
      user: { id: b.id, displayName: 'Bbb' },
    });
  });

  it('room-manager mato rezervacijas', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt' });
    const room = await seedRoom(db, { number: 'RR2', floor: 1, deskCount: 5 });
    await grantManager(mgr.id, room.id);
    const a = await seedUser(db, { email: 'a@am.lt', displayName: 'Aaa' });
    await insertReservation(a.id, room.id, 1, FUTURE);

    const res: any = await callAs(broker, mgr, 'rooms.roomReservations', { id: room.id });
    expect(res).toHaveLength(1);
    expect(res[0].user.displayName).toBe('Aaa');
  });

  it('dateFrom/dateTo filtruoja (SQL-side filtras teisingas; grąžinta date -1 diena dėl to paties bug)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const room = await seedRoom(db, { number: 'RR3', floor: 1, deskCount: 5 });
    const a = await seedUser(db, { email: 'a@am.lt' });
    await insertReservation(a.id, room.id, 1, '2030-01-10');
    const b = await seedUser(db, { email: 'b@am.lt' });
    await insertReservation(b.id, room.id, 2, '2030-03-10');

    const res: any = await callAs(broker, admin, 'rooms.roomReservations', {
      id: room.id,
      dateFrom: '2030-02-01',
      dateTo: '2030-04-01',
    });
    // Filtras (SQL date >= / <=) atrenka teisingai — tik 1 įrašas patenka į rėžį.
    expect(res).toHaveLength(1);
    // date serializacija buggy (žr. roomReservations KNOWN BUG aukščiau).
    expect(res[0].date).toBe(pgDateAsServiceReturns('2030-03-10'));
  });

  it('eilinis USER → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'RR4', floor: 1 });
    await expect(
      callAs(broker, u, 'rooms.roomReservations', { id: room.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });
});
