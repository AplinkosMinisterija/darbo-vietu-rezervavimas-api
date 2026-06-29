'use strict';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { ServiceBroker } from 'moleculer';
import type { Knex } from 'knex';
import { UserRole } from '../types/constants';
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

// Characterization suite for services/users.service.ts.
// Tikras (esamas) elgesys fiksuojamas. Aptikti bug'ai NEtaisomi — žymimi
// `KNOWN BUG: ...` ir „portuojant į HR — taisyti".
//
// Authz testuojamas action-lygyje (requireAdminHook / in-handler role/manager
// checks). Gateway EndpointType gate harness'e NEvykdomas (žr. broker.ts).

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
const PAST = '2020-01-01';
const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

// room_managers neturi helperio — įrašom tiesiogiai (mapper camelCase→snake).
async function makeManager(userId: string, roomId: string, source = 'manual') {
  await db('room_managers').insert({ userId, roomId, source });
}

// --------------------------------------------------------------------------
describe('users.me', () => {
  it('grąžina self + tuščius allowedRoomIds/managedRoomIds kai nieko nepriskirta', async () => {
    const u = await seedUser(db, { email: 'a@am.lt', displayName: 'Aldona', role: UserRole.USER });
    const res: any = await callAs(broker, u, 'users.me', {});

    expect(res).toMatchObject({
      id: u.id,
      email: 'a@am.lt',
      displayName: 'Aldona',
      role: UserRole.USER,
      msObjectId: null,
    });
    expect(res.allowedRoomIds).toEqual([]);
    expect(res.managedRoomIds).toEqual([]);
    // createdAt/updatedAt yra dalies projekcijos.
    expect(res.createdAt).toBeTruthy();
    expect(res.updatedAt).toBeTruthy();
  });

  it('grąžina allowedRoomIds iš user_room_assignments ir managedRoomIds iš room_managers', async () => {
    const u = await seedUser(db, { email: 'mgr@am.lt' });
    const r1 = await seedRoom(db, { number: 'A1' });
    const r2 = await seedRoom(db, { number: 'A2' });
    const r3 = await seedRoom(db, { number: 'A3' });
    await assignRoom(db, u.id, r1.id);
    await assignRoom(db, u.id, r2.id);
    await makeManager(u.id, r3.id);

    const res: any = await callAs(broker, u, 'users.me', {});
    expect(res.allowedRoomIds.sort()).toEqual([r1.id, r2.id].sort());
    expect(res.managedRoomIds).toEqual([r3.id]);
  });

  it('neautentifikuotas (meta.user nėra) → 401 NOT_AUTHENTICATED', async () => {
    await expect(callAs(broker, null, 'users.me', {})).rejects.toMatchObject({
      code: 401,
      type: 'NOT_AUTHENTICATED',
    });
  });

  it('soft-deleted naudotojas → 404 NOT_FOUND', async () => {
    const u = await seedUser(db, { email: 'gone@am.lt' });
    await db('users').where({ id: u.id }).update({ deletedAt: db.fn.now() });

    await expect(callAs(broker, u, 'users.me', {})).rejects.toMatchObject({
      code: 404,
      type: 'NOT_FOUND',
    });
  });

  it('KNOWN BUG: me.managedRoomIds įtraukia ir soft-deleted patalpas (nėra rooms join / deletedAt filtro, priešingai nei getManagedRoomIds). Portuojant į HR — taisyti', async () => {
    const u = await seedUser(db, { email: 'mgr2@am.lt' });
    const r = await seedRoom(db, { number: 'D1' });
    await makeManager(u.id, r.id);
    await db('rooms').where({ id: r.id }).update({ deletedAt: db.fn.now() });

    const res: any = await callAs(broker, u, 'users.me', {});
    // Buggy elgesys: ištrintos patalpos vis tiek matomos managedRoomIds.
    expect(res.managedRoomIds).toEqual([r.id]);
  });
});

