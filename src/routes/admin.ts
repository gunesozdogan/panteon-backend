import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { closeWeek } from '../services/closeWeek.js';
import { simulateEarns, SIMULATE_DEFAULTS } from '../services/simulate.js';
import { getCurrentWeekId } from '../utils/week.js';
import { getRedis } from '../db/redis.js';
import { keys } from '../utils/keys.js';
import { env } from '../config/env.js';

export const adminRouter = Router();

/**
 * Body:
 *  - `weekId` (optional): the week to close. Omitted → the CURRENT week (handy
 *    for closing seeded demo data on the spot). The cron sweeps its own weeks.
 *    Must look like a plain ISO week (`2026-W31`); snapshot ids are minted
 *    server-side, never accepted from the client.
 *  - `early` (optional): run a DEMO close of the current live week on demand.
 *    Reads current standings, distributes + archives them under a server-minted
 *    `-early` id, credits wallets, AND resets the live board (scores + pool back
 *    to 0). The calendar `weekId` is unchanged (still `2026-W31`), so the `-early`
 *    output id is what keeps repeated demo closes from colliding in Mongo. Each
 *    close pays only the earnings accumulated since the previous one, so the total
 *    distributed stays exactly 2% of earnings (no over-distribution). See §30/§37.
 */
const bodySchema = z.object({
  weekId: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'weekId must look like 2026-W31')
    .optional(),
  early: z.boolean().optional(),
});

/**
 * Mint the next snapshot output id for a source week: 1 → `2026-W31-early`,
 * 2 → `2026-W31-early2`, … via a monotonic Redis counter, so repeated snapshots
 * of the same week never collide (each is a distinct, permanent archive id).
 */
async function nextEarlyWeekId(sourceWeekId: string): Promise<string> {
  const n = await getRedis().incr(keys.earlyCount(sourceWeekId));
  return `${sourceWeekId}${n === 1 ? '-early' : `-early${n}`}`;
}

/**
 * `POST /admin/close-week` — run distribution (+ reset, unless `early`) for a
 * week on demand. Also wired to a scheduled sweep (see scheduler/weeklyClose.ts).
 * Idempotent, so a retry after a failure is safe.
 */
adminRouter.post('/admin/close-week', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  try {
    if (parsed.data.early) {
      const sourceWeekId = getCurrentWeekId();
      const outputWeekId = await nextEarlyWeekId(sourceWeekId);
      const result = await closeWeek(sourceWeekId, { outputWeekId, reset: true });
      res.status(200).json(result);
      return;
    }
    const weekId = parsed.data.weekId ?? getCurrentWeekId();
    const result = await closeWeek(weekId);
    res.status(200).json(result);
  } catch (err) {
    console.error('[admin/close-week] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

const SIMULATE_MAX_COUNT = SIMULATE_DEFAULTS.maxCount;

const simulateSchema = z.object({
  count: z.number().int().positive().max(SIMULATE_MAX_COUNT).optional(),
});

/**
 * `POST /admin/simulate` — demo "live traffic": apply a small batch of random
 * earns to the current week so the board keeps moving. The frontend fires this
 * on its poll tick (default-on "Live demo" toggle), which is what makes the
 * deployed board feel alive without any in-process timer — the browser drives
 * it, so the API stays stateless (every instance is equal). Gated by
 * `ENABLE_SIMULATOR` (default on for the demo; off for a real production
 * deploy). Only touches Redis ranking + earn_total. See docs/live-data-flow.md.
 */
adminRouter.post('/admin/simulate', async (req: Request, res: Response) => {
  if (!env.ENABLE_SIMULATOR) {
    res.status(403).json({ error: 'simulator_disabled' });
    return;
  }

  const parsed = simulateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  try {
    const weekId = getCurrentWeekId();
    const result = await simulateEarns(weekId, {
      ...SIMULATE_DEFAULTS,
      ...(parsed.data.count !== undefined ? { count: parsed.data.count } : {}),
    });
    res.status(200).json(result);
  } catch (err) {
    console.error('[admin/simulate] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
