/**
 * Weekly close — distribute the prize pool and reset the board.
 *
 * This is the one place where all three stores meet, each doing its own job:
 *   - Redis     is READ for the final standings + earn_total, then its week
 *               keys are deleted last (the reset).
 *   - Postgres  receives the payouts + wallet credits inside ONE transaction —
 *               the auditable source of truth for money.
 *   - Mongo     receives the archived full standings (one document per week).
 *
 *   1. read Redis (top 100 + earn_total) and compute the pool + payouts (pure)
 *   2. commit money to Postgres (idempotent via UNIQUE(week_id, player_id))
 *   3. archive to Mongo (idempotent upsert) — BEFORE deleting Redis
 *   4. delete the Redis week keys (reset) — LAST, so a crash never drops data
 *      that has not yet been persisted; a re-run simply repeats idempotent steps.
 */
import { getRedis } from '../db/redis.js';
import { getPool } from '../db/postgres.js';
import { computePayouts } from './distribution.js';
import { archiveWeeklyStandings } from './history.js';
import { parseWithScores, resolveUsernames } from './leaderboard.js';
import { keys } from '../utils/keys.js';
import type { CloseWeekResult, WeeklyStanding, WeekId } from '../types/domain.js';

const TOP_N = 100;

function poolFromEarnTotal(earnTotal: number): number {
  return Math.floor((earnTotal * 2) / 100);
}

async function persistPayouts(
  weekId: WeekId,
  paid: readonly WeeklyStanding[],
): Promise<{ count: number; sum: number }> {
  if (paid.length === 0) return { count: 0, sum: 0 };

  const ids = paid.map((p) => p.playerId);
  const usernames = paid.map((p) => p.username);
  const ranks = paid.map((p) => p.rank);
  const prizes = paid.map((p) => p.prize);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO players (id, username)
         SELECT * FROM unnest($1::text[], $2::text[])
         ON CONFLICT (id) DO NOTHING`,
      [ids, usernames],
    );
    await client.query(
      `INSERT INTO wallets (player_id)
         SELECT unnest($1::text[])
         ON CONFLICT (player_id) DO NOTHING`,
      [ids],
    );

    const inserted = await client.query<{ player_id: string; prize_amount: string }>(
      `INSERT INTO payouts (week_id, player_id, final_rank, prize_amount)
         SELECT $1, * FROM unnest($2::text[], $3::int[], $4::bigint[])
         ON CONFLICT (week_id, player_id) DO NOTHING
         RETURNING player_id, prize_amount`,
      [weekId, ids, ranks, prizes],
    );

    if (inserted.rows.length > 0) {
      const creditIds = inserted.rows.map((r) => r.player_id);
      const creditAmts = inserted.rows.map((r) => Number(r.prize_amount));
      await client.query(
        `UPDATE wallets w
           SET balance = balance + c.prize, updated_at = now()
           FROM unnest($1::text[], $2::bigint[]) AS c(player_id, prize)
           WHERE w.player_id = c.player_id`,
        [creditIds, creditAmts],
      );
    }

    await client.query('COMMIT');

    const sum = inserted.rows.reduce((s, r) => s + Number(r.prize_amount), 0);
    return { count: inserted.rows.length, sum };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Options that let one routine serve two callers without blurring their jobs:
 *
 *   - The real weekly close (cron / `POST /admin/close-week`) reads and writes
 *     the SAME week id and RESETS the board — the defaults.
 *   - The demo "snapshot" (`early`) reads the live week but seals its output
 *     under a distinct `outputWeekId` (`2026-W31-early`) and does NOT reset, so
 *     the running week is never destroyed. See docs/manual-close-week.md.
 */
export interface CloseWeekOptions {
  /**
   * Where the payouts + Mongo archive are written. Defaults to `sourceWeekId`.
   * A snapshot passes a distinct id (`2026-W31-early`) so it can never collide
   * with — or overwrite — the real close of the same calendar week.
   */
  outputWeekId?: WeekId;
  /**
   * Delete the source Redis week keys after archiving (the reset). Default
   * `true` (real close). A snapshot passes `false`: the live board keeps running.
   */
  reset?: boolean;
}

/**
 * Close a week: distribute its pool to the top 100, archive the standings, and
 * (unless `reset: false`) reset the board. Safe to call more than once for the
 * same output week (idempotent via `UNIQUE(week_id, player_id)`).
 *
 * Reads always come from `lb:{sourceWeekId}`; money + archive are written under
 * `outputWeekId` (defaults to the source). Keeping the two ids separate is what
 * lets a mid-week snapshot seal itself under `-early` without touching the live
 * board — and, conversely, why the real close must leave `outputWeekId` unset.
 *
 * @param sourceWeekId the week whose Redis board is read (and, on reset, dropped).
 * @param opts         see {@link CloseWeekOptions}; defaults = real weekly close.
 */
export async function closeWeek(
  sourceWeekId: WeekId,
  opts: CloseWeekOptions = {},
): Promise<CloseWeekResult> {
  const outputWeekId = opts.outputWeekId ?? sourceWeekId;
  const reset = opts.reset ?? true;

  const redis = getRedis();
  const lbKey = keys.leaderboard(sourceWeekId);
  const closedAt = new Date().toISOString();
  const total = await redis.zcard(lbKey);
  if (total === 0) {
    return {
      weekId: outputWeekId,
      closedAt,
      earnTotal: 0,
      pool: 0,
      playersPaid: 0,
      totalDistributed: 0,
      alreadyClosed: true,
    };
  }

  const flat = await redis.zrevrange(lbKey, 0, TOP_N - 1, 'WITHSCORES');
  const rows = parseWithScores(flat);
  const earnTotal = Number((await redis.get(keys.earnTotal(sourceWeekId))) ?? 0);
  const pool = poolFromEarnTotal(earnTotal);
  const payouts = computePayouts(
    rows.map((r) => r.playerId),
    pool,
  );
  const prizeByPlayer = new Map(payouts.map((p) => [p.playerId, p.prize]));
  const names = await resolveUsernames(rows.map((r) => r.playerId));
  const standings: WeeklyStanding[] = rows.map((r, i) => ({
    rank: i + 1,
    playerId: r.playerId,
    username: names.get(r.playerId) ?? r.playerId,
    score: r.score,
    prize: prizeByPlayer.get(r.playerId) ?? 0,
  }));

  const paid = standings.filter((s) => s.prize > 0);
  const { count, sum } = await persistPayouts(outputWeekId, paid);

  await archiveWeeklyStandings({ weekId: outputWeekId, closedAt, standings });
  if (reset) {
    await redis.del(lbKey, keys.earnTotal(sourceWeekId), keys.top100(sourceWeekId));
  }

  return {
    weekId: outputWeekId,
    closedAt,
    earnTotal,
    pool,
    playersPaid: count,
    totalDistributed: sum,
    alreadyClosed: false,
  };
}
