import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getLeaderboard } from '../services/leaderboard.js';
import { getCurrentWeekId } from '../utils/week.js';

export const leaderboardRouter = Router();

const querySchema = z.object({
  playerId: z.string().min(1).optional(),
});

leaderboardRouter.get('/leaderboard', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_query',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const weekId = getCurrentWeekId();

  try {
    const result = await getLeaderboard(weekId, parsed.data.playerId);
    res.status(200).json(result);
  } catch (err) {
    console.error('[leaderboard] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});