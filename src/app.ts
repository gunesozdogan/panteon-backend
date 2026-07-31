import express, { type Application } from 'express';
import { healthRouter } from './routes/health.js';
import { eventsRouter } from './routes/events.js';
import { leaderboardRouter } from './routes/leaderboard.js';

export function createApp(): Application {
  const app = express();

  app.use(express.json());

  app.use(healthRouter);
  app.use(eventsRouter);
  app.use(leaderboardRouter);

  return app;
}