import { getRedis } from '../db/redis.js';
import { env } from '../config/env.js';
import { keys } from '../utils/keys.js';
import type { WeekId } from '../types/domain.js';

/**
 * Demo "live traffic" generator. In production the earn stream comes from real
 * game clients hitting `POST /events/earn`; for the case demo nothing drives
 * that, so the board sits frozen for a whole week. This applies a small batch of
 * random earns each tick so the leaderboard visibly moves — and, by drawing from
 * the roster, grows the board toward the full player set over time.
 *
 * It touches ONLY the Redis ranking + `earn_total` counter — exactly what a real
 * earn does — so the money path (Postgres/Mongo, close-week) is untouched and
 * the design's integer-money invariants hold. The one documented side effect is
 * that `earn_total` grows while it runs, so a later close-week pool is larger
 * (pool = 2% of total).
 *
 * Earners are drawn from the persistent roster (`players:meta`), not just the
 * current board, so the board grows toward the full roster over ticks and refills
 * after a close-week reset (see `simulateEarns`).
 */
export interface SimulateOptions {
  /**
   * Explicit number of players to draw this tick. When omitted, the count is
   * derived from the roster size as `fraction` of it (clamped to
   * [minCount, maxCount]) — so the fill rate is steady regardless of how full the
   * board currently is.
   */
  count?: number;
  /** Share of the roster to draw when `count` is omitted (0.001 = 0.1%). */
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
  fraction: env.SIMULATE_FRACTION,
  minCount: env.SIMULATE_MIN_COUNT,
  maxCount: env.SIMULATE_MAX_COUNT,
  minAmount: 100,
  maxAmount: 5_000,
};

/** Random integer in [min, max]. */
function randomAmount(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Resolve how many players to draw: explicit count, else `fraction` of the roster. */
function resolveCount(options: SimulateOptions, rosterSize: number): number {
  if (options.count !== undefined) return Math.min(options.count, rosterSize);
  const byFraction = Math.floor(rosterSize * options.fraction);
  return Math.min(options.maxCount, Math.max(options.minCount, byFraction), rosterSize);
}

/**
 * Apply one batch of random earns for the current week. Draws a set of distinct
 * random players **from the persistent roster** (`players:meta`, `HRANDFIELD`) —
 * not just the current board — and, in a single pipeline, bumps each score
 * (`ZINCRBY`, which *creates* the member if they weren't on the board yet) and
 * adds the batch total to `earn_total` (`INCRBY`). One round trip, mirroring the
 * real earn's (ZINCRBY + INCRBY) pair.
 *
 * Drawing from the roster (rather than `ZRANDMEMBER` of the board) is what makes
 * the board **grow toward the full roster over successive ticks** — new players
 * "join as they earn" and start near 0, existing players climb — so after a
 * close-week reset the board refills from empty and keeps filling, instead of
 * being stuck at whoever's already on it. Count scales with the roster (clamped
 * to [minCount, maxCount]) so the fill rate is steady regardless of current board
 * size; raise `SIMULATE_FRACTION` to fill faster. No-op only when the roster
 * itself is empty (nothing has ever been seeded). Touches only Redis ranking +
 * `earn_total`; the money path (Postgres/Mongo) is untouched, exactly like a real
 * earn — so the stateless + integer-money invariants hold.
 */
export async function simulateEarns(
  weekId: WeekId,
  options: SimulateOptions = SIMULATE_DEFAULTS,
): Promise<SimulateResult> {
  const redis = getRedis();
  const lbKey = keys.leaderboard(weekId);

  const rosterSize = await redis.hlen(keys.playersMeta);
  if (rosterSize === 0) {
    return { weekId, boardSize: 0, playersHit: 0, totalEarned: 0 };
  }

  const members = (await redis.hrandfield(
    keys.playersMeta,
    resolveCount(options, rosterSize),
  )) as string[] | null;
  if (!members || members.length === 0) {
    return { weekId, boardSize: await redis.zcard(lbKey), playersHit: 0, totalEarned: 0 };
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

  return {
    weekId,
    boardSize: await redis.zcard(lbKey),
    playersHit: members.length,
    totalEarned,
  };
}
