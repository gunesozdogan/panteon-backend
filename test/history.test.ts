/**
 * Unit tests for the Mongo history archive (archive + read-back), with the Mongo
 * driver mocked by a tiny in-memory collection so the suite stays hermetic — no
 * running MongoDB required.
 *
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WeeklyStandingsDoc } from '../src/types/domain.js';

const { store, fakeCol } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const fakeCol = {
    createIndex: vi.fn().mockResolvedValue('weekId_1'),
    replaceOne: vi.fn(
      async (filter: { weekId: string }, doc: Record<string, unknown>) => {
        store.set(filter.weekId, { _id: 'oid', ...doc });
        return { acknowledged: true, upsertedCount: 1 };
      },
    ),
    findOne: vi.fn(
      async (
        filter: { weekId: string },
        opts?: { projection?: Record<string, 0 | 1> },
      ) => {
        const doc = store.get(filter.weekId);
        if (!doc) return null;
        const copy = { ...doc };
        if (opts?.projection?._id === 0) delete copy._id;
        return copy;
      },
    ),
  };
  return { store, fakeCol };
});

vi.mock('../src/db/mongo.js', () => ({
  getMongoDb: async () => ({ collection: () => fakeCol }),
}));

import {
  archiveWeeklyStandings,
  getWeeklyStandings,
} from '../src/services/history.js';

const docFor = (weekId: string, prize: number): WeeklyStandingsDoc => ({
  weekId,
  closedAt: '2026-07-27T00:00:00.000Z',
  standings: [
    { rank: 1, playerId: 'p1', username: 'Player_1', score: 999, prize },
    { rank: 2, playerId: 'p2', username: 'Player_2', score: 500, prize: 0 },
  ],
});

describe('history archive (Mongo mocked)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('archive then read returns the same document', async () => {
    const doc = docFor('2026-W30', 200);
    await archiveWeeklyStandings(doc);

    const read = await getWeeklyStandings('2026-W30');
    expect(read).toEqual(doc);
  });

  it('never leaks the internal Mongo _id', async () => {
    await archiveWeeklyStandings(docFor('2026-W30', 200));
    const read = await getWeeklyStandings('2026-W30');
    expect(read).not.toHaveProperty('_id');
  });

  it('re-archiving the same week overwrites, never duplicates (idempotent)', async () => {
    await archiveWeeklyStandings(docFor('2026-W30', 200));
    await archiveWeeklyStandings(docFor('2026-W30', 777)); // re-run close-week

    expect(store.size).toBe(1);
    const read = await getWeeklyStandings('2026-W30');
    expect(read?.standings[0]?.prize).toBe(777);
  });

  it('unknown week reads back as null (→ 404 at the route)', async () => {
    const read = await getWeeklyStandings('2099-W01');
    expect(read).toBeNull();
  });
});
