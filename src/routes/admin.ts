import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { closeWeek } from '../services/closeWeek.js';
import { getCurrentWeekId } from '../utils/week.js';
import { getRedis } from '../db/redis.js';
import { keys } from '../utils/keys.js';

export const adminRouter = Router();

/**
 * Body:
 *  - `weekId` (optional): the week to close. Omitted → the CURRENT week (handy
 *    for closing seeded demo data on the spot). The cron sweeps its own weeks.
 *    Must look like a plain ISO week (`2026-W31`); snapshot ids are minted
 *    server-side, never accepted from the client.
 *  - `early` (optional): run a DEMO SNAPSHOT of the current live week instead of
 *    a real close. Reads current standings, distributes + archives them under a
 *    server-minted `-early` id, and DOES NOT reset the board — the week keeps
 *    running.
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
      const result = await closeWeek(sourceWeekId, { outputWeekId, reset: false });
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
