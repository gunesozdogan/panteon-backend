-- Postgres schema — money & identity source of truth (see CLAUDE.md).
--
-- Ranking is NOT here: it lives in Redis (sorted set). Postgres holds what must
-- be consistent and auditable — player identity, wallet balances, and payouts.
-- All money is stored as INTEGER minor units (bigint), never floats.
--
-- Idempotent DDL (CREATE ... IF NOT EXISTS) so `npm run migrate` is safe to
-- re-run; this stands in for a full migration tool at case scope.

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One wallet per player. Balance in integer minor units; credited at close-week.
CREATE TABLE IF NOT EXISTS wallets (
  player_id   TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auditable record of every prize paid. The UNIQUE(week_id, player_id) is the
-- idempotency guard: close-week inserts with ON CONFLICT DO NOTHING, so a re-run
-- after a crash can never double-pay a player (see CLAUDE.md close-week rules).
CREATE TABLE IF NOT EXISTS payouts (
  id             BIGSERIAL PRIMARY KEY,
  week_id        TEXT NOT NULL,
  player_id      TEXT NOT NULL REFERENCES players(id),
  final_rank     INTEGER NOT NULL,
  prize_amount   BIGINT NOT NULL CHECK (prize_amount >= 0),
  distributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_id, player_id)
);

-- History reads and per-week audits filter by week.
CREATE INDEX IF NOT EXISTS idx_payouts_week ON payouts (week_id);
