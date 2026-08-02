import { getRedis } from '../db/redis.js';
import { env } from '../config/env.js';
import { keys } from '../utils/keys.js';
import type { WeekId } from '../types/domain.js';

/**
 * Demo "live traffic" generator. In production the earn stream comes from real
 * game clients hitting `POST /events/earn`; for the case demo nothing drives
 * that, so the board sits frozen for a whole week. This applies a small batch of
 * random earns to *existing* players so the leaderboard visibly moves.
 *
 * It touches ONLY the Redis ranking + `earn_total` counter — exactly what a real
 * earn does — so the money path (Postgres/Mongo, close-week) is untouched and
 * the design's integer-money invariants hold. The one documented side effect is
 * that `earn_total` grows while it runs, so a later close-week pool is larger
 * (pool = 2% of total).
 */
export interface SimulateOptions {
  /**
   * Explicit number of players to bump this tick. When omitted, the count is
   * derived from the live board size as `fraction` of it (clamped to
   * [minCount, maxCount]) — so the demo scales with however many players are
   * seeded instead of a fixed handful.
   */
  count?: number;
  /** Share of the current board to bump when `count` is omitted (0.001 = 0.1%). */
  fraction: number;
  /** Floor so a tiny/local board still visibly moves. */
  minCount: number;
  /** Ceiling so one tick can't apply an unbounded burst at large scale. */
  maxCount: number;
  /** Inclusive earn range per player (integer minor units). */
  minAmount: number;
  maxAmount: number;
}

export interface SimulateResult {
  weekId: WeekId;
  /** Total players on the board this tick (result of ZCARD; 0 = empty board). */
  boardSize: number;
  /** How many distinct players actually got an earn (≤ count; 0 on an empty board). */
  playersHit: number;
  /** Sum of all earns applied this tick (added to earn_total). */
  totalEarned: number;
}

export const SIMULATE_DEFAULTS: SimulateOptions = {
  // Board-scaling knobs are env-tunable (see config/env.ts) so a metered/free
  // managed Redis can dial the per-tick write burst down without a code change.
  fraction: env.SIMULATE_FRACTION, // default 0.001 = 0.1% of the board per tick
  minCount: env.SIMULATE_MIN_COUNT,
  maxCount: env.SIMULATE_MAX_COUNT,
  minAmount: 100,
  maxAmount: 5_000,
};

/** Random integer in [min, max]. */
function randomAmount(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Resolve how many players to bump: explicit count, else `fraction` of the board. */
function resolveCount(options: SimulateOptions, boardSize: number): number {
  if (options.count !== undefined) return Math.min(options.count, boardSize);
  const byFraction = Math.floor(boardSize * options.fraction);
  return Math.min(options.maxCount, Math.max(options.minCount, byFraction), boardSize);
}

/**
 * Apply one batch of random earns to the current week's board. Picks a set of
 * distinct random players (1% of the board by default) and, in a single
 * pipeline, bumps each score and adds the batch total to `earn_total` — one
 * round trip, mirroring the real earn's (ZINCRBY + INCRBY) pair. No-op
 * (playersHit 0) when the board is empty.
 */
export async function simulateEarns(
  weekId: WeekId,
  options: SimulateOptions = SIMULATE_DEFAULTS,
): Promise<SimulateResult> {
  const redis = getRedis();
  const lbKey = keys.leaderboard(weekId);

  const boardSize = await redis.zcard(lbKey);
  if (boardSize === 0) {
    return { weekId, boardSize: 0, playersHit: 0, totalEarned: 0 };
  }

  const members = await redis.zrandmember(lbKey, resolveCount(options, boardSize));
  if (members.length === 0) {
    return { weekId, boardSize, playersHit: 0, totalEarned: 0 };
  }

  const pipeline = redis.multi();
  let totalEarned = 0;
  for (const playerId of members) {
    const amount = randomAmount(options.minAmount, options.maxAmount);
    totalEarned += amount;
    pipeline.zincrby(lbKey, amount, playerId);
  }
  pipeline.incrby(keys.earnTotal(weekId), totalEarned);
  await pipeline.exec();

  return { weekId, boardSize, playersHit: members.length, totalEarned };
}
