import { describe, it, expect } from 'vitest';
import { computeRecurringDates, buildRecurringPlan } from './reservations.service';

// 2026-06-15 is a Monday (ISO 1); 2026-06-16 is a Tuesday (ISO 2).

describe('computeRecurringDates', () => {
  it('repeats a single weekday weekly from a matching start date', () => {
    expect(computeRecurringDates('2026-06-15', [1], 4)).toEqual([
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
      '2026-07-06',
    ]);
  });

  it('handles multiple weekdays in chronological order', () => {
    // Mon/Wed/Fri over 2 weeks.
    expect(computeRecurringDates('2026-06-15', [1, 3, 5], 2)).toEqual([
      '2026-06-15',
      '2026-06-17',
      '2026-06-19',
      '2026-06-22',
      '2026-06-24',
      '2026-06-26',
    ]);
  });

  it('starts from today forward — a partial first week excludes earlier weekdays', () => {
    // today = Tue 06-16; first Monday in the 1-week window is 06-22.
    expect(computeRecurringDates('2026-06-16', [1], 1)).toEqual(['2026-06-22']);
  });

  it('every returned date has an ISO weekday in the requested set', () => {
    const wanted = [2, 4];
    for (const ds of computeRecurringDates('2026-06-15', wanted, 6)) {
      const dow = new Date(`${ds}T00:00:00Z`).getUTCDay();
      expect(wanted).toContain(dow === 0 ? 7 : dow);
    }
  });
});

describe('buildRecurringPlan', () => {
  it('books the lowest free desk per day when everything is free', () => {
    const { plan, full, alreadyBooked } = buildRecurringPlan(
      ['2026-06-15', '2026-06-22'],
      new Set(),
      new Map(),
      3,
    );
    expect(plan).toEqual([
      { date: '2026-06-15', desk: 1 },
      { date: '2026-06-22', desk: 1 },
    ]);
    expect(full).toEqual([]);
    expect(alreadyBooked).toEqual([]);
  });

  it('picks the lowest desk not already taken', () => {
    const { plan } = buildRecurringPlan(
      ['2026-06-15'],
      new Set(),
      new Map([['2026-06-15', new Set([1, 2])]]),
      4,
    );
    expect(plan).toEqual([{ date: '2026-06-15', desk: 3 }]);
  });

  it('flags a day with no free desk as full (room capacity reached)', () => {
    const { plan, full } = buildRecurringPlan(
      ['2026-06-15'],
      new Set(),
      new Map([['2026-06-15', new Set([1, 2])]]),
      2,
    );
    expect(plan).toEqual([]);
    expect(full).toEqual(['2026-06-15']);
  });

  it('flags a day where the user already holds a reservation', () => {
    const { plan, alreadyBooked } = buildRecurringPlan(
      ['2026-06-15', '2026-06-22'],
      new Set(['2026-06-15']),
      new Map(),
      3,
    );
    expect(alreadyBooked).toEqual(['2026-06-15']);
    expect(plan).toEqual([{ date: '2026-06-22', desk: 1 }]);
  });

  it('separates full, already-booked, and bookable across a mixed batch', () => {
    const { plan, full, alreadyBooked } = buildRecurringPlan(
      ['2026-06-15', '2026-06-16', '2026-06-17'],
      new Set(['2026-06-15']),
      new Map([['2026-06-16', new Set([1, 2])]]),
      2,
    );
    expect(alreadyBooked).toEqual(['2026-06-15']);
    expect(full).toEqual(['2026-06-16']);
    expect(plan).toEqual([{ date: '2026-06-17', desk: 1 }]);
  });
});
