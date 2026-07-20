'use strict';

import ExcelJS from 'exceljs';

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  deletedAt: Date | string | null;
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
 * isolation (see exportWorkbook.test.ts).
 *
 * Soft-deleted rooms/users are excluded from their respective listings, but
 * kept in the lookup maps so an assignment still pointing at a deleted room
 * or user resolves to a readable label instead of a blank cell.
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
    if (u.deletedAt) continue; // listing = active users only
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
