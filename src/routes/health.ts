import { Router, type Request, type Response } from 'express';
import { pingRedis } from '../db/redis.js';
import { pingPostgres } from '../db/postgres.js';
import { pingMongo } from '../db/mongo.js';
import { getCurrentWeekId } from '../utils/week.js';

export const healthRouter = Router();

type StoreStatus = 'up' | 'down';

async function probe(fn: () => Promise<boolean>): Promise<StoreStatus> {
  try {
    return (await fn()) ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const [redis, postgres, mongo] = await Promise.all([
    probe(pingRedis),
    probe(pingPostgres),
    probe(pingMongo),
  ]);

  const allUp = redis === 'up' && postgres === 'up' && mongo === 'up';

  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    weekId: getCurrentWeekId(),
    stores: { redis, postgres, mongo },
    timestamp: new Date().toISOString(),
  });
});