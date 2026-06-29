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
  callAs,
  type SeededUser,
} from './helpers/broker';

// Charakterizacijos integraciniai testai: roomManagers + stats + audit + export.
// Kviečiame action'us TIESIOGIAI per broker'į (gateway EndpointType gate NEvykdomas —
// žr. broker.ts pastabą), todėl tikriname action-lygio authz (requireAdminHook),
// in-handler logiką ir DB ribas. Bug'ų NETAISOM — fiksuojam `KNOWN BUG` testais.
//
// SVARBU: roomManagers cron/sync (runNow/preview) scrapina AM contacts puslapį
// (httpsGetText). TINKLO call'ų NETESTUOJAM — tikriname tik ADMIN gate (kuris
// suveikia PRIEŠ bet kokį tinklo call'ą, nes requireAdminHook yra pirma eilutė).

let broker: ServiceBroker;
let db: Knex;
let admin: SeededUser;
let user: SeededUser;

const FUTURE = '2030-01-15';

beforeAll(async () => {
  db = makeDb();
  broker = await startTestBroker(['users', 'rooms', 'reservations', 'audit', 'stats', 'export', 'roomManagers']);
});

afterAll(async () => {
  await stopTestBroker(broker);
  await db.destroy();
});

beforeEach(async () => {
  await resetTables(db);
  // resetTables PALIEKA `settings` lentelę (cron kill-switch). Šiame faile
  // testuojam setEnabled/status, tad išvalom ją patys izoliacijai.
  await db('settings').del();
  admin = await seedUser(db, { email: 'admin@am.lt', role: UserRole.ADMIN });
  user = await seedUser(db, { email: 'user@am.lt', role: UserRole.USER });
});

async function seedReservation(opts: {
  userId: string;
  roomId: string;
  deskNumber: number;
  date: string;
}): Promise<void> {
  await db('reservations').insert({
    user_id: opts.userId,
    room_id: opts.roomId,
    desk_number: opts.deskNumber,
    date: opts.date,
  });
}

