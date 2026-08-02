/**
 * Unit tests for the demo live-traffic generator, with Redis mocked so the suite
 * stays hermetic. The behaviour we lock in:
 *   - picks players via ZRANDMEMBER and bumps each one (ZINCRBY)
 *   - earn_total is incremented by the SUM of the batch (kept in step with scores)
 *   - all writes go through a single pipeline (one round trip)
 *   - an empty board is a safe no-op (no writes, playersHit 0)
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
    zcard: vi.fn(),
    zrandmember: vi.fn(),
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
});

describe('simulateEarns', () => {
  it('bumps each random player and increments earn_total by the batch sum', async () => {
    fakeRedis.zcard.mockResolvedValue(1000);
    fakeRedis.zrandmember.mockResolvedValue(['p3', 'p7', 'p12']);

    const result = await simulateEarns(WEEK, {
      ...SIMULATE_DEFAULTS,
      count: 3,
      minAmount: 100,
      maxAmount: 100,
    });

    expect(fakeRedis.zrandmember).toHaveBeenCalledWith('lb:2026-W31', 3);
    expect(pipeline.zincrbyArgs).toEqual([
      ['lb:2026-W31', 100, 'p3'],
      ['lb:2026-W31', 100, 'p7'],
      ['lb:2026-W31', 100, 'p12'],
    ]);
    expect(pipeline.incrbyArgs).toEqual([['earn_total:2026-W31', 300]]);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ weekId: WEEK, boardSize: 1000, playersHit: 3, totalEarned: 300 });
  });

  it('defaults to 1% of the board when no explicit count is given', async () => {
    fakeRedis.zcard.mockResolvedValue(100_000);
    fakeRedis.zrandmember.mockResolvedValue(['x']);

    await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.zrandmember).toHaveBeenCalledWith('lb:2026-W31', 1000);
  });

  it('floors the fraction to minCount on a tiny board', async () => {
    fakeRedis.zcard.mockResolvedValue(50);
    fakeRedis.zrandmember.mockResolvedValue(['x']);

    await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.zrandmember).toHaveBeenCalledWith('lb:2026-W31', SIMULATE_DEFAULTS.minCount);
  });

  it('caps the fraction at maxCount on a huge board', async () => {
    fakeRedis.zcard.mockResolvedValue(10_000_000);
    fakeRedis.zrandmember.mockResolvedValue(['x']);

    await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.zrandmember).toHaveBeenCalledWith('lb:2026-W31', SIMULATE_DEFAULTS.maxCount);
  });

  it('keeps every earn within the requested range', async () => {
    fakeRedis.zcard.mockResolvedValue(1000);
    fakeRedis.zrandmember.mockResolvedValue(['a', 'b', 'c', 'd', 'e']);

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

  it('is a no-op on an empty board (no pipeline, no writes)', async () => {
    fakeRedis.zcard.mockResolvedValue(0);

    const result = await simulateEarns(WEEK, SIMULATE_DEFAULTS);

    expect(fakeRedis.zrandmember).not.toHaveBeenCalled();
    expect(fakeRedis.multi).not.toHaveBeenCalled();
    expect(result).toEqual({ weekId: WEEK, boardSize: 0, playersHit: 0, totalEarned: 0 });
  });
});