// --------------------------------------------------------------------------
describe('users.listUsers', () => {
  it('ADMIN gauna paginuotą sąrašą su total ir per-user allowedRoomIds', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u1 = await seedUser(db, { email: 'bob@am.lt', displayName: 'Bob' });
    const r = await seedRoom(db, { number: 'L1' });
    await assignRoom(db, u1.id, r.id);

    const res: any = await callAs(broker, admin, 'users.listUsers', {});
    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
    const bob = res.items.find((i: any) => i.email === 'bob@am.lt');
    expect(bob.allowedRoomIds).toEqual([r.id]);
  });

  it('rūšiuoja pagal displayName asc ir gerbia limit/offset', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN, displayName: 'AAA' });
    await seedUser(db, { email: 'c@am.lt', displayName: 'Carol' });
    await seedUser(db, { email: 'b@am.lt', displayName: 'Bob' });

    const page1: any = await callAs(broker, admin, 'users.listUsers', { limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((i: any) => i.displayName)).toEqual(['AAA', 'Bob']);

    const page2: any = await callAs(broker, admin, 'users.listUsers', { limit: 2, offset: 2 });
    expect(page2.items.map((i: any) => i.displayName)).toEqual(['Carol']);
  });

  it('q paieška ILIKE per email ir display_name (case-insensitive)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN, displayName: 'Admin' });
    await seedUser(db, { email: 'jonas@am.lt', displayName: 'Jonas Petraitis' });
    await seedUser(db, { email: 'ona@am.lt', displayName: 'Ona Onaitė' });

    const byName: any = await callAs(broker, admin, 'users.listUsers', { q: 'petr' });
    expect(byName.total).toBe(1);
    expect(byName.items[0].email).toBe('jonas@am.lt');

    const byEmail: any = await callAs(broker, admin, 'users.listUsers', { q: 'ONA@' });
    expect(byEmail.total).toBe(1);
    expect(byEmail.items[0].email).toBe('ona@am.lt');
  });

  it('patalpos vadovas (ne admin) gauna sąrašą', async () => {
    const mgr = await seedUser(db, { email: 'mgr@am.lt', role: UserRole.USER });
    const r = await seedRoom(db, { number: 'M1' });
    await makeManager(mgr.id, r.id);

    const res: any = await callAs(broker, mgr, 'users.listUsers', {});
    expect(res.items.length).toBeGreaterThanOrEqual(1);
  });

  it('paprastas naudotojas (ne admin, ne vadovas) → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'plain@am.lt', role: UserRole.USER });
    await expect(callAs(broker, u, 'users.listUsers', {})).rejects.toMatchObject({
      code: 403,
      type: 'FORBIDDEN',
    });
  });

  it('neautentifikuotas → 403 FORBIDDEN (ne 401 — kad neiššauktų FE logout)', async () => {
    await expect(callAs(broker, null, 'users.listUsers', {})).rejects.toMatchObject({
      code: 403,
      type: 'FORBIDDEN',
    });
  });

  it('neįtraukia soft-deleted naudotojų', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const gone = await seedUser(db, { email: 'gone@am.lt' });
    await db('users').where({ id: gone.id }).update({ deletedAt: db.fn.now() });

    const res: any = await callAs(broker, admin, 'users.listUsers', {});
    expect(res.total).toBe(1);
    expect(res.items.map((i: any) => i.email)).toEqual(['admin@am.lt']);
  });
});

// --------------------------------------------------------------------------
describe('users.getUser', () => {
  it('ADMIN gauna hidruotą naudotoją su allowedRoomIds', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'target@am.lt', displayName: 'Target' });
    const r = await seedRoom(db, { number: 'G1' });
    await assignRoom(db, u.id, r.id);

    const res: any = await callAs(broker, admin, 'users.getUser', { id: u.id });
    expect(res).toMatchObject({ id: u.id, email: 'target@am.lt', displayName: 'Target' });
    expect(res.allowedRoomIds).toEqual([r.id]);
    // hydrateUser negrąžina managedRoomIds.
    expect(res.managedRoomIds).toBeUndefined();
  });

  it('nesantis naudotojas → 404 NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(callAs(broker, admin, 'users.getUser', { id: ABSENT_UUID })).rejects.toMatchObject({
      code: 404,
      type: 'NOT_FOUND',
    });
  });

  it('soft-deleted naudotojas → 404 NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'gone@am.lt' });
    await db('users').where({ id: u.id }).update({ deletedAt: db.fn.now() });
    await expect(callAs(broker, admin, 'users.getUser', { id: u.id })).rejects.toMatchObject({
      code: 404,
      type: 'NOT_FOUND',
    });
  });

  it('ne-admin → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'plain@am.lt', role: UserRole.USER });
    const t = await seedUser(db, { email: 't@am.lt' });
    await expect(callAs(broker, u, 'users.getUser', { id: t.id })).rejects.toMatchObject({
      code: 403,
      type: 'FORBIDDEN',
    });
  });
});

