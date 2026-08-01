import express, { type Application } from 'express';
import { cors } from './middleware/cors.js';
import { healthRouter } from './routes/health.js';
import { eventsRouter } from './routes/events.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { historyRouter } from './routes/history.js';
import { sampleRouter } from './routes/sample.js';
import { adminRouter } from './routes/admin.js';

export function createApp(): Application {
  const app = express();

  app.use(cors);
  app.use(express.json());

  app.use(healthRouter);
  app.use(eventsRouter);
  app.use(leaderboardRouter);
  app.use(historyRouter);
  app.use(sampleRouter);
  app.use(adminRouter);

  return app;
}