import express, { type Application } from 'express';
import { healthRouter } from './routes/health.js';

export function createApp(): Application {
  const app = express();

  app.use(express.json());

  app.use(healthRouter);

  return app;
}