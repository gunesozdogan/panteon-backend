import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { recordEarn } from '../services/earn.js';
import { getCurrentWeekId } from '../utils/week.js';

export const eventsRouter = Router();

const earnSchema = z.object({
  playerId: z.string().min(1),
  amount: z.number().int().positive(),
});

eventsRouter.post('/events/earn', async (req: Request, res: Response) => {
  const parsed = earnSchema.safeParse(req.body);
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

  const { playerId, amount } = parsed.data;
  const weekId = getCurrentWeekId();

  try {
    const result = await recordEarn(playerId, amount, weekId);
    res.status(200).json(result);
  } catch (err) {
    console.error('[events/earn] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});