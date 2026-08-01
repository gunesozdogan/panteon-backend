/**
 * Unit tests for the close-week ORCHESTRATOR, with Redis, Postgres and Mongo all
 * mocked so the suite stays hermetic — no running stores required.
 *
 * The prize math itself is tested exhaustively in distribution.test.ts; here we
 * lock the orchestration decisions that only closeWeek makes:
 *   - pool = floor(earn_total * 2 / 100)
 *   - money committed to Postgres, wallets credited, Mongo archived, keys reset
 *   - archive happens BEFORE the Redis reset (crash-safety ordering)
 *   - idempotent re-run (payouts already exist) → no double-pay
 *   - already-reset week (zcard 0) → safe no-op, Mongo NOT overwritten
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Shared call-order log so we can assert "archive before reset". */
const { fakeRedis, pg, mongo, order } = vi.hoisted(() => {
  const order: string[] = [];

  const fakeRedis = {
    zcard: vi.fn(),
    zrevrange: vi.fn(),
    get: vi.fn(),
    del: vi.fn(async (...args: string[]) => {
      order.push(`del:${args.join(',')}`);
      return args.length;
    }),
    hmget: vi.fn((_key: string, ...ids: string[]) =>
      Promise.resolve(ids.map((id) => `Name_${id}`)),
    ),
    hset: vi.fn(async () => 1),
  };

  // Stateful fake Postgres: a payouts "table" (Set of week:player) enforcing the
  // UNIQUE(week_id, player_id) idempotency, and a wallets balance map.
  const paidKeys = new Set<string>();
  const wallets = new Map<string, number>();
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO payouts')) {
        const [weekId, ids, , prizes] = params as [string, string[], number[], number[]];
        const rows: { player_id: string; prize_amount: string }[] = [];
        ids.forEach((id, i) => {
          const k = `${weekId}:${id}`;
          if (!paidKeys.has(k)) {
            paidKeys.add(k);
            rows.push({ player_id: id, prize_amount: String(prizes[i]) });
          }
        });
        return { rows };
      }
      if (sql.includes('UPDATE wallets')) {
        const [ids, amts] = params as [string[], number[]];
        ids.forEach((id, i) => wallets.set(id, (wallets.get(id) ?? 0) + amts[i]!));
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pg = {
    client,
    paidKeys,
    wallets,
    pool: { connect: vi.fn(async () => client) },
  };

  const archived = new Map<string, Record<string, unknown>>();
  const mongo = {
    archived,
    col: {
      createIndex: vi.fn(async () => 'weekId_1'),
      replaceOne: vi.fn(async (filter: { weekId: string }, doc: Record<string, unknown>) => {
        order.push(`archive:${filter.weekId}`);
        archived.set(filter.weekId, doc);
        return { acknowledged: true, upsertedCount: 1 };
      }),
    },
  };

  return { fakeRedis, pg, mongo, order };
});

vi.mock('../src/db/redis.js', () => ({ getRedis: () => fakeRedis }));
vi.mock('../src/db/postgres.js', () => ({ getPool: () => pg.pool }));
vi.mock('../src/db/mongo.js', () => ({
  getMongoDb: async () => ({ collection: () => mongo.col }),
}));

import { closeWeek } from '../src/services/closeWeek.js';

const WEEK = '2026-W30';

/** Flat WITHSCORES reply builder. */
const flat = (rows: { id: string; score: number }[]): string[] =>
  rows.flatMap((r) => [r.id, String(r.score)]);

const board = [
  { id: 'p1', score: 1000 },
  { id: 'p2', score: 900 },
  { id: 'p3', score: 800 },
  { id: 'p4', score: 700 },
  { id: 'p5', score: 600 },
];

