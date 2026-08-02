import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPlayerWallet } from '../services/players.js';

export const playersRouter = Router();

const paramsSchema = z.object({
  playerId: z.string().min(1).max(64),
});

/**
 * `GET /players/:playerId/wallet` — a player's durable money view (balance +
 * per-close payout history), from Postgres (money source of truth), NOT Redis.
 * This is what surfaces the wallet credits that close-week writes; the live
 * competition score stays on `GET /leaderboard`. 404 when the id is unknown.
 */
playersRouter.get(
  '/players/:playerId/wallet',
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
      const wallet = await getPlayerWallet(parsed.data.playerId);
      if (!wallet) {
        res.status(404).json({ error: 'player_not_found' });
        return;
      }
      res.status(200).json(wallet);
    } catch (err) {
      console.error('[players/wallet] failed:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  },
);
