/**
 * Unit tests for the getLeaderboard ORCHESTRATOR (the async branch logic), with
 * Redis mocked so they stay hermetic — no running Redis required.
 *
 * The pure helpers (windowRange / parseWithScores / toEntries) are tested
 * directly in leaderboard.test.ts. Here we lock the decision branches that only
 * getLeaderboard makes:
 *   - no playerId            → top only, `me` omitted, zrevrank never called
 *   - player not on board    → `me` omitted
 *   - rank0 = 99 (disp 100)  → still "in top", `me` omitted, NO window computed
 *   - rank0 = 100 (disp 101) → first outside top → `me` + 6-row window [98..103]
 * The 100-vs-101 cutoff is exactly the off-by-one boundary CLAUDE.md calls out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fakeRedis } = vi.hoisted(() => ({
  fakeRedis: {
    get: vi.fn(),
    set: vi.fn(),
    zrevrange: vi.fn(),
    zrevrank: vi.fn(),
    zcard: vi.fn(),
    hmget: vi.fn(),
  },
}));

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => fakeRedis,
}));

import { getLeaderboard } from '../src/services/leaderboard.js';

const WEEK = '2026-W31';
const LB_KEY = `lb:${WEEK}`;

/** Build a flat Redis WITHSCORES reply: [{id,score}] → ['id','score', ...]. */
const flat = (rows: { id: string; score: number }[]): string[] =>
  rows.flatMap((r) => [r.id, String(r.score)]);

describe('getLeaderboard (Redis mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    fakeRedis.get.mockResolvedValue(null);
    fakeRedis.set.mockResolvedValue('OK');
    fakeRedis.zcard.mockResolvedValue(300);
    fakeRedis.hmget.mockImplementation((_key: string, ...ids: string[]) =>
      Promise.resolve(ids.map((id) => `Name_${id}`)),
    );
    fakeRedis.zrevrange.mockImplementation((_key: string, start: number) =>
      Promise.resolve(
        start === 0
          ? flat([
              { id: 'p1', score: 900 },
              { id: 'p2', score: 800 },
              { id: 'p3', score: 700 },
            ])
          : [],
      ),
    );
  });

  it('no playerId → returns top, omits me, never calls zrevrank', async () => {
    const res = await getLeaderboard(WEEK);

    expect(res.weekId).toBe(WEEK);
    expect(res.top.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(res.top[0]).toMatchObject({ playerId: 'p1', username: 'Name_p1', score: 900 });
    expect(res.me).toBeUndefined();
    expect(fakeRedis.zrevrank).not.toHaveBeenCalled();
  });

  it('player not on the board (zrevrank → null) → me omitted', async () => {
    fakeRedis.zrevrank.mockResolvedValue(null);

    const res = await getLeaderboard(WEEK, 'ghost');

    expect(res.me).toBeUndefined();
  });

  it('player inside top 100 (rank0 = 99, display 100) → me omitted, no window computed', async () => {
    fakeRedis.zrevrank.mockResolvedValue(99);

    const res = await getLeaderboard(WEEK, 'p1');

    expect(res.me).toBeUndefined();
    expect(fakeRedis.zcard).not.toHaveBeenCalled();
  });

  it('first player outside top 100 (rank0 = 100, display 101) → me + 6-row window [98..103]', async () => {
    fakeRedis.zrevrank.mockResolvedValue(100);
    fakeRedis.zrevrange.mockImplementation((_key: string, start: number) =>
      Promise.resolve(
        start === 0
          ? flat([{ id: 'p1', score: 900 }])
          : flat([
              { id: 'a98', score: 500 },
              { id: 'a99', score: 490 },
              { id: 'a100', score: 480 },
              { id: 'SELF', score: 470 },
              { id: 'a102', score: 460 },
              { id: 'a103', score: 450 },
            ]),
      ),
    );

    const res = await getLeaderboard(WEEK, 'SELF');

    expect(res.me).toBeDefined();
    const me = res.me!;
    expect(me.window.map((e) => e.rank)).toEqual([98, 99, 100, 101, 102, 103]);
    expect(me.entry).toMatchObject({ rank: 101, playerId: 'SELF', username: 'Name_SELF' });
    expect(fakeRedis.zrevrange).toHaveBeenCalledWith(LB_KEY, 97, 102, 'WITHSCORES');
  });
});
