import { describe, it, expect } from 'vitest';
import {
  parseWithScores,
  windowRange,
  toEntries,
  type ScoredMember,
} from '../src/services/leaderboard.js';

describe('parseWithScores', () => {
  it('decodes a flat WITHSCORES reply into typed pairs', () => {
    const out = parseWithScores(['p1', '900', 'p2', '850', 'p3', '800']);
    expect(out).toEqual([
      { playerId: 'p1', score: 900 },
      { playerId: 'p2', score: 850 },
      { playerId: 'p3', score: 800 },
    ]);
  });

  it('returns [] for an empty reply', () => {
    expect(parseWithScores([])).toEqual([]);
  });

  it('ignores a dangling member with no score (defensive)', () => {
    expect(parseWithScores(['p1', '900', 'p2'])).toEqual([
      { playerId: 'p1', score: 900 },
    ]);
  });
});

describe('windowRange', () => {
  it('returns a full 6-row window in the middle of a large board', () => {
    const { start, stop } = windowRange(149, 5000);
    expect({ start, stop }).toEqual({ start: 146, stop: 151 });
    expect(stop - start + 1).toBe(6);
  });

  it('at the very top (rank 1): no rows above, clamps start to 0', () => {
    const { start, stop } = windowRange(0, 5000);
    expect(start).toBe(0);
    expect(stop).toBe(2);
  });

  it('at rank 2 and rank 3: fewer than 3 above, still clamped to 0', () => {
    expect(windowRange(1, 5000)).toEqual({ start: 0, stop: 3 });
    expect(windowRange(2, 5000)).toEqual({ start: 0, stop: 4 });
  });

  it('boundary rank 100 vs 101 (0-indexed 99 vs 100)', () => {
    expect(windowRange(99, 5000)).toEqual({ start: 96, stop: 101 });
    expect(windowRange(100, 5000)).toEqual({ start: 97, stop: 102 });
  });

  it('at the very bottom: fewer than 2 below, clamps stop to total-1', () => {
    const { start, stop } = windowRange(199, 200);
    expect(stop).toBe(199);
    expect(start).toBe(196);
  });

  it('one from the bottom: exactly 1 row below', () => {
    const { start, stop } = windowRange(198, 200);
    expect(stop).toBe(199);
    expect(start).toBe(195);
  });

  it('tiny board smaller than the window: clamps both ends', () => {
    expect(windowRange(1, 3)).toEqual({ start: 0, stop: 2 });
  });
});

describe('toEntries', () => {
  const rows: ScoredMember[] = [
    { playerId: 'p10', score: 500 },
    { playerId: 'p11', score: 480 },
    { playerId: 'p12', score: 470 },
  ];
  const names = new Map([
    ['p10', 'Alice'],
    ['p11', 'Bob'],
  ]);
  const nameOf = (id: string): string | undefined => names.get(id);

  it('assigns consecutive 1-indexed ranks from startRank', () => {
    const out = toEntries(rows, 101, nameOf);
    expect(out.map((e) => e.rank)).toEqual([101, 102, 103]);
    expect(out[0]).toEqual({
      rank: 101,
      playerId: 'p10',
      username: 'Alice',
      score: 500,
    });
  });

  it('falls back to the playerId when a username is missing', () => {
    const out = toEntries(rows, 1, nameOf);
    expect(out[2]?.username).toBe('p12');
  });
});