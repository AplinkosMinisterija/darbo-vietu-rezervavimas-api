'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import ExcelJS from 'exceljs';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';

/**
 * Užimtumo (occupancy) eksportas. Atskiras servisas nuo `export.service.ts`
 * (kuris eksportuoja vartotojus/patalpas/priskyrimus) — čia skaičiuojame,
 * KIEK darbo vietų buvo rezervuota per pasirinktą periodą, procentais.
 *
 * Užimtumas = COUNT(reservations) / SUM(rooms.desk_count) tai dienai.
 * Logika atkartoja `stats.service.ts` byFloor: dvi ATSKIROS agregacijos, kad
 * join'as neišpūstų desk_count sumos (žr. "458 vietų" bug'ą stats servise).
 *
 * Grynas Knex — read-only snapshot per kelias dienas, netelpa į vieną
 * DbService kolekciją.
 */
const db = knex(knexConfig);

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type OccupancyPeriod = 'day' | 'week' | 'month';

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
  $responseType?: string;
  $responseHeaders?: Record<string, string>;
}

/** Vienos darbo vietų kapaciteto eilutės (aukštas -> vietų sk.). */
export interface FloorCapacityRow {
  floor: number;
  total: number; // Σ desk_count aktyvioms patalpoms tame aukšte
}

