

/** A `weekId` in deterministic ISO-week form, e.g. `2026-W31`. */
export type WeekId = string;

export interface Player {
  id: string;
  username: string;
}

export interface LeaderboardEntry {
  /** 1-indexed display rank. */
  rank: number;
  playerId: string;
  username: string;
  /** Weekly earnings, integer minor units. */
  score: number;
  /** Prize won, integer minor units. Only present on archived/closed weeks. */
  prize?: number;
}

/** The requesting player's own position when they are OUTSIDE the top 100. */
export interface SelfView {
  entry: LeaderboardEntry;
  /** 3 above + self + 2 below (up to 6 rows), honoring board boundaries. */
  window: LeaderboardEntry[];
}

export interface LeaderboardResponse {
  weekId: WeekId;
  top: LeaderboardEntry[];
  /**
   * The caller's own view. Omitted when the caller is already in `top`
   * (they're flagged inside `top` instead) or when no playerId was supplied.
   */
  me?: SelfView;
}

/** Body of `POST /events/earn`. */
export interface EarnEvent {
  playerId: string;
  /** Amount earned this event, integer minor units (> 0). */
  amount: number;
}

/**
 * One row of a closed week's final standings. Unlike the live `LeaderboardEntry`,
 * `prize` is always present here (the week has been distributed).
 */
export interface WeeklyStanding {
  /** 1-indexed final rank. */
  rank: number;
  playerId: string;
  username: string;
  /** Final weekly earnings, integer minor units. */
  score: number;
  /** Prize won, integer minor units (0 for ranks outside the paid board). */
  prize: number;
}

/**
 * A closed week, archived as a single MongoDB document (one doc per week).
 */
export interface WeeklyStandingsDoc {
  weekId: WeekId;
  /** ISO-8601 timestamp of when the week was closed. */
  closedAt: string;
  standings: WeeklyStanding[];
}

/**
 * One row of the demo player picker's random sample (`GET /players/sample`).
 * Auth is scoped out, so a reviewer switches "who am I" by picking a playerId;
 * this feeds that picker with real, freshly-sampled players + their labels.
 */
export interface PlayerSample {
  playerId: string;
  username: string;
  /** 1-indexed current rank. */
  rank: number;
  /** True when rank <= 100 — labels the picker ("Top 100" vs "Outside"). */
  inTop100: boolean;
}

export interface PlayerSampleResponse {
  weekId: WeekId;
  /** Random players, sorted by rank; at least one is in the top 100. */
  players: PlayerSample[];
}

/**
 * Summary returned by the close-week routine (`POST /admin/close-week`). The
 * full standings go to Mongo; this is the lean audit summary for the caller.
 * All money fields are integer minor units.
 */
export interface CloseWeekResult {
  weekId: WeekId;
  /** ISO-8601 timestamp of when the week was closed. */
  closedAt: string;
  /** Raw total earned this week (`earn_total:{weekId}`). */
  earnTotal: number;
  /** Distributable pool = floor(earnTotal * 2 / 100). */
  pool: number;
  /** Players who received a payout this run (0 on an idempotent re-run). */
  playersPaid: number;
  /** Σ of prizes actually credited to wallets this run. */
  totalDistributed: number;
  /**
   * True when there was nothing to close (the week's Redis key was already
   * reset, or the board was empty) — the routine was a safe no-op.
   */
  alreadyClosed: boolean;
}