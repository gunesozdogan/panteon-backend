/**
 * Random player sample for the demo user picker (auth is scoped out — a reviewer
 * switches identity by picking a playerId). Ranking stays in Redis: random
 * members via `ZRANDMEMBER`, each labelled with its live rank via `ZREVRANK`.
 * Guarantees at least one top-100 player so the picker always offers an in-board
 * example alongside outside-the-top-100 ones.
 */
import { getRedis } from '../db/redis.js';
import { resolveUsernames } from './leaderboard.js';
import { keys } from '../utils/keys.js';
import type { PlayerSample, PlayerSampleResponse, WeekId } from '../types/domain.js';

const TOP_N = 100;
const DEFAULT_N = 5;
const MAX_N = 20;

export async function getPlayerSample(
  weekId: WeekId,
  n: number = DEFAULT_N,
): Promise<PlayerSampleResponse> {
  const count = Math.min(Math.max(1, Math.floor(n)), MAX_N);
  const redis = getRedis();
  const lbKey = keys.leaderboard(weekId);

  const total = await redis.zcard(lbKey);
  if (total === 0) return { weekId, players: [] };

  // Guarantee one top-100 player: pick a random rank inside the head.
  const ids = new Set<string>();
  const topBound = Math.min(TOP_N, total);
  const topIdx = Math.floor(Math.random() * topBound);
  const [topPick] = await redis.zrevrange(lbKey, topIdx, topIdx);
  if (topPick) ids.add(topPick);

  // Fill the rest with random members from the whole board (distinct).
  if (ids.size < count) {
    const randoms = await redis.zrandmember(lbKey, count);
    for (const id of randoms) {
      ids.add(id);
      if (ids.size >= count) break;
    }
  }

  const idList = [...ids].slice(0, count);

  const pipeline = redis.pipeline();
  for (const id of idList) pipeline.zrevrank(lbKey, id);
  const ranked = await pipeline.exec();

  const names = await resolveUsernames(idList);

  const players: PlayerSample[] = idList.map((id, i) => {
    const rank0 = (ranked?.[i]?.[1] ?? null) as number | null;
    const rank = (rank0 ?? total) + 1;
    return {
      playerId: id,
      username: names.get(id) ?? id,
      rank,
      inTop100: rank0 !== null && rank0 < TOP_N,
    };
  });

  players.sort((a, b) => a.rank - b.rank);
  return { weekId, players };
}
