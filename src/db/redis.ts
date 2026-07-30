import Redis from 'ioredis';
import { env } from '../config/env.js';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    client.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[redis] connection error:', err.code ?? err.message);
    });
  }
  return client;
}

export async function pingRedis(): Promise<boolean> {
  const res = await getRedis().ping();
  return res === 'PONG';
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}