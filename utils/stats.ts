'use strict';

import { Errors } from 'moleculer';
import ExcelJS from 'exceljs';

export interface DayPoint {
  date: string; // 'YYYY-MM-DD'
  reserved: number;
}

/**
 * Expands a [from, to] date range into one entry per calendar day, taking
 * counts from `reservedByDate` and filling gaps with 0. Iterates in UTC so
 * local DST switches can never skip or double a day.
 */
export function buildDaySeries(
  from: string,
  to: string,
  reservedByDate: Map<string, number>,
): DayPoint[] {
  const days: DayPoint[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.push({ date, reserved: reservedByDate.get(date) ?? 0 });
  }
  return days;
}

export interface StatsKpi {
  totalReservations: number;
  /** Mean occupancy over Mon–Fri days only, percent 0–100, 1 decimal. */
  workdayAvgOccupancyPct: number;
  /** First day holding the range maximum; null when nothing is reserved. */
  peakDay: { date: string; reserved: number } | null;
}

export function computeKpis(days: DayPoint[], capacity: number): StatsKpi {
  let total = 0;
  let workdayReserved = 0;
  let workdayCount = 0;
  let peak: StatsKpi['peakDay'] = null;

  for (const d of days) {
    total += d.reserved;
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) {
      workdayReserved += d.reserved;
      workdayCount += 1;
    }
    if (d.reserved > 0 && (!peak || d.reserved > peak.reserved)) {
      peak = { date: d.date, reserved: d.reserved };
    }
  }

  return {
    totalReservations: total,
    workdayAvgOccupancyPct: pct(workdayReserved, capacity * workdayCount),
    peakDay: peak,
  };
}

const WEEKDAY_NAMES_LT = [
  'Pirmadienis',
  'Antradienis',
  'Trečiadienis',
  'Ketvirtadienis',
  'Penktadienis',
  'Šeštadienis',
  'Sekmadienis',
];

/** 0..6 = Mon..Sun for a 'YYYY-MM-DD' date. */
function isoWeekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Percentage 0–100 rounded to 1 decimal; 0 when the denominator is 0. */
function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface StatsReservationDetailRow {
  date: string;
  displayName: string;
  email: string;
  roomNumber: string;
  roomName: string;
  deskNumber: number;
}

export interface StatsWorkbookInput {
  from: string;
  to: string;
  capacity: number;
  days: DayPoint[];
  rooms: { number: string; name: string; floor: number; deskCount: number; reserved: number }[];
  kpi: StatsKpi & { reservingUsers: number; activeUsers: number };
  detail: StatsReservationDetailRow[];
}

/**
 * Pure transform: occupancy aggregates → five-sheet workbook. No DB / no
 * Moleculer context, unit-tested in isolation (mirrors buildExportWorkbook
 * in exportWorkbook.ts).
 */