// --------------------------------------------------------------------------
describe('users.assignRooms', () => {
  it('ADMIN pakeičia priskyrimus (replace) ir grąžina hidruotą naudotoją', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const r1 = await seedRoom(db, { number: 'R1' });
    const r2 = await seedRoom(db, { number: 'R2' });
    const r3 = await seedRoom(db, { number: 'R3' });
    await assignRoom(db, u.id, r1.id); // pradinis priskyrimas, turi būti pakeistas

    const res: any = await callAs(broker, admin, 'users.assignRooms', {
      id: u.id,
      roomIds: [r2.id, r3.id],
    });
    expect(res.allowedRoomIds.sort()).toEqual([r2.id, r3.id].sort());

    const rows = await db('user_room_assignments').where({ userId: u.id }).select('roomId');
    expect(rows.map((x: any) => x.roomId).sort()).toEqual([r2.id, r3.id].sort());
  });

  it('tuščias roomIds išvalo visus priskyrimus', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const r1 = await seedRoom(db, { number: 'R1' });
    await assignRoom(db, u.id, r1.id);

    const res: any = await callAs(broker, admin, 'users.assignRooms', { id: u.id, roomIds: [] });
    expect(res.allowedRoomIds).toEqual([]);
    const rows = await db('user_room_assignments').where({ userId: u.id });
    expect(rows).toHaveLength(0);
  });

  it('dedup pasikartojančius roomIds', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const r1 = await seedRoom(db, { number: 'R1' });

    const res: any = await callAs(broker, admin, 'users.assignRooms', {
      id: u.id,
      roomIds: [r1.id, r1.id, r1.id],
    });
    expect(res.allowedRoomIds).toEqual([r1.id]);
  });

  it('nesantis naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const r1 = await seedRoom(db, { number: 'R1' });
    await expect(
      callAs(broker, admin, 'users.assignRooms', { id: ABSENT_UUID, roomIds: [r1.id] }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('ne-admin → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'plain@am.lt', role: UserRole.USER });
    const t = await seedUser(db, { email: 't@am.lt' });
    await expect(
      callAs(broker, u, 'users.assignRooms', { id: t.id, roomIds: [] }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });
});

// --------------------------------------------------------------------------
describe('users.setRole', () => {
  it('ADMIN pakeičia kito naudotojo rolę ir grąžina hidruotą', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt', role: UserRole.USER });

    const res: any = await callAs(broker, admin, 'users.setRole', { id: u.id, role: UserRole.ADMIN });
    expect(res).toMatchObject({ id: u.id, role: UserRole.ADMIN });

    const [row] = await db('users').where({ id: u.id }).select('role');
    expect(row.role).toBe(UserRole.ADMIN);
  });

  it('admin negali keisti savo rolės → 403 SELF_ROLE_CHANGE_FORBIDDEN', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'users.setRole', { id: admin.id, role: UserRole.USER }),
    ).rejects.toMatchObject({ code: 403, type: 'SELF_ROLE_CHANGE_FORBIDDEN' });
  });

  it('nesantis naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'users.setRole', { id: ABSENT_UUID, role: UserRole.ADMIN }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('ne-admin → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'plain@am.lt', role: UserRole.USER });
    const t = await seedUser(db, { email: 't@am.lt' });
    await expect(
      callAs(broker, u, 'users.setRole', { id: t.id, role: UserRole.ADMIN }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('KNOWN BUG: setRole soft-deleted naudotojui pakeičia rolę DB, bet grąžina null (existence check nefiltruoja deletedAt, hydrateUser — filtruoja). Portuojant į HR — taisyti', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'gone@am.lt', role: UserRole.USER });
    await db('users').where({ id: u.id }).update({ deletedAt: db.fn.now() });

    const res: any = await callAs(broker, admin, 'users.setRole', { id: u.id, role: UserRole.ADMIN });
    // Buggy: rolė realiai pakeista, bet atsakymas null.
    expect(res).toBeNull();
    const [row] = await db('users').where({ id: u.id }).select('role');
    expect(row.role).toBe(UserRole.ADMIN);
  });
});