describe('closeWeek (Redis + Postgres + Mongo mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.paidKeys.clear();
    pg.wallets.clear();
    mongo.archived.clear();
    order.length = 0;

    fakeRedis.zcard.mockResolvedValue(board.length);
    fakeRedis.zrevrange.mockResolvedValue(flat(board));
    fakeRedis.get.mockResolvedValue('100000');
  });

  it('computes pool = floor(earn_total * 2 / 100) and distributes it', async () => {
    const res = await closeWeek(WEEK);

    expect(res.earnTotal).toBe(100000);
    expect(res.pool).toBe(2000);
    expect(res.alreadyClosed).toBe(false);
    expect(res.playersPaid).toBe(5);
    expect(res.totalDistributed).toBeGreaterThan(0);
    expect(res.totalDistributed).toBeLessThanOrEqual(res.pool);
  });

  it('credits wallets by exactly the payout amounts (top-3 = 20/15/10%)', async () => {
    const res = await closeWeek(WEEK);

    expect(pg.wallets.get('p1')).toBe(400);
    expect(pg.wallets.get('p2')).toBe(300);
    expect(pg.wallets.get('p3')).toBe(200);
    const credited = [...pg.wallets.values()].reduce((s, v) => s + v, 0);
    expect(credited).toBe(res.totalDistributed);
  });

  it('archives full standings to Mongo BEFORE resetting Redis', async () => {
    await closeWeek(WEEK);

    const doc = mongo.archived.get(WEEK) as
      | { weekId: string; standings: { rank: number; playerId: string; score: number; prize: number }[] }
      | undefined;
    expect(doc?.standings).toHaveLength(5);
    expect(doc?.standings?.[0]).toMatchObject({ rank: 1, playerId: 'p1', score: 1000, prize: 400 });
    expect(doc?.weekId).toBe(WEEK);

    const archiveIdx = order.findIndex((o) => o.startsWith('archive:'));
    const delIdx = order.findIndex((o) => o.startsWith('del:'));
    expect(archiveIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(archiveIdx);
  });

  it('resets the three week keys (ranking, pool, cached top-100)', async () => {
    await closeWeek(WEEK);
    expect(fakeRedis.del).toHaveBeenCalledWith(
      `lb:${WEEK}`,
      `earn_total:${WEEK}`,
      `lb:top100:${WEEK}`,
    );
  });

  it('is idempotent: a re-run before reset inserts no new payouts, no double-pay', async () => {
    await closeWeek(WEEK);
    const afterFirst = new Map(pg.wallets);
    const res2 = await closeWeek(WEEK);

    expect(res2.playersPaid).toBe(0);
    expect(res2.totalDistributed).toBe(0);
    expect([...pg.wallets.entries()]).toEqual([...afterFirst.entries()]);
  });

  it('is a safe no-op when the week is already reset (zcard 0)', async () => {
    fakeRedis.zcard.mockResolvedValue(0);

    const res = await closeWeek(WEEK);

    expect(res.alreadyClosed).toBe(true);
    expect(res.pool).toBe(0);
    expect(res.playersPaid).toBe(0);
    expect(pg.pool.connect).not.toHaveBeenCalled();
    expect(mongo.col.replaceOne).not.toHaveBeenCalled();
    expect(fakeRedis.del).not.toHaveBeenCalled();
  });

  it('handles a missing earn_total (no earns) → pool 0, still archives + resets', async () => {
    fakeRedis.get.mockResolvedValue(null);

    const res = await closeWeek(WEEK);

    expect(res.earnTotal).toBe(0);
    expect(res.pool).toBe(0);
    expect(res.playersPaid).toBe(0);
    const doc = mongo.archived.get(WEEK) as { standings: unknown[] } | undefined;
    expect(doc?.standings).toHaveLength(5);
    expect(fakeRedis.del).toHaveBeenCalled();
  });
});

describe('closeWeek — demo snapshot (outputWeekId + reset:false)', () => {
  const EARLY = '2026-W30-early';

  beforeEach(() => {
    vi.clearAllMocks();
    pg.paidKeys.clear();
    pg.wallets.clear();
    mongo.archived.clear();
    order.length = 0;

    fakeRedis.zcard.mockResolvedValue(board.length);
    fakeRedis.zrevrange.mockResolvedValue(flat(board));
    fakeRedis.get.mockResolvedValue('100000');
  });

  it('reads the source board but seals payouts + archive under the output id', async () => {
    const res = await closeWeek(WEEK, { outputWeekId: EARLY, reset: false });

    expect(res.weekId).toBe(EARLY);
    expect(mongo.archived.has(EARLY)).toBe(true);
    expect(mongo.archived.has(WEEK)).toBe(false);
    expect(pg.paidKeys.has(`${EARLY}:p1`)).toBe(true);
    expect(pg.paidKeys.has(`${WEEK}:p1`)).toBe(false);
  });

  it('does NOT reset the live board (Redis keys untouched)', async () => {
    await closeWeek(WEEK, { outputWeekId: EARLY, reset: false });
    expect(fakeRedis.del).not.toHaveBeenCalled();
  });

  it('still credits wallets (real money moves for the demo)', async () => {
    const res = await closeWeek(WEEK, { outputWeekId: EARLY, reset: false });
    expect(pg.wallets.get('p1')).toBe(400);
    const credited = [...pg.wallets.values()].reduce((s, v) => s + v, 0);
    expect(credited).toBe(res.totalDistributed);
  });

  it('a later real close of the same source pays again (distinct week_id) — the documented double-credit', async () => {
    await closeWeek(WEEK, { outputWeekId: EARLY, reset: false });
    const afterSnapshot = pg.wallets.get('p1')!;
    const real = await closeWeek(WEEK);
    expect(real.weekId).toBe(WEEK);
    expect(real.playersPaid).toBeGreaterThan(0);
    expect(pg.wallets.get('p1')).toBe(afterSnapshot + 400);
    expect(fakeRedis.del).toHaveBeenCalled();
  });
});
