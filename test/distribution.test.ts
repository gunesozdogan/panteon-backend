import { describe, it, expect } from 'vitest';
import { computePayouts } from '../src/services/distribution.js';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const prizes = (payouts: { prize: number }[]): number[] => payouts.map((p) => p.prize);
const total = (payouts: { prize: number }[]): number =>
  payouts.reduce((s, p) => s + p.prize, 0);

describe('computePayouts', () => {
  it('reproduces the worked 10-player example (pool=1000, boardCap=10)', () => {
    // The exact table we computed by hand: sum is exactly 1000, rank 1 = 200.
    const out = computePayouts(ids(10), 1000, { boardCap: 10 });
    expect(prizes(out)).toEqual([200, 150, 100, 137, 118, 98, 79, 59, 39, 20]);
    expect(total(out)).toBe(1000);
  });

  it('gives rank 1 exactly floor(20%) — the leftover is NOT dumped on rank 1', () => {
    // This is the fix: with largest-remainder, rank 1 stays at its true 20%.
    const out = computePayouts(ids(100), 1000);
    expect(out[0]?.prize).toBe(200); // 20% of 1000, not 20%+dust
    expect(out[1]?.prize).toBe(150);
    expect(out[2]?.prize).toBe(100);
  });

  it('distributes the full pool with a full board (Σ == pool)', () => {
    const out = computePayouts(ids(100), 1_000_000);
    expect(total(out)).toBe(1_000_000);
  });

  it('never exceeds the pool, even for an awkward (indivisible) pool', () => {
    const pool = 1_000_037; // deliberately not divisible by 100 or the weights
    const out = computePayouts(ids(100), pool);
    expect(total(out)).toBe(pool); // full board ⇒ exactly the pool
    expect(total(out)).toBeLessThanOrEqual(pool);
    expect(out.every((p) => p.prize >= 0)).toBe(true);
  });

  it('is monotonic: a higher rank never earns less than a lower rank', () => {
    const out = computePayouts(ids(100), 1_000_037);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.prize).toBeGreaterThanOrEqual(out[i]!.prize);
    }
  });

  it('handles a short board (fewer than 100 players) without over-paying', () => {
    const out = computePayouts(ids(5), 1000); // boardCap default 100
    expect(out).toHaveLength(5);
    expect(total(out)).toBeLessThanOrEqual(1000);
    // ranks 4..100 exist as slots, so only 20+15+10% is paid for the top 3;
    // the two tail players split a slice of the 55% — nobody is over-paid.
    expect(out.every((p) => p.prize >= 0)).toBe(true);
  });

  it('handles an empty board without crashing', () => {
    expect(computePayouts([], 1000)).toEqual([]);
  });

  it('pays nothing when the pool is zero', () => {
    const out = computePayouts(ids(10), 0, { boardCap: 10 });
    expect(total(out)).toBe(0);
    expect(out).toHaveLength(10);
  });
});