// --------------------------------------------------------------------------
describe('users.updateUser', () => {
  it('ADMIN atnaujina displayName (trim) ir email', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'old@am.lt', displayName: 'Old' });

    const res: any = await callAs(broker, admin, 'users.updateUser', {
      id: u.id,
      displayName: '  New Name  ',
      email: 'new@am.lt',
    });
    expect(res).toMatchObject({ id: u.id, displayName: 'New Name', email: 'new@am.lt' });
  });

  it('užimtas email → 409 EMAIL_TAKEN (citext, case-insensitive)', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await seedUser(db, { email: 'taken@am.lt' });
    const u = await seedUser(db, { email: 'mine@am.lt' });

    await expect(
      callAs(broker, admin, 'users.updateUser', { id: u.id, email: 'TAKEN@AM.LT' }),
    ).rejects.toMatchObject({ code: 409, type: 'EMAIL_TAKEN' });
  });

  it('be pakeitimų (tik id) → grąžina esamą hidruotą naudotoją be rašymo', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt', displayName: 'U' });

    const res: any = await callAs(broker, admin, 'users.updateUser', { id: u.id });
    expect(res).toMatchObject({ id: u.id, email: 'u@am.lt', displayName: 'U' });
    expect(res.allowedRoomIds).toEqual([]);
  });

  it('nesantis naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'users.updateUser', { id: ABSENT_UUID, displayName: 'X' }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('soft-deleted naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'gone@am.lt' });
    await db('users').where({ id: u.id }).update({ deletedAt: db.fn.now() });
    await expect(
      callAs(broker, admin, 'users.updateUser', { id: u.id, displayName: 'X' }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('ne-admin → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'plain@am.lt', role: UserRole.USER });
    const t = await seedUser(db, { email: 't@am.lt' });
    await expect(
      callAs(broker, u, 'users.updateUser', { id: t.id, displayName: 'X' }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });
});

// --------------------------------------------------------------------------
describe('users.deleteUser', () => {
  it('ADMIN soft-delete + atšaukia ateities rezervacijas, palieka praeities', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const room = await seedRoom(db, { number: 'DR1', isShared: true, deskCount: 5 });
    // Įrašom tiesiogiai (unique user_id+date → skirtingos datos).
    await db('reservations').insert([
      { userId: u.id, roomId: room.id, deskNumber: 1, date: FUTURE },
      { userId: u.id, roomId: room.id, deskNumber: 2, date: PAST },
    ]);

    const res: any = await callAs(broker, admin, 'users.deleteUser', { id: u.id });
    expect(res).toEqual({ ok: true, futureReservationsRemoved: 1 });

    // Naudotojas soft-deleted.
    const [row] = await db('users').where({ id: u.id }).select('deletedAt');
    expect(row.deletedAt).toBeTruthy();

    // Liko tik praeities rezervacija.
    const remaining = await db('reservations').where({ userId: u.id }).select('date');
    expect(remaining).toHaveLength(1);
  });

  it('admin negali ištrinti savęs → 403 SELF_DELETE_FORBIDDEN', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'users.deleteUser', { id: admin.id }),
    ).rejects.toMatchObject({ code: 403, type: 'SELF_DELETE_FORBIDDEN' });
  });

  it('nesantis naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    await expect(
      callAs(broker, admin, 'users.deleteUser', { id: ABSENT_UUID }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('jau ištrintas naudotojas → 404 USER_NOT_FOUND', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'gone@am.lt' });
    await db('users').where({ id: u.id }).update({ deletedAt: db.fn.now() });
    await expect(
      callAs(broker, admin, 'users.deleteUser', { id: u.id }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('ne-admin → 403 FORBIDDEN', async () => {
    const u = await seedUser(db, { email: 'plain@am.lt', role: UserRole.USER });
    const t = await seedUser(db, { email: 't@am.lt' });
    await expect(
      callAs(broker, u, 'users.deleteUser', { id: t.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('be ateities rezervacijų → futureReservationsRemoved = 0', async () => {
    const admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
    const u = await seedUser(db, { email: 'u@am.lt' });
    const res: any = await callAs(broker, admin, 'users.deleteUser', { id: u.id });
    expect(res).toEqual({ ok: true, futureReservationsRemoved: 0 });
  });
});
