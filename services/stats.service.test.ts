import { describe, it, expect } from 'vitest';
import { buildDaySeries, computeKpis, type DayPoint } from './stats.service';

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
