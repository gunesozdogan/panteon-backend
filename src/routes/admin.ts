import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { closeWeek } from '../services/closeWeek.js';
import { getCurrentWeekId } from '../utils/week.js';

export const adminRouter = Router();

/**
 * Optional `weekId` in the body. Omitted → close the CURRENT week (handy for
 * closing seeded demo data on the spot). The cron passes the just-ended week
 * explicitly. Must look like an ISO week (`2026-W31`) when provided.
 */
const bodySchema = z.object({
  weekId: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'weekId must look like 2026-W31')
    .optional(),
});

/**
 * `POST /admin/close-week` — run distribution + reset for a week on demand.
 * Also wired to a scheduled job (see scheduler/weeklyClose.ts). Idempotent, so
 * a retry after a failure is safe.
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

  const weekId = parsed.data.weekId ?? getCurrentWeekId();

  try {
    const result = await closeWeek(weekId);
    res.status(200).json(result);
  } catch (err) {
    console.error('[admin/close-week] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
