/**
 * Postgres access for player identity — the source of truth for usernames and
 * wallets. Ranking stays in Redis; this module is only about durable identity.
 *
 * `getUsernames` backs the read-path cache-miss fallback (see leaderboard.ts):
 * `players:meta` in Redis is a warm cache, but Postgres is authoritative.
 */
import { getPool } from '../db/postgres.js';
import type { Player, PlayerWalletResponse } from '../types/domain.js';

/**
 * Resolve usernames for the given player ids in ONE query (`= ANY($1)`), never
 * a per-id round trip. Missing ids are simply absent from the returned map.
 */
export async function getUsernames(
  playerIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (playerIds.length === 0) return map;

  const res = await getPool().query<{ id: string; username: string }>(
    'SELECT id, username FROM players WHERE id = ANY($1)',
    [playerIds as string[]],
  );
  for (const row of res.rows) map.set(row.id, row.username);
  return map;
}

/**
 * A player's durable money view: wallet balance + per-close payout history, both
 * from Postgres (the money source of truth). Two small indexed queries — one for
 * identity+balance (`players` LEFT JOIN `wallets`), one for the payout list
 * (`idx_payouts_week` covers week filters; player filter is a cheap scan at case
 * scale). Returns `null` when the player id is unknown → the route answers 404.
 * `bigint` columns come back from `pg` as strings, parsed to integer here.
 */
export async function getPlayerWallet(
  playerId: string,
): Promise<PlayerWalletResponse | null> {
  const pool = getPool();

  const identity = await pool.query<{ username: string; balance: string }>(
    `SELECT p.username, COALESCE(w.balance, 0)::text AS balance
       FROM players p
       LEFT JOIN wallets w ON w.player_id = p.id
      WHERE p.id = $1`,
    [playerId],
  );
  const row = identity.rows[0];
  if (!row) return null;

  const payoutRows = await pool.query<{
    week_id: string;
    final_rank: number;
    prize_amount: string;
    distributed_at: Date;
  }>(
    `SELECT week_id, final_rank, prize_amount, distributed_at
       FROM payouts
      WHERE player_id = $1
      ORDER BY distributed_at DESC`,
    [playerId],
  );

  return {
    playerId,
    username: row.username,
    balance: Number(row.balance),
    payouts: payoutRows.rows.map((p) => ({
      weekId: p.week_id,
      rank: p.final_rank,
      prize: Number(p.prize_amount),
      distributedAt: new Date(p.distributed_at).toISOString(),
    })),
  };
}

/**
 * Upsert players and ensure each has a wallet row (balance 0), in a single
 * transaction. Uses `unnest` for a bulk write so seeding thousands of players
 * costs two statements, not two-per-player. Idempotent (re-runnable).
 */
export async function upsertPlayers(players: readonly Player[]): Promise<void> {
  if (players.length === 0) return;

  const ids = players.map((p) => p.id);
  const usernames = players.map((p) => p.username);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO players (id, username)
         SELECT * FROM unnest($1::text[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username`,
      [ids, usernames],
    );
    await client.query(
      `INSERT INTO wallets (player_id)
         SELECT unnest($1::text[])
         ON CONFLICT (player_id) DO NOTHING`,
      [ids],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
