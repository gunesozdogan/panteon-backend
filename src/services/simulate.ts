import { getRedis } from '../db/redis.js';
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
  /** How many random players to bump this tick. */
  count: number;
  /** Inclusive earn range per player (integer minor units). */
  minAmount: number;
  maxAmount: number;
}

export interface SimulateResult {
  weekId: WeekId;
  /** How many distinct players actually got an earn (≤ count; 0 on an empty board). */
  playersHit: number;
  /** Sum of all earns applied this tick (added to earn_total). */
  totalEarned: number;
}

export const SIMULATE_DEFAULTS = {
  count: 8,
  minAmount: 100,
  maxAmount: 5_000,
} as const;

/** Random integer in [min, max]. */
function randomAmount(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Apply one batch of random earns to the current week's board. Picks `count`
 * distinct random players and, in a single pipeline, bumps each score and adds
 * the batch total to `earn_total` — one round trip, mirroring the real earn's
 * (ZINCRBY + INCRBY) pair. No-op (playersHit 0) when the board is empty.
 */
export async function simulateEarns(
  weekId: WeekId,
  options: SimulateOptions = SIMULATE_DEFAULTS,
): Promise<SimulateResult> {
  const redis = getRedis();
  const lbKey = keys.leaderboard(weekId);

  const members = await redis.zrandmember(lbKey, options.count);
  if (members.length === 0) {
    return { weekId, playersHit: 0, totalEarned: 0 };
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

  return { weekId, playersHit: members.length, totalEarned };
}
