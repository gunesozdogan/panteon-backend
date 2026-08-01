/**
 * Leaderboard read path — the hot path served on every board open (2M DAU).
 *
 * Design (see CLAUDE.md):
 *   - Top 100 is IDENTICAL for every player, so it is cached serialized in
 *     `lb:top100:{weekId}` with a short TTL. Only the caller's own rank/window is
 *     computed per-request. This is the main scalability lever.
 *
 * The index/offset math (window selection, rank assignment, WITHSCORES parsing)
 * is factored into PURE functions below so the off-by-one-prone parts are unit
 * tested without touching Redis.
 */
import { getRedis } from '../db/redis.js';
import { getUsernames } from './players.js';
import { poolFromEarnTotal } from './distribution.js';
import { keys } from '../utils/keys.js';
import type {
  LeaderboardEntry,
  LeaderboardResponse,
  SelfView,
  WeekId,
} from '../types/domain.js';

/** How many rows above/below the caller in the self-window (3 above, 2 below). */
const WINDOW_ABOVE = 3;
const WINDOW_BELOW = 2;

/** Size of the always-returned leaderboard head. */
const TOP_N = 100;

/**
 * Cache TTL for the serialized top-100 payload. Short (a few seconds) so the
 * board feels live while still collapsing a burst of identical reads into one
 * Redis range + username join.
 */
const TOP100_TTL_SECONDS = 2;


export interface ScoredMember {
  playerId: string;
  score: number;
}

/**
 * PURE. Decode a flat Redis `WITHSCORES` reply (`[member, score, member, ...]`)
 * into typed pairs.
 */
export function parseWithScores(flat: readonly string[]): ScoredMember[] {
  const out: ScoredMember[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({ playerId: flat[i]!, score: Number(flat[i + 1]!) });
  }
  return out;
}

/**
 * PURE. Given a player's 0-indexed rank and the board size, compute the
 * inclusive `ZREVRANGE` [start, stop] indices for the self-window: up to
 * `above` rows above and `below` below, clamped to the board so we never ask
 * Redis for out-of-range indices.
 */
export function windowRange(
  rank0: number,
  total: number,
  above: number = WINDOW_ABOVE,
  below: number = WINDOW_BELOW,
): { start: number; stop: number } {
  const start = Math.max(0, rank0 - above);
  const stop = Math.min(total - 1, rank0 + below);
  return { start, stop };
}

/**
 * PURE. Turn ranked `(playerId, score)` pairs into display entries, assigning
 * consecutive 1-indexed ranks starting at `startRank` and resolving usernames
 * via `nameOf` (falls back to the id if a name is somehow missing).
 */
export function toEntries(
  rows: readonly ScoredMember[],
  startRank: number,
  nameOf: (playerId: string) => string | undefined,
): LeaderboardEntry[] {
  return rows.map((row, i) => ({
    rank: startRank + i,
    playerId: row.playerId,
    username: nameOf(row.playerId) ?? row.playerId,
    score: row.score,
  }));
}

/**
 * Batch-resolve usernames from the `players:meta` hash in a single `HMGET`, so
 * a 100-row page costs one round trip instead of 100 Postgres lookups.
 *
 * On a cache miss we back-fill from Postgres (the source of truth) in ONE
 * `= ANY($1)` query and warm the hash so the next read is a pure cache hit —
 * the hash self-heals. Only truly-unknown ids fall back to the raw playerId.
 */
export async function resolveUsernames(
  playerIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (playerIds.length === 0) return map;

  const redis = getRedis();
  const names = await redis.hmget(keys.playersMeta, ...playerIds);
  const missing: string[] = [];
  playerIds.forEach((id, i) => {
    const name = names[i];
    if (name != null) map.set(id, name);
    else missing.push(id);
  });

  if (missing.length > 0) {
    const fromPg = await getUsernames(missing);
    if (fromPg.size > 0) {
      const hsetArgs: string[] = [];
      for (const [id, name] of fromPg) {
        map.set(id, name);
        hsetArgs.push(id, name);
      }
      await redis.hset(keys.playersMeta, ...hsetArgs);
    }
  }
  return map;
}

/**
 * Build the top-100 page, served from the `lb:top100:{weekId}` cache when warm.
 */
async function getTop(weekId: WeekId): Promise<LeaderboardEntry[]> {
  const redis = getRedis();
  const cacheKey = keys.top100(weekId);

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as LeaderboardEntry[];

  const flat = await redis.zrevrange(
    keys.leaderboard(weekId),
    0,
    TOP_N - 1,
    'WITHSCORES',
  );
  const rows = parseWithScores(flat);
  const names = await resolveUsernames(rows.map((r) => r.playerId));
  const entries = toEntries(rows, 1, (id) => names.get(id));

  await redis.set(cacheKey, JSON.stringify(entries), 'EX', TOP100_TTL_SECONDS);
  return entries;
}

/**
 * Compute the caller's self-view when they are OUTSIDE the top 100: the 6-row
 * window (3 above + self + 2 below, clamped at the board edge) plus their own
 * entry pulled out of it for convenient rendering.
 */
async function getSelfView(
  playerId: string,
  weekId: WeekId,
  rank0: number,
): Promise<SelfView> {
  const redis = getRedis();
  const lbKey = keys.leaderboard(weekId);

  const total = await redis.zcard(lbKey);
  const { start, stop } = windowRange(rank0, total);

  const flat = await redis.zrevrange(lbKey, start, stop, 'WITHSCORES');
  const rows = parseWithScores(flat);
  const names = await resolveUsernames(rows.map((r) => r.playerId));
  const window = toEntries(rows, start + 1, (id) => names.get(id));
  const entry =
    window.find((e) => e.playerId === playerId) ??
    { rank: rank0 + 1, playerId, username: names.get(playerId) ?? playerId, score: 0 };

  return { entry, window };
}

/**
 * Read the live prize pool: 2% of the week's raw earnings so far. This is a
 * single integer `GET` on `earn_total:{weekId}` (missing key → 0), kept OUT of
 * the cached top-100 payload so it reflects live earnings on every read while
 * staying cheap enough for the hot path. Mirrors the exact rounding used at
 * close-week via the shared `poolFromEarnTotal`.
 */
async function getLivePool(weekId: WeekId): Promise<number> {
  const raw = await getRedis().get(keys.earnTotal(weekId));
  return poolFromEarnTotal(Number(raw) || 0);
}

/**
 * Serve `GET /leaderboard`: always the top 100, plus the caller's own window
 * when they are outside it.
 *
 *   - rank < 100  → caller is already in `top`; `me` is omitted (the frontend
 *                   highlights the row by matching its own playerId).
 *   - rank >= 100 → `me` carries the self-window.
 *   - not ranked / no playerId → `me` omitted.
 */
export async function getLeaderboard(
  weekId: WeekId,
  playerId?: string,
): Promise<LeaderboardResponse> {
  const top = await getTop(weekId);
  const pool = await getLivePool(weekId);
  const totalPlayers = await getRedis().zcard(keys.leaderboard(weekId));

  const response: LeaderboardResponse = { weekId, top, pool, totalPlayers };

  if (!playerId) return response;

  const rank0 = await getRedis().zrevrank(keys.leaderboard(weekId), playerId);
  if (rank0 === null || rank0 < TOP_N) return response;

  response.me = await getSelfView(playerId, weekId, rank0);
  return response;
}