'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import ExcelJS from 'exceljs';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';

/**
 * Shared Knex handle. The export is a read-only snapshot across three tables
 * (users, rooms, user_room_assignments) joined in memory — a single DbService
 * collection doesn't fit, so we query Knex directly.
 */
const db = knex(knexConfig);

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
  // moleculer-web reads these to stream a binary response instead of JSON.
  $responseType?: string;
  $responseHeaders?: Record<string, string>;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: Date | string | null;
}

export interface RoomRow {
  id: string;
  number: string;
  name: string;
  floor: number;
  deskCount: number;
  isShared: boolean;
  deletedAt: Date | string | null;
  createdAt: Date | string | null;
}

export interface AssignmentRow {
  userId: string;
  roomId: string;
  createdAt: Date | string | null;
}

/**
 * Pure transform: turn the three table snapshots into a three-sheet
 * workbook. No DB / no Moleculer context, so it's unit-testable in
 * isolation (see export.service.test.ts).
 *
 * Soft-deleted rooms are excluded from the "Patalpos" listing, but kept in
 * the lookup map so an assignment still pointing at a deleted room resolves
 * to a readable label instead of a blank cell.
 */
export function buildExportWorkbook(
  users: UserRow[],
  rooms: RoomRow[],
  assignments: AssignmentRow[],
): ExcelJS.Workbook {
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const userById = new Map(users.map((u) => [u.id, u]));

  // userId -> sorted room numbers; roomId -> assigned user count.
  const roomsByUser = new Map<string, string[]>();
  const userCountByRoom = new Map<string, number>();
  for (const a of assignments) {
    const room = roomById.get(a.roomId);
    const label = room ? room.number : '(ištrinta)';
    const list = roomsByUser.get(a.userId) ?? [];
    list.push(label);
    roomsByUser.set(a.userId, list);
    userCountByRoom.set(a.roomId, (userCountByRoom.get(a.roomId) ?? 0) + 1);
  }
  for (const list of roomsByUser.values()) {
    list.sort((x, y) => x.localeCompare(y, 'lt', { numeric: true }));
  }

  const workbook = new ExcelJS.Workbook();

  // --- Sheet 1: Vartotojai -----------------------------------------------
  const usersSheet = workbook.addWorksheet('Vartotojai');
  usersSheet.views = [{ state: 'frozen', ySplit: 1 }];
  usersSheet.columns = [
    { header: 'Vardas, pavardė', key: 'displayName', width: 32 },
    { header: 'El. paštas', key: 'email', width: 36 },
    { header: 'Rolė', key: 'role', width: 12 },
    { header: 'Priskirta patalpų', key: 'roomCount', width: 16 },
    { header: 'Patalpos (nr.)', key: 'roomNumbers', width: 40 },
  ];
  for (const u of users) {
    const roomNumbers = roomsByUser.get(u.id) ?? [];
    usersSheet.addRow({
      displayName: u.displayName,
      email: u.email,
      role: u.role,
      roomCount: roomNumbers.length,
      roomNumbers: roomNumbers.join(', '),
    });
  }

  // --- Sheet 2: Patalpos -------------------------------------------------
  const roomsSheet = workbook.addWorksheet('Patalpos');
  roomsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  roomsSheet.columns = [
    { header: 'Patalpos nr.', key: 'number', width: 14 },
    { header: 'Pavadinimas', key: 'name', width: 32 },
    { header: 'Aukštas', key: 'floor', width: 10 },
    { header: 'Darbo vietų sk.', key: 'deskCount', width: 16 },
    { header: 'Bendra patalpa', key: 'isShared', width: 16 },
    { header: 'Priskirta naudotojų', key: 'userCount', width: 18 },
  ];
  for (const r of rooms) {
    if (r.deletedAt) continue; // listing = active rooms only
    roomsSheet.addRow({
      number: r.number,
      name: r.name,
      floor: r.floor,
      deskCount: r.deskCount,
      isShared: r.isShared ? 'Taip' : 'Ne',
      userCount: userCountByRoom.get(r.id) ?? 0,
    });
  }

  // --- Sheet 3: Priskyrimai (flat user↔room) -----------------------------
  const assignSheet = workbook.addWorksheet('Priskyrimai');
  assignSheet.views = [{ state: 'frozen', ySplit: 1 }];
  assignSheet.columns = [
    { header: 'Vartotojas', key: 'displayName', width: 32 },
    { header: 'El. paštas', key: 'email', width: 36 },
    { header: 'Patalpos nr.', key: 'roomNumber', width: 14 },
    { header: 'Patalpos pavadinimas', key: 'roomName', width: 32 },
    { header: 'Aukštas', key: 'floor', width: 10 },
  ];
  // Stable order: by user name, then room number.
  const sortedAssignments = [...assignments].sort((a, b) => {
    const ua = userById.get(a.userId)?.displayName ?? '';
    const ub = userById.get(b.userId)?.displayName ?? '';
    if (ua !== ub) return ua.localeCompare(ub, 'lt');
    const ra = roomById.get(a.roomId)?.number ?? '';
    const rb = roomById.get(b.roomId)?.number ?? '';
    return ra.localeCompare(rb, 'lt', { numeric: true });
  });
  for (const a of sortedAssignments) {
    const u = userById.get(a.userId);
    const r = roomById.get(a.roomId);
    assignSheet.addRow({
      displayName: u?.displayName ?? '(ištrintas)',
      email: u?.email ?? '',
      roomNumber: r?.number ?? '(ištrinta)',
      roomName: r?.name ?? '',
      floor: r?.floor ?? '',
    });
  }

  // Bold header row on every sheet.
  for (const sheet of [usersSheet, roomsSheet, assignSheet]) {
    sheet.getRow(1).eachCell((c) => {
      c.font = { bold: true };
    });
  }

  return workbook;
}

