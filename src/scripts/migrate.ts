/**
 * Migration runner — applies `src/db/schema.sql` to Postgres.
 *
 * Usage:  npm run migrate
 *
 * The DDL is idempotent (CREATE ... IF NOT EXISTS), so this is safe to re-run.
 * At case scope this stands in for a full migration tool; in production you'd
 * reach for a versioned migrator, but the trade-off is documented in DECISIONS.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePostgres } from '../db/postgres.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'db', 'schema.sql');

async function migrate(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  await getPool().query(sql);
  console.log(`[migrate] applied schema from ${schemaPath}`);
}

migrate()
  .then(closePostgres)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[migrate] failed:', err);
    await closePostgres();
    process.exit(1);
  });
