/**
 * Scheduled weekly close. Fires just after the ISO week boundary (Mon 00:05 UTC
 * by default) and closes the week that has just ended. The HTTP endpoint
 * (`POST /admin/close-week`) stays available for on-demand runs and testing.
 *
 * Statelessness: the job holds no state — it derives the target week from the
 * clock (`getPreviousWeekId`) and delegates to the same idempotent `closeWeek`.
 * In a multi-instance deploy only ONE worker should schedule this (a single
 * scheduler dyno, a leader lease, or node-cron's `distributed` coordinator);
 * even if two fire, `closeWeek` is idempotent so no double payout occurs.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { closeWeek } from '../services/closeWeek.js';
import { getPreviousWeekId } from '../utils/week.js';

let task: ScheduledTask | null = null;

/**
 * Start the weekly-close cron if `ENABLE_CRON=true`. Returns the task (or null
 * when disabled) so callers/tests can stop it. `noOverlap` prevents a slow run
 * from overlapping the next tick.
 */
export function startWeeklyCloseCron(): ScheduledTask | null {
  if (!env.ENABLE_CRON) {
    console.log('[cron] weekly close disabled (ENABLE_CRON=false)');
    return null;
  }
  if (task) return task;

  task = cron.schedule(
    env.CLOSE_WEEK_CRON,
    async () => {
      const weekId = getPreviousWeekId();
      console.log(`[cron] closing week ${weekId}...`);
      try {
        const result = await closeWeek(weekId);
        console.log(
          `[cron] week ${weekId} closed: pool=${result.pool} ` +
            `paid=${result.playersPaid} distributed=${result.totalDistributed} ` +
            `alreadyClosed=${result.alreadyClosed}`,
        );
      } catch (err) {
        // Swallow so the scheduler keeps running; a retry (next week or manual
        // POST) is safe because closeWeek is idempotent.
        console.error(`[cron] week ${weekId} close failed:`, err);
      }
    },
    { name: 'weekly-close', timezone: env.CRON_TIMEZONE, noOverlap: true },
  );

  console.log(
    `[cron] weekly close scheduled: "${env.CLOSE_WEEK_CRON}" (${env.CRON_TIMEZONE})`,
  );
  return task;
}

/** Stop the cron (used on graceful shutdown). */
export async function stopWeeklyCloseCron(): Promise<void> {
  if (task) {
    await task.stop();
    task = null;
  }
}