/**
 * Admin-only data export. Produces a single .xlsx workbook with three sheets:
 *
 *   - "Vartotojai"  — every user + how many / which rooms they're assigned to
 *   - "Patalpos"    — every active room + how many users are assigned
 *   - "Priskyrimai" — flat user↔room assignment list (one row per pair)
 *
 * Reservations are intentionally excluded (per requirements). Read-only.
 * Pattern (Buffer return + `$responseHeaders`) mirrors the working Excel
 * export in biip-zvejyba-api.
 */
@Service({
  name: 'export',
})
export default class ExportService extends moleculer.Service {
  /**
   * GET /api/export/xlsx — returns the workbook as an attachment download.
   * ADMIN gate is enforced both at the gateway (`types`) and via the
   * `requireAdminHook` call, matching the rest of the codebase's defense
   * in depth (internal `ctx.call` bypasses the gateway authorize()).
   */
  @Action({
    rest: 'GET /xlsx',
    auth: true,
    types: [EndpointType.ADMIN],
  })
  async xlsx(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);

    // Snapshot all three tables (rooms incl. soft-deleted — `buildExportWorkbook`
    // filters the listing but keeps deleted rooms in its lookup map).
    const [users, rooms, assignments] = await Promise.all([
      db<UserRow>('users').orderBy('displayName', 'asc'),
      db<RoomRow>('rooms').orderBy([
        { column: 'floor', order: 'asc' },
        { column: 'number', order: 'asc' },
      ]),
      db<AssignmentRow>('user_room_assignments').select('userId', 'roomId', 'createdAt'),
    ]);

    const workbook = buildExportWorkbook(users, rooms, assignments);
    const buffer = await workbook.xlsx.writeBuffer();

    ctx.meta.$responseHeaders = {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${this.buildFilename()}"`,
    };

    return buffer;
  }

  /**
   * `darbo-vietu-eksportas-YYYY-MM-DD.xlsx`. Date in the name so a user can
   * keep several exports side by side without overwriting.
   */
  @Method
  buildFilename(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `darbo-vietu-eksportas-${yyyy}-${mm}-${dd}.xlsx`;
  }
}
