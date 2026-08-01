import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPlayerSample } from '../services/sample.js';
import { getCurrentWeekId } from '../utils/week.js';

export const sampleRouter = Router();

const querySchema = z.object({
  n: z.coerce.number().int().min(1).max(20).optional(),
});

sampleRouter.get('/players/sample', async (req: Request, res: Response) => {
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
    const result = await getPlayerSample(weekId, parsed.data.n);
    res.status(200).json(result);
  } catch (err) {
    console.error('[sample] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
