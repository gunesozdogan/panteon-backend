import { getRedis } from '../db/redis.js';
import { keys } from '../utils/keys.js';
import type { WeekId } from '../types/domain.js';

export interface EarnResult {
  weekId: WeekId;
  /** Player's new weekly total after this event (integer minor units). */
  newScore: number;
  /** Week-wide raw earnings total after this event (integer minor units). */
  earnTotal: number;
}

/**
 * Record an earn event: bump the player's weekly score in the ranking sorted
 * set AND the week-wide raw earnings total, atomically.
 *
 * Both writes go in a single MULTI/EXEC transaction so a crash between them
 * can't leave the pool counter out of sync with the sorted set (a lost update
 * under concurrency).
 */
export async function recordEarn(
  playerId: string,
  amount: number,
  weekId: WeekId,
): Promise<EarnResult> {
  const redis = getRedis();

  const results = await redis
    .multi()
    .zincrby(keys.leaderboard(weekId), amount, playerId)
    .incrby(keys.earnTotal(weekId), amount)
    .exec();

  if (!results) {
    throw new Error('earn transaction aborted (MULTI/EXEC returned null)');
  }

  const zResult = results[0];
  const iResult = results[1];
  if (!zResult || !iResult) {
    throw new Error('earn transaction returned an unexpected shape');
  }

  const [zErr, zVal] = zResult;
  const [iErr, iVal] = iResult;
  if (zErr) throw zErr;
  if (iErr) throw iErr;

  return {
    weekId,
    newScore: Number(zVal),
    earnTotal: Number(iVal),
  };
}