// ============================================================================
// roomManagers
// ============================================================================
describe('roomManagers · listManagers / addManager / removeManager (ADMIN-only)', () => {
  it('addManager: ADMIN sukuria manual grant + įrašo audit eilutę', async () => {
    const room = await seedRoom(db, { number: '201', floor: 2 });
    const res: any = await callAs(broker, admin, 'roomManagers.addManager', {
      userId: user.id,
      roomId: room.id,
    });
    expect(res).toMatchObject({ ok: true });

    const rows = await db('room_managers');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: user.id, roomId: room.id, source: 'manual' });

    // safeAudit įrašo ADMIN_ADD_ROOM_MANAGER (per audit.log _systemTransition).
    const audit = await db('audit_log').where({ action: 'ADMIN_ADD_ROOM_MANAGER' });
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(admin.id);
  });

  it('addManager: pakartotinis tos pačios poros add → idempotentiškas (onConflict merge), lieka 1 eilutė manual', async () => {
    const room = await seedRoom(db, { number: '201', floor: 2 });
    await callAs(broker, admin, 'roomManagers.addManager', { userId: user.id, roomId: room.id });
    await callAs(broker, admin, 'roomManagers.addManager', { userId: user.id, roomId: room.id });
    const rows = await db('room_managers').where({ user_id: user.id, room_id: room.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('manual');
  });

  it('addManager: nežinomas userId → USER_NOT_FOUND', async () => {
    const room = await seedRoom(db, { number: '201', floor: 2 });
    await expect(
      callAs(broker, admin, 'roomManagers.addManager', {
        userId: '00000000-0000-0000-0000-000000000000',
        roomId: room.id,
      }),
    ).rejects.toMatchObject({ code: 404, type: 'USER_NOT_FOUND' });
  });

  it('addManager: nežinomas roomId → ROOM_NOT_FOUND', async () => {
    await expect(
      callAs(broker, admin, 'roomManagers.addManager', {
        userId: user.id,
        roomId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 404, type: 'ROOM_NOT_FOUND' });
  });

  it('addManager: USER (ne admin) → FORBIDDEN', async () => {
    const room = await seedRoom(db, { number: '201', floor: 2 });
    await expect(
      callAs(broker, user, 'roomManagers.addManager', { userId: user.id, roomId: room.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('addManager: neautentifikuotas → FORBIDDEN', async () => {
    const room = await seedRoom(db, { number: '201', floor: 2 });
    await expect(
      callAs(broker, null, 'roomManagers.addManager', { userId: user.id, roomId: room.id }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('listManagers: ADMIN gauna joined shape (room + user), USER → FORBIDDEN', async () => {
    const room = await seedRoom(db, { number: '305', name: 'Direkcija', floor: 3 });
    await callAs(broker, admin, 'roomManagers.addManager', { userId: user.id, roomId: room.id });

    const list: any[] = await callAs(broker, admin, 'roomManagers.listManagers', {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: 'manual',
      room: { id: room.id, number: '305', name: 'Direkcija' },
      user: { id: user.id, email: 'user@am.lt' },
    });

    await expect(
      callAs(broker, user, 'roomManagers.listManagers', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('listManagers: roomId filtras grąžina tik tos patalpos vadovus', async () => {
    const roomA = await seedRoom(db, { number: '101', floor: 1 });
    const roomB = await seedRoom(db, { number: '202', floor: 2 });
    await callAs(broker, admin, 'roomManagers.addManager', { userId: user.id, roomId: roomA.id });
    await callAs(broker, admin, 'roomManagers.addManager', { userId: user.id, roomId: roomB.id });

    const filtered: any[] = await callAs(broker, admin, 'roomManagers.listManagers', { roomId: roomA.id });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].room.id).toBe(roomA.id);
  });

  it('removeManager: ADMIN ištrina eilutę + įrašo audit; USER → FORBIDDEN; nežinomas id → NOT_FOUND', async () => {
    const room = await seedRoom(db, { number: '201', floor: 2 });
    await callAs(broker, admin, 'roomManagers.addManager', { userId: user.id, roomId: room.id });
    const [{ id: rowId }] = await db('room_managers').select('id');

    // USER negali.
    await expect(
      callAs(broker, user, 'roomManagers.removeManager', { id: rowId }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });

    // ADMIN gali.
    const res: any = await callAs(broker, admin, 'roomManagers.removeManager', { id: rowId });
    expect(res).toMatchObject({ ok: true });
    expect(await db('room_managers')).toHaveLength(0);
    expect(await db('audit_log').where({ action: 'ADMIN_REMOVE_ROOM_MANAGER' })).toHaveLength(1);

    // Pakartotinis trynimas → NOT_FOUND.
    await expect(
      callAs(broker, admin, 'roomManagers.removeManager', { id: rowId }),
    ).rejects.toMatchObject({ code: 404, type: 'NOT_FOUND' });
  });
});

describe('roomManagers · cron toggle + sync gate', () => {
  it('status: default (be settings eilutės) → enabled=true; USER → FORBIDDEN', async () => {
    const res: any = await callAs(broker, admin, 'roomManagers.status', {});
    expect(res).toEqual({ enabled: true });
    await expect(
      callAs(broker, user, 'roomManagers.status', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('setEnabled: ADMIN gali įjungti/išjungti; status atspindi; audit įrašoma', async () => {
    const off: any = await callAs(broker, admin, 'roomManagers.setEnabled', { enabled: false });
    expect(off).toEqual({ enabled: false });
    expect(await callAs(broker, admin, 'roomManagers.status', {})).toEqual({ enabled: false });

    const on: any = await callAs(broker, admin, 'roomManagers.setEnabled', { enabled: true });
    expect(on).toEqual({ enabled: true });
    expect(await callAs(broker, admin, 'roomManagers.status', {})).toEqual({ enabled: true });

    expect((await db('audit_log').where({ action: 'MANAGER_SYNC_TOGGLED' })).length).toBe(2);
  });

  it('setEnabled: USER → FORBIDDEN (nieko nerašo)', async () => {
    await expect(
      callAs(broker, user, 'roomManagers.setEnabled', { enabled: false }),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
    expect(await db('settings').where({ key: 'manager_sync_enabled' })).toHaveLength(0);
  });

  // runNow/preview scrapina AM contacts (httpsGetText) — tinklo NETESTUOJAM.
  // Tikrinam tik kad ADMIN gate suveikia PRIEŠ bet kokį tinklo call'ą
  // (requireAdminHook yra pirma handler'io eilutė).
  it('runNow (sync): USER → FORBIDDEN be tinklo callo', async () => {
    await expect(
      callAs(broker, user, 'roomManagers.runNow', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('preview: USER → FORBIDDEN be tinklo callo', async () => {
    await expect(
      callAs(broker, user, 'roomManagers.preview', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });
});

// ============================================================================
// stats.byFloor — per-aukšto occupancy (fan-out inflation regresijos sargas)
// ============================================================================
describe('stats.byFloor', () => {
  it('agreguoja total=Σ desk_count per aukštą; reservacijos NEdvigubina total (fan-out bug sargas)', async () => {
    // Aukštas 1: dvi patalpos (5 + 4 = 9 vietos).
    const roomA = await seedRoom(db, { number: '101', floor: 1, deskCount: 5 });
    const roomB = await seedRoom(db, { number: '102', floor: 1, deskCount: 4 });
    // Aukštas 2: viena patalpa (3 vietos).
    const roomC = await seedRoom(db, { number: '201', floor: 2, deskCount: 3 });

    const u2 = await seedUser(db, { email: 'u2@am.lt' });
    const u3 = await seedUser(db, { email: 'u3@am.lt' });

    // 3 rezervacijos aukšte 1 (2 roomA, 1 roomB — skirtingi userN dėl user+date unique).
    await seedReservation({ userId: user.id, roomId: roomA.id, deskNumber: 1, date: FUTURE });
    await seedReservation({ userId: u2.id, roomId: roomA.id, deskNumber: 2, date: FUTURE });
    await seedReservation({ userId: u3.id, roomId: roomB.id, deskNumber: 1, date: FUTURE });
    // 1 rezervacija aukšte 2.
    const u4 = await seedUser(db, { email: 'u4@am.lt' });
    await seedReservation({ userId: u4.id, roomId: roomC.id, deskNumber: 1, date: FUTURE });

    const res: any = await callAs(broker, user, 'stats.byFloor', { date: FUTURE });

    // Jei būtų fan-out bug, aukšto 1 total būtų inflate'intas (×rezervacijų sk.).
    expect(res['1']).toEqual({ total: 9, reserved: 3 });
    expect(res['2']).toEqual({ total: 3, reserved: 1 });
  });

  it('reserved skaičiuojamas pagal datą — kita diena turi 0 reserved, bet pilną total', async () => {
    const room = await seedRoom(db, { number: '101', floor: 1, deskCount: 5 });
    await seedReservation({ userId: user.id, roomId: room.id, deskNumber: 1, date: FUTURE });

    const other = '2030-02-20';
    const res: any = await callAs(broker, user, 'stats.byFloor', { date: other });
    expect(res['1']).toEqual({ total: 5, reserved: 0 });
  });

  it('soft-deleted patalpa neįtraukiama nei į total, nei į aukštą', async () => {
    await seedRoom(db, { number: '101', floor: 1, deskCount: 5 });
    const deleted = await seedRoom(db, { number: '999', floor: 9, deskCount: 7 });
    await db('rooms').where({ id: deleted.id }).update({ deleted_at: db.fn.now() });

    const res: any = await callAs(broker, user, 'stats.byFloor', { date: FUTURE });
    expect(res['1']).toEqual({ total: 5, reserved: 0 });
    expect(res['9']).toBeUndefined();
  });
});

// ============================================================================
// audit — listAudit (ADMIN-only) + append-only iš domeno veiksmų
// ============================================================================
describe('audit', () => {
  it('listAudit: USER → FORBIDDEN, neautentifikuotas → FORBIDDEN', async () => {
    await expect(
      callAs(broker, user, 'audit.listAudit', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
    await expect(
      callAs(broker, null, 'audit.listAudit', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('audit.log: ne-internal call (be _systemTransition) → INTERNAL_ONLY 403', async () => {
    await expect(
      callAs(broker, admin, 'audit.log', { action: 'HACK', payload: {} }),
    ).rejects.toMatchObject({ code: 403, type: 'INTERNAL_ONLY' });
  });

  it('domeno veiksmas (createReservation) ĮRAŠO append-only audit eilutę, matomą per listAudit', async () => {
    const room = await seedRoom(db, { number: 'T1', isShared: true, deskCount: 3 });
    await callAs(broker, user, 'reservations.createReservation', {
      roomId: room.id,
      deskNumber: 1,
      date: FUTURE,
    });

    const res: any = await callAs(broker, admin, 'audit.listAudit', {});
    expect(res.total).toBeGreaterThanOrEqual(1);
    const reserve = res.items.find((i: any) => i.action === 'RESERVE');
    expect(reserve).toBeTruthy();
    expect(reserve.userId).toBe(user.id);
  });

  it('listAudit: action filtras + total skaičius teisingi', async () => {
    // Įrašom du skirtingus veiksmus per internal audit.log.
    await broker.call('audit.log', { userId: admin.id, action: 'FOO', payload: { a: 1 } }, {
      meta: { _systemTransition: true },
    } as any);
    await broker.call('audit.log', { userId: admin.id, action: 'BAR', payload: {} }, {
      meta: { _systemTransition: true },
    } as any);
    await broker.call('audit.log', { userId: admin.id, action: 'FOO', payload: {} }, {
      meta: { _systemTransition: true },
    } as any);

    const all: any = await callAs(broker, admin, 'audit.listAudit', {});
    expect(all.total).toBe(3);

    const onlyFoo: any = await callAs(broker, admin, 'audit.listAudit', { action: 'FOO' });
    expect(onlyFoo.total).toBe(2);
    expect(onlyFoo.items.every((i: any) => i.action === 'FOO')).toBe(true);
    // payload persistuotas.
    const withPayload = onlyFoo.items.find((i: any) => i.payload && i.payload.a === 1);
    expect(withPayload).toBeTruthy();
  });
});

// ============================================================================
// export.xlsx — action-lygio authz + buffer (builder turi atskirą unit testą)
// ============================================================================
describe('export.xlsx', () => {
  it('USER → FORBIDDEN, neautentifikuotas → FORBIDDEN', async () => {
    await expect(
      callAs(broker, user, 'export.xlsx', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
    await expect(
      callAs(broker, null, 'export.xlsx', {}),
    ).rejects.toMatchObject({ code: 403, type: 'FORBIDDEN' });
  });

  it('ADMIN gauna realu .xlsx buffer (ZIP "PK" parasas)', async () => {
    await seedRoom(db, { number: '101', floor: 1, deskCount: 4 });
    const out: any = await callAs(broker, admin, 'export.xlsx', {});
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
    expect(buf.length).toBeGreaterThan(0);
    // .xlsx = ZIP archyvas → prasideda 0x50 0x4B ("PK").
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