export function buildStatsWorkbook(input: StatsWorkbookInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const periodDays = input.days.length;

  // --- Sheet 1: Suvestinė --------------------------------------------------
  const summary = workbook.addWorksheet('Suvestinė');
  summary.columns = [{ width: 34 }, { width: 26 }];
  const peak = input.kpi.peakDay;
  const summaryRows: Array<[string, string | number]> = [
    ['Laikotarpis', `${input.from} – ${input.to}`],
    ['Darbo vietų (talpa)', input.capacity],
    ['Rezervacijų iš viso', input.kpi.totalReservations],
    ['Vid. užimtumas darbo dienomis (%)', input.kpi.workdayAvgOccupancyPct],
    ['Rezervavo naudotojų', `${input.kpi.reservingUsers} iš ${input.kpi.activeUsers}`],
    ['Pikinė diena', peak ? `${peak.date} (${peak.reserved})` : '—'],
  ];
  for (const r of summaryRows) summary.addRow(r);
  summary.getColumn(1).font = { bold: true };

  // --- Sheet 2: Pagal dieną ------------------------------------------------
  const daysSheet = workbook.addWorksheet('Pagal dieną');
  daysSheet.views = [{ state: 'frozen', ySplit: 1 }];
  daysSheet.columns = [
    { header: 'Data', key: 'date', width: 14 },
    { header: 'Savaitės diena', key: 'weekday', width: 16 },
    { header: 'Rezervuota', key: 'reserved', width: 12 },
    { header: 'Talpa', key: 'capacity', width: 10 },
    { header: 'Užimtumas %', key: 'pct', width: 14 },
  ];
  for (const d of input.days) {
    daysSheet.addRow({
      date: d.date,
      weekday: WEEKDAY_NAMES_LT[isoWeekdayIndex(d.date)],
      reserved: d.reserved,
      capacity: input.capacity,
      pct: pct(d.reserved, input.capacity),
    });
  }

  // --- Sheet 3: Pagal kabinetą ----------------------------------------------
  const roomsSheet = workbook.addWorksheet('Pagal kabinetą');
  roomsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  roomsSheet.columns = [
    { header: 'Kabineto nr.', key: 'number', width: 14 },
    { header: 'Pavadinimas', key: 'name', width: 30 },
    { header: 'Aukštas', key: 'floor', width: 10 },
    { header: 'Darbo vietų', key: 'deskCount', width: 12 },
    { header: 'Rezervacijų', key: 'reserved', width: 12 },
    { header: 'Užimtumas %', key: 'pct', width: 14 },
  ];
  for (const r of input.rooms) {
    roomsSheet.addRow({
      number: r.number,
      name: r.name,
      floor: r.floor,
      deskCount: r.deskCount,
      reserved: r.reserved,
      pct: pct(r.reserved, r.deskCount * periodDays),
    });
  }

  // --- Sheet 4: Pagal savaitės dieną -----------------------------------------
  const weekdaySheet = workbook.addWorksheet('Pagal savaitės dieną');
  weekdaySheet.views = [{ state: 'frozen', ySplit: 1 }];
  weekdaySheet.columns = [
    { header: 'Savaitės diena', key: 'weekday', width: 16 },
    { header: 'Dienų sk.', key: 'count', width: 10 },
    { header: 'Vid. rezervuota', key: 'avgReserved', width: 15 },
    { header: 'Vid. užimtumas %', key: 'avgPct', width: 16 },
  ];
  const byWeekday = new Map<number, { count: number; reserved: number }>();
  for (const d of input.days) {
    const idx = isoWeekdayIndex(d.date);
    const agg = byWeekday.get(idx) ?? { count: 0, reserved: 0 };
    agg.count += 1;
    agg.reserved += d.reserved;
    byWeekday.set(idx, agg);
  }
  for (let idx = 0; idx < 7; idx++) {
    const agg = byWeekday.get(idx);
    if (!agg) continue; // list only weekdays that occur in the range
    weekdaySheet.addRow({
      weekday: WEEKDAY_NAMES_LT[idx],
      count: agg.count,
      avgReserved: round1(agg.reserved / agg.count),
      avgPct: pct(agg.reserved, input.capacity * agg.count),
    });
  }

  // --- Sheet 5: Rezervacijos -------------------------------------------------
  const detailSheet = workbook.addWorksheet('Rezervacijos');
  detailSheet.views = [{ state: 'frozen', ySplit: 1 }];
  detailSheet.columns = [
    { header: 'Data', key: 'date', width: 14 },
    { header: 'Vartotojas', key: 'displayName', width: 30 },
    { header: 'El. paštas', key: 'email', width: 34 },
    { header: 'Kabineto nr.', key: 'roomNumber', width: 14 },
    { header: 'Kabinetas', key: 'roomName', width: 30 },
    { header: 'Stalo nr.', key: 'deskNumber', width: 10 },
  ];
  for (const row of input.detail) detailSheet.addRow(row);

  for (const sheet of [daysSheet, roomsSheet, weekdaySheet, detailSheet]) {
    sheet.getRow(1).eachCell((c) => {
      c.font = { bold: true };
    });
  }

  return workbook;
}

/** Inclusive day span cap for admin stats queries — ~5 years. */
const MAX_RANGE_DAYS = 1827;

/**
 * Validates an admin stats [from, to] range (shape is already gateway-checked
 * against DATE_PATTERN). Throws 400 INVALID_RANGE on from > to or a span
 * larger than MAX_RANGE_DAYS.
 */
export function assertValidRange(from: string, to: string): void {
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!(spanDays >= 1 && spanDays <= MAX_RANGE_DAYS)) {
    throw new Errors.MoleculerClientError('Neteisingas laikotarpis.', 400, 'INVALID_RANGE', {
      from,
      to,
      maxDays: MAX_RANGE_DAYS,
    });
  }
}
