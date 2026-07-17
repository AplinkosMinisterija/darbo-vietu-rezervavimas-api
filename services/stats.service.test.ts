import { describe, it, expect } from 'vitest';
import {
  assertValidRange,
  buildDaySeries,
  buildStatsWorkbook,
  computeKpis,
  type DayPoint,
  type StatsWorkbookInput,
} from './stats.service';

describe('assertValidRange', () => {
  it('accepts a normal range and a single day', () => {
    expect(() => assertValidRange('2026-01-01', '2026-12-31')).not.toThrow();
    expect(() => assertValidRange('2026-07-17', '2026-07-17')).not.toThrow();
  });

  it('rejects from > to', () => {
    expect(() => assertValidRange('2026-07-18', '2026-07-17')).toThrow(/laikotarpis/i);
  });

  it('rejects a span over ~5 years', () => {
    expect(() => assertValidRange('2020-01-01', '2026-01-01')).toThrow(/laikotarpis/i);
    // 1827 days inclusive is still fine (2022-01-01 → 2026-12-31 is 1826 days).
    expect(() => assertValidRange('2022-01-01', '2026-12-31')).not.toThrow();
  });
});

describe('buildDaySeries', () => {
  it('fills every calendar day in range with 0 when missing', () => {
    const reserved = new Map<string, number>([
      ['2026-07-01', 3],
      ['2026-07-03', 1],
    ]);
    expect(buildDaySeries('2026-07-01', '2026-07-03', reserved)).toEqual([
      { date: '2026-07-01', reserved: 3 },
      { date: '2026-07-02', reserved: 0 },
      { date: '2026-07-03', reserved: 1 },
    ]);
  });

  it('crosses month and year boundaries', () => {
    const series = buildDaySeries('2025-12-30', '2026-01-02', new Map());
    expect(series.map((d) => d.date)).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
  });

  it('crosses the EEST DST switch (2026-03-29) without skipping or doubling days', () => {
    const series = buildDaySeries('2026-03-28', '2026-03-30', new Map());
    expect(series.map((d) => d.date)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
  });

  it('single-day range returns one entry', () => {
    expect(buildDaySeries('2026-07-17', '2026-07-17', new Map())).toEqual([
      { date: '2026-07-17', reserved: 0 },
    ]);
  });
});

describe('computeKpis', () => {
  // 2026-07-13 Mon … 2026-07-19 Sun
  const week: DayPoint[] = [
    { date: '2026-07-13', reserved: 8 },
    { date: '2026-07-14', reserved: 6 },
    { date: '2026-07-15', reserved: 4 },
    { date: '2026-07-16', reserved: 2 },
    { date: '2026-07-17', reserved: 0 },
    { date: '2026-07-18', reserved: 10 }, // Sat — excluded from workday avg
    { date: '2026-07-19', reserved: 10 }, // Sun — excluded from workday avg
  ];

  it('sums total reservations over ALL days', () => {
    expect(computeKpis(week, 10).totalReservations).toBe(40);
  });

  it('averages occupancy over workdays (Mon–Fri) only', () => {
    // workdays reserved: 8+6+4+2+0 = 20 over 5 days × capacity 10 → 40%
    expect(computeKpis(week, 10).workdayAvgOccupancyPct).toBe(40);
  });

  it('rounds the percentage to 1 decimal', () => {
    const days: DayPoint[] = [
      { date: '2026-07-13', reserved: 1 },
      { date: '2026-07-14', reserved: 0 },
      { date: '2026-07-15', reserved: 0 },
    ];
    // 1 / (3 × 3) = 11.111…% → 11.1
    expect(computeKpis(days, 3).workdayAvgOccupancyPct).toBe(11.1);
  });

  it('picks the first day with the maximum as peakDay', () => {
    expect(computeKpis(week, 10).peakDay).toEqual({ date: '2026-07-18', reserved: 10 });
  });

  it('returns null peakDay when there are no reservations at all', () => {
    const empty: DayPoint[] = [
      { date: '2026-07-13', reserved: 0 },
      { date: '2026-07-14', reserved: 0 },
    ];
    expect(computeKpis(empty, 10).peakDay).toBeNull();
  });

  it('is safe on zero capacity and on weekend-only ranges (no division by zero)', () => {
    expect(computeKpis(week, 0).workdayAvgOccupancyPct).toBe(0);
    const weekend: DayPoint[] = [
      { date: '2026-07-18', reserved: 5 },
      { date: '2026-07-19', reserved: 5 },
    ];
    expect(computeKpis(weekend, 10).workdayAvgOccupancyPct).toBe(0);
    expect(computeKpis([], 10)).toEqual({
      totalReservations: 0,
      workdayAvgOccupancyPct: 0,
      peakDay: null,
    });
  });
});

describe('buildStatsWorkbook', () => {
  // Mon 2026-07-13 … Wed 2026-07-15, capacity 10
  const input: StatsWorkbookInput = {
    from: '2026-07-13',
    to: '2026-07-15',
    capacity: 10,
    days: [
      { date: '2026-07-13', reserved: 8 },
      { date: '2026-07-14', reserved: 0 },
      { date: '2026-07-15', reserved: 5 },
    ],
    rooms: [
      { number: '101', name: 'Pirmas', floor: 1, deskCount: 4, reserved: 6 },
      { number: '202', name: 'Antras', floor: 2, deskCount: 0, reserved: 0 },
    ],
    kpi: {
      totalReservations: 13,
      workdayAvgOccupancyPct: 43.3,
      peakDay: { date: '2026-07-13', reserved: 8 },
      reservingUsers: 4,
      activeUsers: 20,
    },
    detail: [
      {
        date: '2026-07-13',
        displayName: 'Jonas Jonaitis',
        email: 'jonas@am.lt',
        roomNumber: '101',
        roomName: 'Pirmas',
        deskNumber: 2,
      },
    ],
  };

  const wb = buildStatsWorkbook(input);

  it('creates the five expected sheets', () => {
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Suvestinė',
      'Pagal dieną',
      'Pagal kabinetą',
      'Pagal savaitės dieną',
      'Rezervacijos',
    ]);
  });

  it('writes one row per day with weekday name and occupancy %', () => {
    const sheet = wb.getWorksheet('Pagal dieną')!;
    expect(sheet.rowCount).toBe(4); // header + 3 days
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('2026-07-13');
    expect(row.getCell(2).value).toBe('Pirmadienis');
    expect(row.getCell(3).value).toBe(8);
    expect(row.getCell(4).value).toBe(10);
    expect(row.getCell(5).value).toBe(80);
  });

  it('computes room occupancy % over the whole period, 0 on zero desks', () => {
    const sheet = wb.getWorksheet('Pagal kabinetą')!;
    const first = sheet.getRow(2);
    // 6 reserved / (4 desks × 3 days) = 50%
    expect(first.getCell(1).value).toBe('101');
    expect(first.getCell(6).value).toBe(50);
    const second = sheet.getRow(3);
    expect(second.getCell(6).value).toBe(0); // deskCount 0 → no division by zero
  });

  it('aggregates weekday averages only over weekdays present in range', () => {
    const sheet = wb.getWorksheet('Pagal savaitės dieną')!;
    // Row 2 = Pirmadienis: one Monday, avg reserved 8, avg occupancy 80%
    const monday = sheet.getRow(2);
    expect(monday.getCell(1).value).toBe('Pirmadienis');
    expect(monday.getCell(2).value).toBe(1);
    expect(monday.getCell(3).value).toBe(8);
    expect(monday.getCell(4).value).toBe(80);
    // Only weekdays that occur in the range are listed (Mon–Wed here).
    expect(sheet.rowCount).toBe(4);
  });

  it('writes reservation detail rows verbatim', () => {
    const sheet = wb.getWorksheet('Rezervacijos')!;
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('2026-07-13');
    expect(row.getCell(2).value).toBe('Jonas Jonaitis');
    expect(row.getCell(3).value).toBe('jonas@am.lt');
    expect(row.getCell(4).value).toBe('101');
    expect(row.getCell(5).value).toBe('Pirmas');
    expect(row.getCell(6).value).toBe(2);
  });

  it('summarises KPIs including the "X iš Y" users line', () => {
    const sheet = wb.getWorksheet('Suvestinė')!;
    const values: Array<[unknown, unknown]> = [];
    sheet.eachRow((row) => values.push([row.getCell(1).value, row.getCell(2).value]));
    expect(values).toContainEqual(['Laikotarpis', '2026-07-13 – 2026-07-15']);
    expect(values).toContainEqual(['Rezervacijų iš viso', 13]);
    expect(values).toContainEqual(['Vid. užimtumas darbo dienomis (%)', 43.3]);
    expect(values).toContainEqual(['Rezervavo naudotojų', '4 iš 20']);
    expect(values).toContainEqual(['Pikinė diena', '2026-07-13 (8)']);
  });
});
