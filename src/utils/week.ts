import type { WeekId } from '../types/domain.js';

/**
 * Deterministic ISO-8601 week id, e.g. `2026-W31`.
 *
 * ISO rules: weeks start Monday; week 1 is the week containing the year's first
 * Thursday. This means late-December / early-January dates can belong to the
 * neighbouring year's week (that's why we derive the year from the Thursday of
 * the week, not from the calendar date). Computed entirely in UTC so the week
 * boundary is a stable "Monday 00:00 UTC" regardless of server timezone.
 *
 * Pure function of its input — the reset routine just moves to the next id.
 */
export function getCurrentWeekId(date: Date = new Date()): WeekId {
  // Strip time; work with a UTC date at midnight.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  // ISO weekday: Mon=1 .. Sun=7 (JS getUTCDay has Sun=0).
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();

  // Shift to the Thursday of this week; its calendar year is the ISO week-year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);

  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const dayOfYear = (d.getTime() - yearStart) / 86_400_000 + 1;
  const week = Math.ceil(dayOfYear / 7);

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function getPreviousWeekId(date: Date = new Date()): WeekId {
  const aWeekAgo = new Date(date.getTime() - 7 * 86_400_000);
  return getCurrentWeekId(aWeekAgo);
}

/**
 * The `count` most recently ended weeks, newest first — e.g. for `count = 3` on
 * a date in `2026-W31`: `['2026-W30', '2026-W29', '2026-W28']`. Pure function of
 * its input (UTC), like the rest of this module.
 *
 * This is the self-healing window for the weekly-close cron: each tick closes
 * not just last week but the last `count` weeks, so a tick that was missed
 * (crash, deploy, an instance that never scheduled) is caught up on the next
 * run. `closeWeek`'s `zcard == 0` guard makes every already-closed week in the
 * window a cheap no-op, so the sweep is safe to run every tick.
 */
export function getRecentWeekIds(count: number, date: Date = new Date()): WeekId[] {
  const ids: WeekId[] = [];
  for (let k = 1; k <= count; k++) {
    ids.push(getCurrentWeekId(new Date(date.getTime() - k * 7 * 86_400_000)));
  }
  return ids;
}