import { env } from './config/env.js';
import { createApp } from './app.js';
import { closeRedis } from './db/redis.js';
import { closePostgres } from './db/postgres.js';
import { closeMongo } from './db/mongo.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[server] listening on http://localhost:${env.PORT} (health: /health)`);
});

/** Close store connections cleanly so restarts/redeploys don't leak sockets. */
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received, shutting down...`);
  server.close();
  await Promise.allSettled([closeRedis(), closePostgres(), closeMongo()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));