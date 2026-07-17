'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import ExcelJS from 'exceljs';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { AuthUser, requireAdminHook } from '../utils/auth';

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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

  const denominator = capacity * workdayCount;
  const pct = denominator > 0 ? Math.round((workdayReserved / denominator) * 1000) / 10 : 0;

  return { totalReservations: total, workdayAvgOccupancyPct: pct, peakDay: peak };
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
 * in export.service.ts).
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

/**
 * Floor-level aggregation for the "Apžvalga" dashboard tab. Single SQL
 * round-trip:
 *
 *   - `total`     — Σ rooms.desk_count grouped by floor (active rooms only)
 *   - `reserved`  — COUNT reservations on the given date, joined per-room
 *
 * Read-only; not a DbService — no shape to mirror beyond the response.
 */
@Service({
  name: 'stats',
})
export default class StatsService extends moleculer.Service {
  /**
   * Returns `{ '1': { total, reserved }, '2': { ... }, ... }` for every
   * floor that has at least one non-deleted room. The FE expects string
   * keys (object spread over floor numbers); we serialise as JSON object
   * with string-coerced keys.
   */
  @Action({
    rest: 'GET /',
    auth: true,
    // Apžvalga (per-floor occupancy) is available to every authenticated
    // user — it shows only aggregate desk counts, no per-person PII.
    types: [EndpointType.USER],
    params: {
      date: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async byFloor(ctx: Context<{ date: string }, UserAuthMeta>) {
    // Two SEPARATE aggregations. Joining reservations into the desk-count SUM
    // fans the room row out once per reservation, so SUM(desk_count) would be
    // multiplied by the bookings-per-room — the "458 vietų" inflation bug.
    const totals = await db('rooms')
      .whereNull('deleted_at')
      .groupBy('floor')
      .orderBy('floor', 'asc')
      .select('floor', db.raw('SUM(desk_count)::int AS total'));

    const reservedRows = await db('reservations as res')
      .join('rooms as r', 'r.id', 'res.room_id')
      .whereNull('r.deleted_at')
      .where('res.date', ctx.params.date)
      .groupBy('r.floor')
      .select('r.floor', db.raw('COUNT(res.id)::int AS reserved'));

    const reservedByFloor = new Map<string, number>(
      (reservedRows as any[]).map((r) => [String(r.floor), Number(r.reserved) || 0]),
    );

    const result: Record<string, { total: number; reserved: number }> = {};
    for (const row of totals as any[]) {
      const f = String(row.floor);
      result[f] = { total: Number(row.total) || 0, reserved: reservedByFloor.get(f) ?? 0 };
    }
    return result;
  }

  /**
   * Admin dashboard aggregate for an arbitrary [from, to] date range. One
   * response powers the whole "Statistika" page; week/month bucketing is done
   * client-side from `days`, so granularity switches need no refetch.
   *
   * Known limitation (by design): capacity reflects the CURRENT room
   * configuration — historical desk_count changes aren't stored, so occupancy
   * percentages for past periods are computed against today's capacity.
   */
  @Action({
    rest: 'GET /admin',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      from: { type: 'string', pattern: DATE_PATTERN },
      to: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async adminOverview(ctx: Context<{ from: string; to: string }, UserAuthMeta>) {
    // Defense in depth: the gateway ADMIN gate doesn't fire on internal
    // ctx.call invocations — the hook does (mirrors export.service.ts).
    requireAdminHook(ctx);
    const { from, to } = ctx.params;
    assertValidRange(from, to);

    const [capacity, days, floorTotals, floorReserved, topRooms, users, rangeRows] =
      await Promise.all([
        this.queryCapacity(),
        this.queryDaySeries(from, to),
        db('rooms')
          .whereNull('deleted_at')
          .groupBy('floor')
          .orderBy('floor', 'asc')
          .select('floor', db.raw('SUM(desk_count)::int AS capacity')),
        // Separate aggregation from the capacity SUM — joining reservations
        // into it would fan rooms out per booking (the "458 vietų" bug).
        db('reservations as res')
          .join('rooms as r', 'r.id', 'res.room_id')
          .whereNull('r.deleted_at')
          .whereBetween('res.date', [from, to])
          .groupBy('r.floor')
          .select('r.floor', db.raw('COUNT(res.id)::int AS reserved')),
        db('reservations as res')
          .join('rooms as r', 'r.id', 'res.room_id')
          .whereNull('r.deleted_at')
          .whereBetween('res.date', [from, to])
          .groupBy('r.id', 'r.number', 'r.name', 'r.desk_count')
          .select(
            'r.id as roomId',
            'r.number',
            'r.name',
            db.raw('r.desk_count::int AS "deskCount"'),
            db.raw('COUNT(res.id)::int AS reserved'),
          )
          .orderBy([
            { column: 'reserved', order: 'desc' },
            { column: 'r.number', order: 'asc' },
          ])
          .limit(10),
        this.queryUserCounts(from, to),
        db('reservations').select(
          db.raw(
            `to_char(MIN(date), 'YYYY-MM-DD') AS min_date, to_char(MAX(date), 'YYYY-MM-DD') AS max_date`,
          ),
        ),
      ]);

    const reservedFloorMap = new Map<string, number>(
      (floorReserved as any[]).map((r) => [String(r.floor), Number(r.reserved) || 0]),
    );
    const byFloor = (floorTotals as any[]).map((r) => ({
      floor: Number(r.floor),
      capacity: Number(r.capacity) || 0,
      reserved: reservedFloorMap.get(String(r.floor)) ?? 0,
    }));

    const range = (rangeRows as any[])[0] ?? {};

    return {
      capacity,
      range: { minDate: range.minDate ?? null, maxDate: range.maxDate ?? null },
      days,
      byFloor,
      topRooms: (topRooms as any[]).map((r) => ({
        roomId: String(r.roomId),
        number: String(r.number),
        name: String(r.name ?? ''),
        deskCount: Number(r.deskCount) || 0,
        reserved: Number(r.reserved) || 0,
      })),
      kpi: {
        ...computeKpis(days, capacity),
        reservingUsers: users.reservingUsers,
        activeUsers: users.activeUsers,
      },
    };
  }

  /**
   * Occupancy Excel export for the same [from, to] range as `adminOverview`.
   * Returns the workbook as an attachment download (Buffer +
   * `$responseHeaders`, mirroring export.service.ts).
   */
  @Action({
    rest: 'GET /admin/xlsx',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      from: { type: 'string', pattern: DATE_PATTERN },
      to: { type: 'string', pattern: DATE_PATTERN },
    },
  })
  async adminXlsx(ctx: Context<{ from: string; to: string }, UserAuthMeta>) {
    requireAdminHook(ctx);
    const { from, to } = ctx.params;
    assertValidRange(from, to);

    const [capacity, days, users, roomRows, roomReserved, detail] = await Promise.all([
      this.queryCapacity(),
      this.queryDaySeries(from, to),
      this.queryUserCounts(from, to),
      db('rooms')
        .whereNull('deleted_at')
        .orderBy([
          { column: 'floor', order: 'asc' },
          { column: 'number', order: 'asc' },
        ])
        .select('id', 'number', 'name', 'floor', db.raw('desk_count::int AS "deskCount"')),
      db('reservations as res')
        .join('rooms as r', 'r.id', 'res.room_id')
        .whereNull('r.deleted_at')
        .whereBetween('res.date', [from, to])
        .groupBy('res.room_id')
        .select('res.roomId', db.raw('COUNT(res.id)::int AS reserved')),
      db('reservations as res')
        .join('rooms as r', 'r.id', 'res.room_id')
        .join('users as u', 'u.id', 'res.user_id')
        .whereNull('r.deleted_at')
        .whereBetween('res.date', [from, to])
        .orderBy([
          { column: 'res.date', order: 'asc' },
          { column: 'u.displayName', order: 'asc' },
        ])
        .select(
          db.raw(`to_char(res.date, 'YYYY-MM-DD') AS date`),
          'u.displayName as displayName',
          'u.email as email',
          'r.number as roomNumber',
          'r.name as roomName',
          'res.deskNumber as deskNumber',
        ),
    ]);

    const reservedByRoom = new Map<string, number>(
      (roomReserved as any[]).map((r) => [String(r.roomId), Number(r.reserved) || 0]),
    );
    const rooms = (roomRows as any[]).map((r) => ({
      number: String(r.number),
      name: String(r.name ?? ''),
      floor: Number(r.floor),
      deskCount: Number(r.deskCount) || 0,
      reserved: reservedByRoom.get(String(r.id)) ?? 0,
    }));

    const workbook = buildStatsWorkbook({
      from,
      to,
      capacity,
      days,
      rooms,
      kpi: {
        ...computeKpis(days, capacity),
        reservingUsers: users.reservingUsers,
        activeUsers: users.activeUsers,
      },
      detail: (detail as any[]).map((r) => ({
        date: String(r.date),
        displayName: String(r.displayName ?? ''),
        email: String(r.email ?? ''),
        roomNumber: String(r.roomNumber),
        roomName: String(r.roomName ?? ''),
        deskNumber: Number(r.deskNumber) || 0,
      })),
    });
    const buffer = await workbook.xlsx.writeBuffer();

    ctx.meta.$responseHeaders = {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="uzimtumo-ataskaita-${from}--${to}.xlsx"`,
    };

    return buffer;
  }

  /** Σ desk_count over active rooms — today's single-day capacity. */
  @Method
  async queryCapacity(): Promise<number> {
    const rows = await db('rooms')
      .whereNull('deleted_at')
      .select(db.raw('COALESCE(SUM(desk_count), 0)::int AS capacity'));
    return Number((rows as any[])[0]?.capacity) || 0;
  }

  /** Per-day reserved counts (active rooms only), gaps filled with 0. */
  @Method
  async queryDaySeries(from: string, to: string): Promise<DayPoint[]> {
    const rows = await db('reservations as res')
      .join('rooms as r', 'r.id', 'res.room_id')
      .whereNull('r.deleted_at')
      .whereBetween('res.date', [from, to])
      .groupByRaw(`to_char(res.date, 'YYYY-MM-DD')`)
      .select(db.raw(`to_char(res.date, 'YYYY-MM-DD') AS ds, COUNT(res.id)::int AS reserved`));
    const reservedByDate = new Map<string, number>(
      (rows as any[]).map((r) => [String(r.ds), Number(r.reserved) || 0]),
    );
    return buildDaySeries(from, to, reservedByDate);
  }

  /** Distinct users reserving in range vs all active users. */
  @Method
  async queryUserCounts(
    from: string,
    to: string,
  ): Promise<{ reservingUsers: number; activeUsers: number }> {
    const [reservingRows, activeRows] = await Promise.all([
      db('reservations as res')
        .join('rooms as r', 'r.id', 'res.room_id')
        .whereNull('r.deleted_at')
        .whereBetween('res.date', [from, to])
        .select(db.raw('COUNT(DISTINCT res.user_id)::int AS reserving')),
      db('users').whereNull('deleted_at').select(db.raw('COUNT(*)::int AS active')),
    ]);
    return {
      reservingUsers: Number((reservingRows as any[])[0]?.reserving) || 0,
      activeUsers: Number((activeRows as any[])[0]?.active) || 0,
    };
  }
}
