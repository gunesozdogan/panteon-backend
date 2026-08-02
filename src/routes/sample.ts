import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPlayerSample, getPlayerRanks } from '../services/sample.js';
import { getCurrentWeekId } from '../utils/week.js';

export const sampleRouter = Router();

const querySchema = z.object({
  n: z.coerce.number().int().min(1).max(20).optional(),
});

const ranksQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
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

/**
 * `GET /players/ranks?ids=p1,p2,…` — current rank/label for a SPECIFIC set of
 * players (the picker's in-place refresh: same faces, fresh ranks). Ids that have
 * dropped off the board (e.g. after a reset) are omitted from the response.
 */
sampleRouter.get('/players/ranks', async (req: Request, res: Response) => {
  const parsed = ranksQuerySchema.safeParse(req.query);
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
    const result = await getPlayerRanks(weekId, parsed.data.ids);
    res.status(200).json(result);
  } catch (err) {
    console.error('[ranks] failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
