/**
 * Prize distribution — the money math, as a PURE function so it can be unit-tested
 * hard and reused by the close-week routine. No I/O, no Redis/Postgres here.
 *
 * All amounts are INTEGERS in the smallest currency unit (e.g. kuruş/cents).
 * Rules (see CLAUDE.md / DECISIONS.md):
 *   - rank 1 → 20% of pool, rank 2 → 15%, rank 3 → 10%
 *   - ranks 4..cap → share the remaining 55%, weighted linearly by rank:
 *       w(rank) = (cap + 1) - rank   (higher rank ⇒ larger weight)
 *     each present rank r gets  share55 × w(r) / Σw(present ranks 4..n)
 *   - Every share is floored to an integer, then the leftover whole units (the
 *     rounding "dust") are handed out one-by-one via the LARGEST REMAINDER method:
 *     the units go to the players whose exact share had the biggest fractional
 *     part. This keeps every payout within 1 minor unit of its exact value AND
 *     makes Σ payouts == the distributable amount — without inflating rank 1.
 */

export interface Payout {
  /** 1-indexed final rank. */
  rank: number;
  playerId: string;
  /** Prize in integer minor units. */
  prize: number;
}

export interface DistributionOptions {
  /**
   * Number of paid slots on the board. Product spec = 100 (⇒ weight 101 - rank).
   * Exposed only so tests can scale the example down (e.g. a 10-slot board with
   * weight 11 - rank); production always uses the default.
   */
  boardCap?: number;
}

/** Fixed top-3 percentages and the weighted remainder, as integers. */
const PCT = { rank1: 20, rank2: 15, rank3: 10, rest: 55 } as const;

/**
 * Distribute an integer `pool` (minor units) across players given in rank order
 * (index 0 = rank 1). Returns one Payout per player (capped at `boardCap`).
 *
 * Guarantees: Σ prize ≤ pool always; == pool when the board is full (≥ boardCap
 * players) and pool > 0; each prize ≥ 0; no floats leak into the amounts.
 */
export function computePayouts(
  rankedPlayerIds: readonly string[],
  pool: number,
  options: DistributionOptions = {},
): Payout[] {
  const boardCap = options.boardCap ?? 100;
  const n = Math.min(rankedPlayerIds.length, boardCap);
  const players = rankedPlayerIds.slice(0, Math.max(n, 0));

  // Nothing to pay: empty board or empty pool → everyone gets 0.
  if (n === 0 || pool <= 0) {
    return players.map((playerId, i) => ({ rank: i + 1, playerId, prize: 0 }));
  }

  const share55 = (pool * PCT.rest) / 100;

  // Σ of weights for the ranks that actually exist (4..n), so the 55% is shared
  // among present players and never left partly unassigned by a missing rank.
  let sumW = 0;
  for (let rank = 4; rank <= n; rank++) sumW += boardCap + 1 - rank;

  const exactShare = (rank: number): number => {
    if (rank === 1) return (pool * PCT.rank1) / 100;
    if (rank === 2) return (pool * PCT.rank2) / 100;
    if (rank === 3) return (pool * PCT.rank3) / 100;
    return sumW === 0 ? 0 : (share55 * (boardCap + 1 - rank)) / sumW;
  };

  // Floor every share; remember the fractional part for the largest-remainder pass.
  const rows = players.map((playerId, i) => {
    const rank = i + 1;
    const exact = exactShare(rank);
    const floored = Math.floor(exact);
    return { rank, playerId, prize: floored, frac: exact - floored };
  });

  // How many whole minor units are still undistributed (pure rounding dust).
  const dust = Math.round(rows.reduce((sum, r) => sum + r.frac, 0));

  // Largest remainder: biggest fractional part first; ties → higher rank (smaller rank number).
  const byFrac = [...rows].sort((a, b) => b.frac - a.frac || a.rank - b.rank);
  for (let k = 0; k < dust && k < byFrac.length; k++) {
    // Non-null: k is bounded by byFrac.length.
    byFrac[k]!.prize += 1;
  }

  return rows.map(({ rank, playerId, prize }) => ({ rank, playerId, prize }));
}