'use strict';

import { ServiceBroker } from 'moleculer';
import knex, { Knex } from 'knex';
import knexConfig from '../../knexfile';
import { UserRole } from '../../types/constants';
import type { AuthUser } from '../../utils/auth';

// Statiniai importai (Vite/vitest neišsiresolvina dinaminio require su kintamuoju).
import UsersService from '../../services/users.service';
import RoomsService from '../../services/rooms.service';
import ReservationsService from '../../services/reservations.service';
import AuditService from '../../services/audit.service';
import StatsService from '../../services/stats.service';
import ExportService from '../../services/export.service';
import RoomManagersService from '../../services/roomManagers.service';

const SERVICE_REGISTRY: Record<string, any> = {
  users: UsersService,
  rooms: RoomsService,
  reservations: ReservationsService,
  audit: AuditService,
  stats: StatsService,
  export: ExportService,
  roomManagers: RoomManagersService,
};

// Integration test harness. Boot'ina realų Moleculer broker'į su domeno
// servisais prieš throwaway Postgres (žr. globalSetup.ts), leidžia kviesti
// actions tiesiogiai su suforsuotu `ctx.meta.user` (kaip tai daro gateway
// `authenticate()` produkcijoje).
//
// PASTABA dėl autorizacijos aprėpties: čia kviečiame actions TIESIOGIAI per
// broker'į, todėl gateway-lygio `EndpointType` gate (PUBLIC/USER/ADMIN) NĖRA
// vykdomas — testuojama action-lygio authz (in-handler role/room checks,
// `requireAdminHook` before-hook'ai, ownership). Gateway EndpointType enforcement
// dengiamas atskirai (HTTP-lygio testais, jei reikia).

// Servisai be išorinių/cron priklausomybių — saugu krauti domeno testams.
const DEFAULT_SERVICES = ['users', 'rooms', 'reservations', 'audit', 'stats', 'export'];

export async function startTestBroker(services: string[] = DEFAULT_SERVICES): Promise<ServiceBroker> {
  const broker = new ServiceBroker({ logger: false });
  for (const name of services) {
    const ServiceClass = SERVICE_REGISTRY[name];
    if (!ServiceClass) throw new Error(`Nežinomas servisas test harness'e: ${name}`);
    broker.createService(ServiceClass);
  }
  await broker.start();
  return broker;
}

export async function stopTestBroker(broker: ServiceBroker | undefined): Promise<void> {
  if (broker) await broker.stop();
}

// Vienas bendras knex per test failą (sukuriam beforeAll, destroy afterAll).
export function makeDb(): Knex {
  return knex(knexConfig);
}

// Truncate'ina VISAS dinaminęs domeno lenteles (įsk. rooms — testai patys
// seed'ina, ko jiems reikia). `settings` paliekam (cron kill-switch'ai).
export async function resetTables(db: Knex): Promise<void> {
  await db.raw(
    'TRUNCATE TABLE reservations, user_room_assignments, room_managers, audit_log, users, rooms RESTART IDENTITY CASCADE',
  );
}

export interface SeededUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export async function seedUser(
  db: Knex,
  opts: { email: string; displayName?: string; role?: UserRole; msObjectId?: string },
): Promise<SeededUser> {
  const [row] = await db('users')
    .insert({
      email: opts.email,
      displayName: opts.displayName ?? opts.email.split('@')[0],
      role: opts.role ?? UserRole.USER,
      msObjectId: opts.msObjectId ?? null,
    })
    .returning(['id', 'email', 'displayName', 'role']);
  return row as SeededUser;
}

export interface SeededRoom {
  id: string;
  number: string;
  name: string;
  floor: number;
  deskCount: number;
  isShared: boolean;
}

export async function seedRoom(
  db: Knex,
  opts: { number: string; name?: string; floor?: number; deskCount?: number; isShared?: boolean },
): Promise<SeededRoom> {
  const [row] = await db('rooms')
    .insert({
      number: opts.number,
      name: opts.name ?? `Room ${opts.number}`,
      floor: opts.floor ?? 1,
      deskCount: opts.deskCount ?? 5,
      isShared: opts.isShared ?? false,
    })
    .returning(['id', 'number', 'name', 'floor', 'deskCount', 'isShared']);
  return row as SeededRoom;
}

export async function assignRoom(db: Knex, userId: string, roomId: string): Promise<void> {
  await db('user_room_assignments').insert({ userId, roomId }).onConflict(['userId', 'roomId']).ignore();
}

// Kviečia action'ą su suforsuotu meta.user (null = neautentifikuotas).
export function callAs<T = any>(
  broker: ServiceBroker,
  user: SeededUser | null,
  action: string,
  params: Record<string, any> = {},
): Promise<T> {
  const metaUser: AuthUser | undefined = user
    ? ({ id: user.id, email: user.email, displayName: user.displayName, role: user.role } as AuthUser)
    : undefined;
  return broker.call<T, Record<string, any>>(action, params, { meta: { user: metaUser } });
}
