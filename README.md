# Panteon Leaderboard — Backend

Stateless Node.js + TypeScript API for a **weekly leaderboard** in an idle/clicker game
(~10M registered players, ~2M daily active). It answers three product needs:

1. The board loads **instantly**, even at 2M DAU.
2. A player always sees the **top 100**, and — if they're outside it — their **own rank plus
   the 3 players above and 2 below** them.
3. At the end of each week a **prize pool** (2% of everything earned) is distributed
   automatically and the board **resets** for the next week.

The whole design turns on one idea: **each of the four stores does only what it's best at.**
Ranking lives in Redis, money lives in Postgres, history lives in Mongo, and the Node process
holds **no per-request state** so any instance can serve any request behind a load balancer.

---

## Architecture at a glance

| Store          | Role                          | Why it's the right tool                                                                 |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| **Redis**      | Live ranking + read cache     | Sorted sets give O(log n) rank/range — this is what makes the board "instant".          |
| **PostgreSQL** | Money & source of truth       | Payouts + wallet credits need a transaction; money must be consistent and auditable.    |
| **MongoDB**    | Historical archive            | One document per closed week; variable-length standings fit a flexible schema naturally.|
| **Node.js**    | Stateless API                 | Keeps no in-process state — all state is in the stores, so it scales horizontally.       |

### How a request moves through the stores

```
POST /events/earn ─┐
                   ▼
              ┌─────────┐   ZINCRBY lb:{week}  +  INCRBY earn_total:{week}   (one MULTI/EXEC)
              │  REDIS  │◄──────────────────────────────────────────────────────────────────┐
              └─────────┘                                                                    │
GET /leaderboard ──► top-100 cached in lb:top100:{week} (2s TTL) ─┐                          │
                     caller's own rank/window computed per-request│                          │
                                                                  ▼                          │
                                                        response (top100 + me)               │
                                                                                             │
close-week (cron / admin) ──► read Redis standings ──► Postgres payouts+wallets (txn) ──► Mongo archive ──► reset Redis keys
                              money ─────────────► archive ────────────────────► reset  (reset LAST, for crash-safety)
```

The read path is the scalability lever: the top 100 is **identical for every player**, so it's
serialized once into `lb:top100:{weekId}` (short TTL) instead of running a 100-row range + a
username join on every open. Only the requesting player's own rank/window is computed per-request.

---

## Tech stack

- **Node.js ≥ 20**, **TypeScript** (`strict: true`), ES modules
- **Express** for HTTP, **Zod** for request/env validation
- **ioredis** · **pg** · **mongodb** — the three store clients
- **node-cron** — the weekly-close scheduler
- **Vitest** — unit tests (`tsx` for dev/run)

No ORMs, no extra databases or queues — the stack is fixed by the brief and every store is used
for its intended job.

---

## Project structure

```
src/
  index.ts              # process entry: start server, wire cron, graceful shutdown
  app.ts                # Express app assembly (all routers)
  config/env.ts         # Zod-validated env (fails fast on bad config)
  db/
    redis.ts postgres.ts mongo.ts   # store clients + ping/close helpers
    schema.sql          # Postgres DDL (players, wallets, payouts)
  routes/               # thin HTTP layer: validate → call service → map errors
    events.ts leaderboard.ts history.ts players.ts sample.ts admin.ts health.ts
  services/             # business logic (I/O)
    earn.ts leaderboard.ts closeWeek.ts distribution.ts history.ts players.ts
    sample.ts simulate.ts
  scheduler/weeklyClose.ts   # self-healing weekly-close sweep (node-cron)
  scripts/              # migrate · seed · simulate (operational CLIs)
  utils/keys.ts week.ts      # Redis key builders · ISO-week helpers (pure)
  types/domain.ts       # shared domain types (single source of truth)
test/                   # Vitest — pure-logic tests (distribution, window, week, close…)
```

The tricky, bug-prone logic is factored into **pure functions** and tested directly:
`distribution.ts` (prize math), the rank-window selection in `leaderboard.ts`, and the ISO-week
helpers in `week.ts`.

