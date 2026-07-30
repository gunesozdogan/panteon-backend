import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env.js';

/**
 * Shared MongoClient. Mongo holds the historical archive — one document per
 * closed week — so past standings are served without touching the live Redis key.
 */
let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

async function connect(): Promise<MongoClient> {
  if (client) return client;
  if (!connecting) {
    const c = new MongoClient(env.MONGO_URL, { serverSelectionTimeoutMS: 5_000 });
    connecting = c.connect().then((connected) => {
      client = connected;
      return connected;
    });
  }
  return connecting;
}

export async function getMongoDb(): Promise<Db> {
  const c = await connect();
  return c.db(env.MONGO_DB);
}

export async function pingMongo(): Promise<boolean> {
  const db = await getMongoDb();
  const res = await db.command({ ping: 1 });
  return res.ok === 1;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    connecting = null;
  }
}