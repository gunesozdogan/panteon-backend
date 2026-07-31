import type { WeekId } from '../types/domain.js';

/**
 * Redis key builders — the single source of truth for key naming, so the seed
 * script, the earn path, and the read path can never drift on spelling.
 */
export const keys = {
  /** Sorted set: member = playerId, score = weekly earnings (integer minor units). */
  leaderboard: (weekId: WeekId): string => `lb:${weekId}`,
  /** Integer counter: raw total earned this week; pool = floor(total*2/100) at close. */
  earnTotal: (weekId: WeekId): string => `earn_total:${weekId}`,
  /** Cached serialized top-100 payload (short TTL). Populated on the read path. */
  top100: (weekId: WeekId): string => `lb:top100:${weekId}`,
  /** Hash playerId -> username, so the read path never queries Postgres per row. */
  playersMeta: 'players:meta',
} as const;