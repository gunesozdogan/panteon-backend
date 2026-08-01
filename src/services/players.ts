/**
 * Postgres access for player identity — the source of truth for usernames and
 * wallets. Ranking stays in Redis; this module is only about durable identity.
 *
 * `getUsernames` backs the read-path cache-miss fallback (see leaderboard.ts):
 * `players:meta` in Redis is a warm cache, but Postgres is authoritative.
 */
import { getPool } from '../db/postgres.js';
import type { Player } from '../types/domain.js';

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
