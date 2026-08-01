import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getWeeklyStandings, listArchivedWeeks } from '../services/history.js';

export const historyRouter = Router();

/**
 * `GET /leaderboard/history` — lean summaries of every archived week, newest
 * first, for the frontend "past weeks" picker. No params. Registered before the
 * `:weekId` route (distinct paths, but kept ordered for clarity).
 */
historyRouter.get('/leaderboard/history', async (_req: Request, res: Response) => {
  try {
    const weeks = await listArchivedWeeks();
    res.status(200).json({ weeks });
  } catch (err) {
    console.error('[history:list] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * weekId is an ISO week like `2026-W31` (matches getCurrentWeekId output), with
 * an optional `-early[n]` suffix for demo snapshot archives (see admin route /
 * docs/manual-close-week.md) so history reads can surface them too.
 */
const paramsSchema = z.object({
  weekId: z
    .string()
    .regex(/^\d{4}-W\d{2}(-early\d*)?$/, 'weekId must look like 2026-W31 or 2026-W31-early'),
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
