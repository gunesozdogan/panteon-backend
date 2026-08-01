/**
 * Seed script — populate Redis with sample players and random weekly scores so
 * the leaderboard is testable out of the box (a scored requirement).
 *
 * Usage:  npm run seed [count]   (default 5000)
 *
 * Writes, for the current weekId:
 *   - lb:{weekId}         sorted set  (ZADD score -> playerId)   the ranking (Redis)
 *   - players:meta        hash        (playerId -> username)     the name cache (Redis)
 *   - earn_total:{weekId} string      (= sum of all seeded scores)  the pool base (Redis)
 *   - players / wallets   Postgres tables (identity source of truth + 0-balance wallets)
 *
 * Re-runnable: it DELs the week's ranking + pool keys first so a re-run gives a
 * clean board (players:meta + Postgres are upserts — identity is stable).
 *
 * Note: run `npm run migrate` once first so the Postgres tables exist.
 */
import { getRedis, closeRedis } from '../db/redis.js';
import { closePostgres } from '../db/postgres.js';
import { upsertPlayers } from '../services/players.js';
import { keys } from '../utils/keys.js';
import { getCurrentWeekId } from '../utils/week.js';
import type { Player } from '../types/domain.js';

const DEFAULT_COUNT = 5000;
const MAX_SCORE = 1_000_000; // minor units

async function seed(count: number): Promise<void> {
  const redis = getRedis();
  const weekId = getCurrentWeekId();
  const lbKey = keys.leaderboard(weekId);
  const earnKey = keys.earnTotal(weekId);
  const metaKey = keys.playersMeta;

  // Clean slate for this week's ranking + pool so re-runs are deterministic.
  await redis.del(lbKey, earnKey);

  const zaddArgs: (string | number)[] = [];
  const metaArgs: string[] = [];
  const players: Player[] = [];
  let total = 0;

  for (let i = 1; i <= count; i++) {
    const playerId = `p${i}`;
    const username = `Player_${i}`;
    const score = Math.floor(Math.random() * MAX_SCORE);
    zaddArgs.push(score, playerId);
    metaArgs.push(playerId, username);
    players.push({ id: playerId, username });
    total += score;
  }

  // Bulk-load in one round trip. earn_total is set to the sum of scores so the
  // pool math (2% of total) has realistic input to work on at close-week.
  const pipeline = redis.multi();
  pipeline.zadd(lbKey, ...zaddArgs);
  pipeline.hset(metaKey, ...metaArgs);
  pipeline.set(earnKey, total);
  await pipeline.exec();

  // Postgres is the identity source of truth (Redis hash is just a warm cache).
  await upsertPlayers(players);

  console.log(`[seed] weekId=${weekId} players=${count} earn_total=${total}`);
  console.log(`[seed] Redis keys: ${lbKey}, ${metaKey}, ${earnKey}`);
  console.log(`[seed] Postgres: upserted ${count} players + wallets`);
}

const count = Number(process.argv[2] ?? DEFAULT_COUNT);
if (!Number.isInteger(count) || count <= 0) {
  console.error(`[seed] invalid count: ${process.argv[2]}`);
  process.exit(1);
}

seed(count)
  .then(() => Promise.all([closeRedis(), closePostgres()]))
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await Promise.allSettled([closeRedis(), closePostgres()]);
    process.exit(1);
  });