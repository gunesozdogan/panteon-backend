import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Shared pg connection pool. Money and payouts are written here inside
 * transactions — Postgres is the auditable source of truth (see CLAUDE.md).
 */
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => {
      console.error('[postgres] idle client error:', err.message);
    });
  }
  return pool;
}

export async function pingPostgres(): Promise<boolean> {
  const res = await getPool().query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

export async function closePostgres(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}