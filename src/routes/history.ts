import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getWeeklyStandings } from '../services/history.js';

export const historyRouter = Router();

/** weekId must be an ISO-week like `2026-W31` (matches getCurrentWeekId output). */
const paramsSchema = z.object({
  weekId: z.string().regex(/^\d{4}-W\d{2}$/, 'weekId must look like 2026-W31'),
});

historyRouter.get(
  '/leaderboard/history/:weekId',
  async (req: Request, res: Response) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_params',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    try {
      const doc = await getWeeklyStandings(parsed.data.weekId);
      if (!doc) {
        res.status(404).json({ error: 'not_found', weekId: parsed.data.weekId });
        return;
      }
      res.status(200).json(doc);
    } catch (err) {
      console.error('[history] failed:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  },
);
