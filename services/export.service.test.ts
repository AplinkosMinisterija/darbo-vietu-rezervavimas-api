import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildExportWorkbook,
  type UserRow,
  type RoomRow,
  type AssignmentRow,
} from './export.service';

const users: UserRow[] = [
  { id: 'u1', email: 'jonas@am.lt', displayName: 'Jonas Jonaitis', role: 'USER', deletedAt: null, createdAt: null },
  { id: 'u2', email: 'admin@am.lt', displayName: 'Admina Admin', role: 'ADMIN', deletedAt: null, createdAt: null },
  { id: 'u3', email: 'petras@am.lt', displayName: 'Petras Petraitis', role: 'USER', deletedAt: null, createdAt: null },
  // soft-deleted — must NOT appear in the Vartotojai sheet, but its name must
  // still resolve in the Priskyrimai sheet for the dangling assignment below.
  { id: 'u4', email: 'ona@am.lt', displayName: 'Ona Ištrinta', role: 'USER', deletedAt: new Date(), createdAt: null },
];

const rooms: RoomRow[] = [
  { id: 'r1', number: '101', name: 'Pirmas', floor: 1, deskCount: 4, isShared: false, deletedAt: null, createdAt: null },
  { id: 'r2', number: '202', name: 'Antras', floor: 2, deskCount: 6, isShared: true, deletedAt: null, createdAt: null },
  // soft-deleted — must NOT appear in the Patalpos sheet, but its number must
  // still resolve in the Priskyrimai sheet for the dangling assignment below.
  { id: 'r3', number: '303', name: 'Trečias', floor: 3, deskCount: 2, isShared: false, deletedAt: new Date(), createdAt: null },
];

const assignments: AssignmentRow[] = [
  { userId: 'u1', roomId: 'r2', createdAt: null },
  { userId: 'u1', roomId: 'r1', createdAt: null },
  { userId: 'u3', roomId: 'r1', createdAt: null },
  { userId: 'u3', roomId: 'r3', createdAt: null }, // points at soft-deleted room
  { userId: 'u4', roomId: 'r3', createdAt: null }, // soft-deleted user → soft-deleted room
];

async function reload(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  // Round-trip through a buffer to prove the file is actually valid xlsx,
  // not just an in-memory object.
  const buf = await wb.xlsx.writeBuffer();
  const fresh = new ExcelJS.Workbook();
  await fresh.xlsx.load(buf as Buffer);
  return fresh;
}

function rowValues(sheet: ExcelJS.Worksheet, rowNumber: number): unknown[] {
  // exceljs row.values is 1-indexed with a leading undefined; drop it.
  return (sheet.getRow(rowNumber).values as unknown[]).slice(1);
}

describe('buildExportWorkbook', () => {
  it('produces exactly three named sheets', async () => {
    const wb = await reload(buildExportWorkbook(users, rooms, assignments));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Vartotojai', 'Patalpos', 'Priskyrimai']);
  });

  it('Vartotojai sheet lists every user with room counts and sorted room numbers', async () => {
    const wb = await reload(buildExportWorkbook(users, rooms, assignments));
    const sheet = wb.getWorksheet('Vartotojai')!;
    expect(rowValues(sheet, 1)).toEqual([
      'Vardas, pavardė',
      'El. paštas',
      'Rolė',
      'Priskirta patalpų',
      'Patalpos (nr.)',
    ]);
    // 1 header + 3 ACTIVE users (u4 is soft-deleted → excluded)
    expect(sheet.rowCount).toBe(4);
    // Jonas (u1) has rooms r2(202) + r1(101) -> sorted numeric "101, 202"
    expect(rowValues(sheet, 2)).toEqual(['Jonas Jonaitis', 'jonas@am.lt', 'USER', 2, '101, 202']);
    // Admina (u2) has no rooms
    expect(rowValues(sheet, 3)).toEqual(['Admina Admin', 'admin@am.lt', 'ADMIN', 0, '']);
    // Soft-deleted user must not appear anywhere in the listing.
    const names = [2, 3, 4].map((n) => rowValues(sheet, n)[0]);
    expect(names).not.toContain('Ona Ištrinta');
  });

  it('Patalpos sheet excludes soft-deleted rooms and counts assigned users', async () => {
    const wb = await reload(buildExportWorkbook(users, rooms, assignments));
    const sheet = wb.getWorksheet('Patalpos')!;
    // 1 header + 2 active rooms (r3 is soft-deleted)
    expect(sheet.rowCount).toBe(3);
    // r1 (101): assigned to u1 + u3 = 2 users; isShared=false -> "Ne"
    expect(rowValues(sheet, 2)).toEqual(['101', 'Pirmas', 1, 4, 'Ne', 2]);
    // r2 (202): assigned to u1 = 1 user; isShared=true -> "Taip"
    expect(rowValues(sheet, 3)).toEqual(['202', 'Antras', 2, 6, 'Taip', 1]);
    // 303 (soft-deleted) absent
    const numbers = [rowValues(sheet, 2)[0], rowValues(sheet, 3)[0]];
    expect(numbers).not.toContain('303');
  });

  it('Priskyrimai sheet has one row per assignment and resolves deleted room numbers', async () => {
    const wb = await reload(buildExportWorkbook(users, rooms, assignments));
    const sheet = wb.getWorksheet('Priskyrimai')!;
    // 1 header + 5 assignments
    expect(sheet.rowCount).toBe(6);
    // The dangling assignment (u3 -> r3 soft-deleted) still shows its number.
    const allRows = [2, 3, 4, 5, 6].map((n) => rowValues(sheet, n));
    const petrasDeleted = allRows.find((r) => r[0] === 'Petras Petraitis' && r[2] === '303');
    expect(petrasDeleted).toEqual(['Petras Petraitis', 'petras@am.lt', '303', 'Trečias', 3]);
    // A soft-deleted USER's assignment still resolves to their name + email.
    const onaDeleted = allRows.find((r) => r[0] === 'Ona Ištrinta');
    expect(onaDeleted).toEqual(['Ona Ištrinta', 'ona@am.lt', '303', 'Trečias', 3]);
  });

  it('handles empty data without throwing', async () => {
    const wb = await reload(buildExportWorkbook([], [], []));
    expect(wb.getWorksheet('Vartotojai')!.rowCount).toBe(1); // header only
    expect(wb.getWorksheet('Patalpos')!.rowCount).toBe(1);
    expect(wb.getWorksheet('Priskyrimai')!.rowCount).toBe(1);
  });
});