---

## Getting started

### Prerequisites

Running instances of **Redis**, **PostgreSQL**, and **MongoDB** — either locally or managed
(the project is deployed against Upstash / Neon / Mongo Atlas).

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
# then edit .env with your connection strings
```

The process validates `.env` on boot (`config/env.ts`) and **fails fast** with a readable error
if anything required is missing or malformed.

### 3. Migrate + seed

```bash
npm run migrate    # apply src/db/schema.sql (idempotent — safe to re-run)
npm run seed       # load sample players so the board is testable out of the box
```

### 4. Run

```bash
npm run dev        # tsx watch — hot reload
# or, for production:
npm run build && npm start
```

Server listens on `http://localhost:$PORT` (default 3000). Health check: `GET /health`.

---

## Environment variables

| Variable             | Default                                   | Purpose                                                                 |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `PORT`               | `3000`                                    | HTTP port.                                                              |
| `REDIS_URL`          | —                                         | Redis connection (live ranking + cache). **Required.**                  |
| `DATABASE_URL`       | —                                         | Postgres connection (money source of truth). **Required.**              |
| `MONGO_URL`          | —                                         | MongoDB connection (history archive). **Required.**                     |
| `MONGO_DB`           | `leaderboard`                             | Mongo database name.                                                    |
| `CORS_ORIGINS`       | `http://localhost:5173,…:5174`            | Comma-separated allowed origins.                                        |
| `ENABLE_CRON`        | `false`                                   | Turn on the weekly-close scheduler. Enable on **one** worker only.      |
| `CLOSE_WEEK_CRON`    | `5 0 * * 1`                               | When to close (Mon 00:05 UTC — just after the ISO week boundary).       |
| `CRON_TIMEZONE`      | `UTC`                                     | Timezone for the cron expression.                                       |
| `CLOSE_SWEEP_WEEKS`  | `4`                                       | Self-healing window: each tick re-closes the last N ended weeks.        |
| `ENABLE_SIMULATOR`   | `true`                                    | Enable the demo "live traffic" endpoint. Set `false` in real prod.      |
| `SIMULATE_FRACTION`  | `0.001`                                   | Share of the roster bumped per simulate tick.                           |
| `SIMULATE_MIN_COUNT` | `10`                                      | Floor so a tiny board still visibly moves.                              |
| `SIMULATE_MAX_COUNT` | `2000`                                    | Ceiling on players bumped per tick (bounds the write burst).            |

> Secrets belong only in `.env` (git-ignored). Statelessness means the process is configured by
> env, never by in-memory state.

---

## API reference

All responses are JSON. Money fields are always **integers in the smallest currency unit**.

### `POST /events/earn`
Record earnings for a player. Bumps the Redis sorted set **and** the week's earnings counter in a
single `MULTI/EXEC` so the pool can never drift from the ranking.

```jsonc
// body
{ "playerId": "p123", "amount": 500 }        // amount: positive integer minor units
// 200
{ "weekId": "2026-W31", "newScore": 12000, "earnTotal": 8830000 }
```

### `GET /leaderboard?playerId=...`
The core read. Always returns the top 100 + live pool + total player count. If `playerId` is
supplied **and** the player is outside the top 100, a 6-row `me` window is included (3 above,
self, 2 below — clamped at the board edge). If they're already in the top 100, `me` is omitted
and the frontend highlights their row by id.

```jsonc
// 200
{
  "weekId": "2026-W31",
  "top": [ { "rank": 1, "playerId": "p9", "username": "Ada", "score": 90200 }, … ],
  "pool": 176600,            // 2% of earn_total, live
  "totalPlayers": 4213,      // ZCARD — true "N competing", even though top caps at 100
  "me": {                    // only when caller is outside the top 100
    "entry":  { "rank": 812, "playerId": "p123", "username": "You", "score": 3100 },
    "window": [ …3 above, self, 2 below… ]
  }
}
```

### `GET /leaderboard/history`
Lean summaries of every archived week (newest first) for a "past weeks" picker.

