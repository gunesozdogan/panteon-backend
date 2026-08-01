import { describe, it, expect } from 'vitest';
import { getCurrentWeekId, getPreviousWeekId, getRecentWeekIds } from '../src/utils/week.js';

const utc = (y: number, m: number, d: number, h = 0): Date =>
  new Date(Date.UTC(y, m - 1, d, h));

describe('getCurrentWeekId', () => {
  it('formats as ISO-week `YYYY-Www` with a zero-padded week', () => {
    expect(getCurrentWeekId(utc(2026, 1, 1))).toBe('2026-W01');
  });

  it('matches the documented current week (2026-07-29 → 2026-W31)', () => {
    expect(getCurrentWeekId(utc(2026, 7, 29))).toBe('2026-W31');
  });

  // ISO week-year can differ from the calendar year near Jan/Dec — the tricky part.
  it('assigns early-January days to the previous ISO year when needed', () => {
    // 2023-01-01 is a Sunday → belongs to 2022-W52.
    expect(getCurrentWeekId(utc(2023, 1, 1))).toBe('2022-W52');
    // 2021-01-01 is a Friday → belongs to 2020-W53.
    expect(getCurrentWeekId(utc(2021, 1, 1))).toBe('2020-W53');
  });

  it('assigns late-December days to the next ISO year when needed', () => {
    // 2024-12-30 is a Monday, first day of 2025-W01.
    expect(getCurrentWeekId(utc(2024, 12, 30))).toBe('2025-W01');
  });

  it('recognises a 53-week year', () => {
    // 2020-12-31 is a Thursday → 2020-W53.
    expect(getCurrentWeekId(utc(2020, 12, 31))).toBe('2020-W53');
  });

  it('is a pure function of the date, independent of intra-day time', () => {
    expect(getCurrentWeekId(utc(2026, 7, 29, 0))).toBe(getCurrentWeekId(utc(2026, 7, 29, 23)));
  });

  it('rolls to the next week id at the Monday 00:00 UTC boundary', () => {
    // Sun 2026-07-26 is still W30; Mon 2026-07-27 begins W31.
    expect(getCurrentWeekId(utc(2026, 7, 26))).toBe('2026-W30');
    expect(getCurrentWeekId(utc(2026, 7, 27))).toBe('2026-W31');
  });
});

describe('getPreviousWeekId', () => {
  it('returns the week that just ended (W31 → W30)', () => {
    // The cron fires early Mon 2026-07-27 (W31) and must close W30.
    expect(getPreviousWeekId(utc(2026, 7, 27))).toBe('2026-W30');
  });

  it('crosses the year boundary via ISO logic (2025-W01 → 2024-W52)', () => {
    // Mon 2024-12-30 is 2025-W01; the previous week is 2024-W52.
    expect(getPreviousWeekId(utc(2024, 12, 30))).toBe('2024-W52');
  });

  it('handles a 53-week predecessor year (2021-W01 → 2020-W53)', () => {
    // Mon 2021-01-04 is 2021-W01; 2020 is a 53-week ISO year.
    expect(getPreviousWeekId(utc(2021, 1, 4))).toBe('2020-W53');
  });
});

describe('getRecentWeekIds (cron sweep window)', () => {
  it('returns the last N ended weeks, newest first, excluding the current week', () => {
    expect(getRecentWeekIds(4, utc(2026, 7, 29))).toEqual([
      '2026-W30',
      '2026-W29',
      '2026-W28',
      '2026-W27',
    ]);
  });

  it('agrees with getPreviousWeekId on the newest entry', () => {
    const date = utc(2026, 7, 27);
    expect(getRecentWeekIds(3, date)[0]).toBe(getPreviousWeekId(date));
  });

  it('crosses the year boundary via ISO logic', () => {
    expect(getRecentWeekIds(2, utc(2025, 1, 6))).toEqual(['2025-W01', '2024-W52']);
  });

  it('produces distinct ids (each 7-day step lands in a new week)', () => {
    const ids = getRecentWeekIds(4, utc(2026, 7, 29));
    expect(new Set(ids).size).toBe(ids.length);
  });
});