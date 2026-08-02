/**
 * Unit tests for the demo live-traffic generator, with Redis mocked so the suite
 * stays hermetic. The behaviour we lock in:
 *   - draws players from the ROSTER (HRANDFIELD players:meta), not just the board,
 *     so the board grows toward the full roster and refills after a reset
 *   - each drawn player is bumped (ZINCRBY, which creates new members too)
 *   - earn_total is incremented by the SUM of the batch (kept in step with scores)
 *   - all writes go through a single pipeline (one round trip)
 *   - count scales with the roster, clamped to [minCount, maxCount]
 *   - an empty roster (nothing seeded) is a safe no-op
 *   - only Redis ranking + earn_total are touched (money path never called)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fakeRedis, pipeline } = vi.hoisted(() => {
  const pipeline = {
    zincrbyArgs: [] as Array<[string, number, string]>,
    incrbyArgs: [] as Array<[string, number]>,
    zincrby: vi.fn(function (this: unknown, key: string, amount: number, member: string) {
      pipeline.zincrbyArgs.push([key, amount, member]);
      return pipeline;
    }),
    incrby: vi.fn(function (this: unknown, key: string, amount: number) {
      pipeline.incrbyArgs.push([key, amount]);
      return pipeline;
    }),
    exec: vi.fn(async () => []),
  };

  const fakeRedis = {
    hlen: vi.fn(),
    hrandfield: vi.fn(),
    zcard: vi.fn(async () => 0),
    multi: vi.fn(() => pipeline),
  };

  return { fakeRedis, pipeline };
});

vi.mock('../src/db/redis.js', () => ({ getRedis: () => fakeRedis }));

import { simulateEarns, SIMULATE_DEFAULTS } from '../src/services/simulate.js';
import type { WeekId } from '../src/types/domain.js';

const WEEK = '2026-W31' as WeekId;

beforeEach(() => {
  vi.clearAllMocks();
  pipeline.zincrbyArgs.length = 0;
  pipeline.incrbyArgs.length = 0;
  fakeRedis.zcard.mockResolvedValue(0);
});

describe('simulateEarns', () => {
  it('draws players from the roster and increments earn_total by the batch sum', async () => {
    fakeRedis.hlen.mockResolvedValue(1000);
    fakeRedis.hrandfield.mockResolvedValue(['p3', 'p7', 'p12']);
    fakeRedis.zcard.mockResolvedValue(42);

    const result = await simulateEarns(WEEK, {
      ...SIMULATE_DEFAULTS,
      count: 3,
      minAmount: 100,
      maxAmount: 100,
    });

    expect(fakeRedis.hrandfield).toHaveBeenCalledWith('players:meta', 3);
    expect(pipeline.zincrbyArgs).toEqual([
      ['lb:2026-W31', 100, 'p3'],
      ['lb:2026-W31', 100, 'p7'],
      ['lb:2026-W31', 100, 'p12'],
    ]);
    expect(pipeline.incrbyArgs).toEqual([['earn_total:2026-W31', 300]]);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ weekId: WEEK, boardSize: 42, playersHit: 3, totalEarned: 300 });
  });

  it('defaults the count to the configured fraction of the roster', async () => {
    fakeRedis.hlen.mockResolvedValue(100_000);
    fakeRedis.hrandfield.mockResolvedValue(['x']);

    await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    const expected = Math.min(
      SIMULATE_DEFAULTS.maxCount,
      Math.max(SIMULATE_DEFAULTS.minCount, Math.floor(100_000 * SIMULATE_DEFAULTS.fraction)),
    );
    expect(fakeRedis.hrandfield).toHaveBeenCalledWith('players:meta', expected);
  });

  it('floors the fraction to minCount on a tiny roster', async () => {
    fakeRedis.hlen.mockResolvedValue(50);
    fakeRedis.hrandfield.mockResolvedValue(['x']);

    await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.hrandfield).toHaveBeenCalledWith('players:meta', SIMULATE_DEFAULTS.minCount);
  });

  it('caps the fraction at maxCount on a huge roster', async () => {
    fakeRedis.hlen.mockResolvedValue(10_000_000);
    fakeRedis.hrandfield.mockResolvedValue(['x']);

    await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.hrandfield).toHaveBeenCalledWith('players:meta', SIMULATE_DEFAULTS.maxCount);
  });

  it('keeps every earn within the requested range', async () => {
    fakeRedis.hlen.mockResolvedValue(1000);
    fakeRedis.hrandfield.mockResolvedValue(['a', 'b', 'c', 'd', 'e']);

    await simulateEarns(WEEK, {
      ...SIMULATE_DEFAULTS,
      count: 5,
      minAmount: 10,
      maxAmount: 20,
    });

    for (const [, amount] of pipeline.zincrbyArgs) {
      expect(amount).toBeGreaterThanOrEqual(10);
      expect(amount).toBeLessThanOrEqual(20);
    }
  });

  it('refills an empty board by onboarding roster players (ZINCRBY creates members)', async () => {
    fakeRedis.hlen.mockResolvedValue(200);
    fakeRedis.hrandfield.mockResolvedValue(['p3', 'p7', 'p12']);
    fakeRedis.zcard.mockResolvedValue(3);

    const result = await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(pipeline.zincrbyArgs.map((a) => a[2])).toEqual(['p3', 'p7', 'p12']);
    expect(result.playersHit).toBe(3);
    expect(result.boardSize).toBe(3);
  });

  it('is a no-op when the roster is empty (nothing seeded)', async () => {
    fakeRedis.hlen.mockResolvedValue(0);

    const result = await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.hrandfield).not.toHaveBeenCalled();
    expect(fakeRedis.multi).not.toHaveBeenCalled();
    expect(result).toEqual({ weekId: WEEK, boardSize: 0, playersHit: 0, totalEarned: 0 });
  });
});
