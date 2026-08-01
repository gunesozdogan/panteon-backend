/**
 * Historical archive (MongoDB) — one document per closed week.
 *
 * Past weeks are served from here so reading history never touches the live
 * Redis key (which may already be reset to a new week). A document's variable-
 * length `standings` array is a natural fit for Mongo's flexible schema.
 */
import type { Collection } from 'mongodb';
import { getMongoDb } from '../db/mongo.js';
import type { WeeklyStandingsDoc, WeekId } from '../types/domain.js';

const COLLECTION = 'weekly_standings';

/** Ensure the unique index once per process, not on every call. */
let indexReady: Promise<void> | null = null;

async function collection(): Promise<Collection<WeeklyStandingsDoc>> {
  const db = await getMongoDb();
  const col = db.collection<WeeklyStandingsDoc>(COLLECTION);
  if (!indexReady) {
    indexReady = col.createIndex({ weekId: 1 }, { unique: true }).then(() => undefined);
  }
  await indexReady;
  return col;
}

/**
 * Archive a closed week. Upsert by `weekId` so re-running close-week after a
 * crash overwrites the same document instead of duplicating it (idempotent).
 */
export async function archiveWeeklyStandings(
  doc: WeeklyStandingsDoc,
): Promise<void> {
  const col = await collection();
  await col.replaceOne({ weekId: doc.weekId }, doc, { upsert: true });
}

/**
 * Read an archived week for `GET /leaderboard/history/:weekId`. The internal
 * Mongo `_id` is projected out so the response is a clean domain document.
 */
export async function getWeeklyStandings(
  weekId: WeekId,
): Promise<WeeklyStandingsDoc | null> {
  const col = await collection();
  return col.findOne({ weekId }, { projection: { _id: 0 } });
}