/** Rezervacijų skaičius vienai dienai + aukštui. */
export interface ReservedRow {
  date: string; // YYYY-MM-DD
  floor: number;
  reserved: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseYmdUTC(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function addDaysUTC(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Pirmadienis tos ISO savaitės, kurioje yra `d`. */
function startOfWeekUTC(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sk, 1=Pr, ...
  const diff = day === 0 ? -6 : 1 - day;
  return addDaysUTC(d, diff);
}

function isWeekendUTC(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Pagal periodą + atskaitos datą grąžina [nuo, iki] (imtinai, YYYY-MM-DD).
 *   day   — ta pati diena
 *   week  — pirmadienis..sekmadienis
 *   month — mėnesio 1 d. .. paskutinė d.
 */
export function resolveRange(
  period: OccupancyPeriod,
  date: string,
): { from: string; to: string } {
  const base = parseYmdUTC(date);
  if (period === 'day') {
    return { from: ymd(base), to: ymd(base) };
  }
  if (period === 'week') {
    const mon = startOfWeekUTC(base);
    return { from: ymd(mon), to: ymd(addDaysUTC(mon, 6)) };
  }
  // month
  const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
  return { from: ymd(first), to: ymd(last) };
}

/** Visų dienų (YYYY-MM-DD) sąrašas [from..to] imtinai. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = parseYmdUTC(from);
  const end = parseYmdUTC(to);
  while (cur.getTime() <= end.getTime()) {
    out.push(ymd(cur));
    cur = addDaysUTC(cur, 1);
  }
  return out;
}

const MONTH_NAMES_LT = [
  'sausis', 'vasaris', 'kovas', 'balandis', 'gegužė', 'birželis',
  'liepa', 'rugpjūtis', 'rugsėjis', 'spalis', 'lapkritis', 'gruodis',
];
const WEEKDAY_LT = ['Sekmadienis', 'Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis'];

/**
 * Grynas transformas: kapacitetas + rezervacijos -> užimtumo workbook'as.
 * Be DB / be Moleculer — unit-testuojamas (žr. occupancyExport.service.test.ts).
 *
 * Du sheet'ai:
 *   "Suvestinė"   — bendras užimtumas kiekvienai periodo dienai
 *   "Pagal aukštą"— užimtumas dieną × aukštą (detaliau)
 *
 * `includeWeekends=false` (numatyta) — savaitgaliai praleidžiami, nes AM
 * darbo vietos rezervuojamos tik darbo dienomis (užimtumas 0% iškreiptų vidurkį).
 */
export function buildOccupancyWorkbook(
  period: OccupancyPeriod,
  from: string,
  to: string,
  capacities: FloorCapacityRow[],
  reservedRows: ReservedRow[],
  opts: { includeWeekends?: boolean } = {},
): ExcelJS.Workbook {
  const includeWeekends = opts.includeWeekends ?? false;

  const totalCapacity = capacities.reduce((s, c) => s + (c.total || 0), 0);
  const floors = [...capacities].sort((a, b) => a.floor - b.floor);
  const capByFloor = new Map(floors.map((c) => [c.floor, c.total]));

  // (date|floor) -> reserved
  const reservedByKey = new Map<string, number>();
  // date -> reserved (visi aukštai)
  const reservedByDate = new Map<string, number>();
  for (const r of reservedRows) {
    reservedByKey.set(`${r.date}|${r.floor}`, (reservedByKey.get(`${r.date}|${r.floor}`) ?? 0) + r.reserved);
    reservedByDate.set(r.date, (reservedByDate.get(r.date) ?? 0) + r.reserved);
  }

  const allDays = eachDay(from, to);
  const days = includeWeekends
    ? allDays
    : allDays.filter((d) => !isWeekendUTC(parseYmdUTC(d)));

  const pct = (reserved: number, total: number) =>
    total > 0 ? reserved / total : 0;

  const workbook = new ExcelJS.Workbook();

  // --- Sheet 1: Suvestinė --------------------------------------------------
  const sum = workbook.addWorksheet('Suvestinė');
  sum.views = [{ state: 'frozen', ySplit: 3 }];

  const periodLabel =
    period === 'day' ? 'Diena' : period === 'week' ? 'Savaitė' : 'Mėnuo';
  sum.mergeCells('A1:D1');
  sum.getCell('A1').value = `Darbo vietų užimtumas — ${periodLabel}`;
  sum.getCell('A1').font = { bold: true, size: 14 };
  sum.mergeCells('A2:D2');
  sum.getCell('A2').value = `Laikotarpis: ${from} – ${to}   ·   Iš viso darbo vietų: ${totalCapacity}`;
  sum.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };

  const sumHeaderRow = 3;
  sum.getRow(sumHeaderRow).values = ['Data', 'Savaitės diena', 'Užimta vietų', 'Užimtumas %'];
  sum.columns = [
    { key: 'date', width: 14 },
    { key: 'weekday', width: 16 },
    { key: 'reserved', width: 14 },
    { key: 'pct', width: 14 },
  ];

  let periodReservedSum = 0;
  let periodDayCount = 0;
  for (const d of days) {
    const reserved = reservedByDate.get(d) ?? 0;
    const p = pct(reserved, totalCapacity);
    periodReservedSum += reserved;
    periodDayCount += 1;
    const row = sum.addRow({
      date: d,
      weekday: WEEKDAY_LT[parseYmdUTC(d).getUTCDay()],
      reserved,
      pct: p,
    });
    row.getCell('pct').numFmt = '0.0%';
  }

  // Vidurkio eilutė.
  const avgReserved = periodDayCount > 0 ? periodReservedSum / periodDayCount : 0;
  const avgPct = pct(avgReserved, totalCapacity);
  const avgRow = sum.addRow({
    date: 'Vidurkis',
    weekday: '',
    reserved: Math.round(avgReserved * 10) / 10,
    pct: avgPct,
  });
  avgRow.font = { bold: true };
  avgRow.getCell('pct').numFmt = '0.0%';

  // --- Sheet 2: Pagal aukštą ----------------------------------------------
  const byFloor = workbook.addWorksheet('Pagal aukštą');
  byFloor.views = [{ state: 'frozen', ySplit: 2, xSplit: 1 }];

  byFloor.mergeCells(1, 1, 1, floors.length + 1);
  byFloor.getCell('A1').value = 'Užimtumas % pagal aukštą';
  byFloor.getCell('A1').font = { bold: true, size: 12 };

  // Antraštė: Data | Aukštas 1 | Aukštas 2 | ...
  const headerRow = byFloor.getRow(2);
  headerRow.getCell(1).value = 'Data';
  floors.forEach((f, i) => {
    const cell = headerRow.getCell(i + 2);
    cell.value = `${f.floor} a. (${f.total} v.)`;
  });
  headerRow.font = { bold: true };
  byFloor.getColumn(1).width = 14;
  floors.forEach((_, i) => {
    byFloor.getColumn(i + 2).width = 14;
  });

  for (const d of days) {
    const row = byFloor.addRow([]);
    row.getCell(1).value = d;
    floors.forEach((f, i) => {
      const reserved = reservedByKey.get(`${d}|${f.floor}`) ?? 0;
      const cell = row.getCell(i + 2);
      cell.value = pct(reserved, f.total);
      cell.numFmt = '0.0%';
    });
  }

  return workbook;
}

@Service({
  name: 'occupancyExport',
})
export default class OccupancyExportService extends moleculer.Service {
  /**
   * GET /api/occupancyExport/xlsx?period=day|week|month&date=YYYY-MM-DD
   * Grąžina .xlsx su užimtumo % ataskaita. Tik ADMIN (gateway `types` +
   * `requireAdminHook`, kaip ir kitur — internal ctx.call apeina gateway).
   */
  @Action({
    rest: 'GET /xlsx',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      period: { type: 'enum', values: ['day', 'week', 'month'] },
      date: { type: 'string', pattern: DATE_PATTERN },
      includeWeekends: { type: 'boolean', optional: true, convert: true },
    },
  })
  async xlsx(
    ctx: Context<
      { period: OccupancyPeriod; date: string; includeWeekends?: boolean },
      UserAuthMeta
    >,
  ) {
    requireAdminHook(ctx);

    const { period, date, includeWeekends } = ctx.params;
    const { from, to } = resolveRange(period, date);

    // Dvi ATSKIROS agregacijos (kaip stats.service.ts) — kad join'as
    // neišpūstų desk_count sumos.
    const capacities = (await db('rooms')
      .whereNull('deleted_at')
      .groupBy('floor')
      .orderBy('floor', 'asc')
      .select('floor', db.raw('SUM(desk_count)::int AS total'))) as FloorCapacityRow[];

    const reservedRaw = (await db('reservations as res')
      .join('rooms as r', 'r.id', 'res.room_id')
      .whereNull('r.deleted_at')
      .whereBetween('res.date', [from, to])
      .groupBy('res.date', 'r.floor')
      .select(
        'res.date',
        'r.floor',
        db.raw('COUNT(res.id)::int AS reserved'),
      )) as any[];

    const reservedRows: ReservedRow[] = reservedRaw.map((r) => ({
      // PG DATE -> JS Date per pg driver; suvienodinam į YYYY-MM-DD.
      date: r.date instanceof Date ? ymd(r.date) : String(r.date).slice(0, 10),
      floor: Number(r.floor),
      reserved: Number(r.reserved) || 0,
    }));

    const workbook = buildOccupancyWorkbook(period, from, to, capacities, reservedRows, {
      includeWeekends,
    });
    const buffer = await workbook.xlsx.writeBuffer();

    ctx.meta.$responseHeaders = {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${this.buildFilename(period, from, to)}"`,
    };

    return buffer;
  }

  /** `uzimtumas-<period>-<from>_<to>.xlsx`. */
  @Method
  buildFilename(period: OccupancyPeriod, from: string, to: string): string {
    if (period === 'day') return `uzimtumas-diena-${from}.xlsx`;
    return `uzimtumas-${period === 'week' ? 'savaite' : 'menuo'}-${from}_${to}.xlsx`;
  }
}