### `GET /leaderboard/history/:weekId`
Full final standings for one archived week from Mongo. `weekId` looks like `2026-W31`
(optionally `2026-W31-early` for demo snapshots). `404` if not archived.

### `GET /players/:playerId/wallet`
A player's durable money view from **Postgres** — cumulative balance + per-close payout history.
This surfaces the wallet credits close-week writes (the live score stays on `/leaderboard`).
`404` on unknown id.

### `GET /players/ranks?ids=p1,p2,…`
Current rank + `inTop100` for a specific id set (the demo picker's in-place rank refresh). Ids no
longer on the board are omitted.

### `GET /players/sample?n=…`
A random sample of real players + labels — feeds the demo "who am I" picker (auth is out of scope
for the case).

### `POST /admin/close-week`
Run distribution + reset for a week on demand (also wired to the scheduled sweep). Idempotent.

```jsonc
{}                          // → close the CURRENT week and reset
{ "weekId": "2026-W30" }    // → close a specific ended week
{ "early": true }           // → DEMO close: snapshot the live week under a "-early" id,
                            //    pay only earnings since the last close, and reset the board
```

### `POST /admin/simulate`
Demo "live traffic": applies a small batch of random earns so the deployed board keeps moving.
Driven by the **browser's poll tick** (not an in-process timer), which keeps the API stateless.
Gated by `ENABLE_SIMULATOR`.

### `GET /health`
Pings all three stores; `200 ok` when all up, `503 degraded` otherwise. Includes the current
`weekId`.

---

## Domain rules (implemented exactly)

**Money = integers, always.** All amounts are stored in the smallest currency unit. Redis uses
`INCRBY` (never `INCRBYFLOAT`); Postgres uses `bigint`. Floats appear only in non-authoritative
display formatting — this sidesteps the classic float-rounding error on money.

**Prize pool** = 2% of the total earned that week: `pool = floor(earn_total * 2 / 100)`. The raw
total accumulates per earn event; the 2% is taken once, at a single well-defined rounding point.

**Distribution (top 100 only):**
- Rank 1 → 20% · Rank 2 → 15% · Rank 3 → 10% of pool
- Ranks 4–100 → share the remaining 55%, **weighted linearly** by rank: `w(rank) = 101 - rank`,
  so rank 4 gets the largest slice and rank 100 the smallest.
- **Rounding:** each share is floored, then the leftover whole units are handed out via the
  **largest-remainder method** (biggest fractional part first; ties → higher rank). Every payout
  stays within 1 minor unit of its exact value and `Σ payouts == pool` on a full board — without
  inflating rank 1 above its 20%.

This math is a pure function (`computePayouts` in `services/distribution.ts`) and is unit-tested
hard — it's exactly where money bugs hide.

**Close-week ordering** = money → archive → **reset last**, for crash-safety. Payout writes +
wallet credits are idempotent off `UNIQUE(week_id, player_id)`, and a `zcard == 0` guard makes a
re-run after a completed close a safe no-op (it never archives an empty board over the good doc).

---

## Weekly close & the scheduler

The reset boundary is derived deterministically from the clock: `weekId` is an ISO week
(`2026-W31`), so "reset" is just moving to a new Redis key. The scheduler
(`scheduler/weeklyClose.ts`, `node-cron`, Mon 00:05 UTC) is **off unless `ENABLE_CRON=true`** and
is a **self-healing sweep**: each tick closes the last `CLOSE_SWEEP_WEEKS` ended weeks — not just
last week — so a missed or failed tick is caught up later (already-closed weeks are cheap no-ops).
It holds no state and delegates to the same idempotent `closeWeek`, so even if two instances fire
there's no double payout. In a multi-instance deploy, enable the cron on exactly one worker.

---

## Testing

```bash
npm test          # vitest run  (pure-logic units: distribution, window, week, close…)
npm run test:watch
npm run typecheck # tsc --noEmit, strict
```

Tests concentrate on the parts most likely to break: the prize math (weights + rounding), the
off-by-one-prone rank-window selection, and the ISO-week helpers.

