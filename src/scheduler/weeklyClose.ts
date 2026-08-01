/**
 * Scheduled weekly close. Fires just after the ISO week boundary (Mon 00:05 UTC
 * by default) and closes the weeks that have just ended. The HTTP endpoint
 * (`POST /admin/close-week`) stays available for on-demand runs and testing.
 *
 * Self-healing sweep: rather than closing only *last* week, each tick sweeps the
 * last `CLOSE_SWEEP_WEEKS` ended weeks (`getRecentWeekIds`). If a tick is ever
 * missed — crash, deploy window, or the single scheduler instance being down —
 * the next tick catches up on the weeks that were skipped. Weeks already closed
 * are cheap no-ops (`closeWeek`'s `zcard == 0` guard), so re-sweeping is safe.
 *
 * Transient failures (a Redis blip, a DB deadlock) get a small bounded retry
 * inside the tick so a week isn't left for a whole extra cycle; if all retries
 * fail the sweep moves on and the NEXT tick's window will retry the week again.
 *
 * Statelessness: the job holds no state — it derives its target weeks from the
 * clock and delegates to the same idempotent `closeWeek`. In a multi-instance
 * deploy only ONE worker should schedule this (a single scheduler dyno, a leader
 * lease, or node-cron's `distributed` coordinator); even if two fire, `closeWeek`
 * is idempotent so no double payout occurs.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { closeWeek } from '../services/closeWeek.js';
import { getRecentWeekIds } from '../utils/week.js';
import type { WeekId } from '../types/domain.js';

let task: ScheduledTask | null = null;

/** Bounded retry for transient store errors. Backoff: 0.5s, 1s, 2s. */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Close one week with a small bounded retry. Never throws: a week that fails all
 * attempts is logged and left for the next tick's sweep window (idempotent, so
 * retrying it later is safe). Returns whether the close eventually succeeded.
 */
async function closeWeekWithRetry(weekId: WeekId): Promise<boolean> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await closeWeek(weekId);
      if (!result.alreadyClosed) {
        console.log(
          `[cron] week ${weekId} closed: pool=${result.pool} ` +
            `paid=${result.playersPaid} distributed=${result.totalDistributed}`,
        );
      }
      return true;
    } catch (err) {
      if (attempt === RETRY_ATTEMPTS) {
        console.error(
          `[cron] week ${weekId} close failed after ${RETRY_ATTEMPTS} attempts ` +
            `(will retry next tick):`,
          err,
        );
        return false;
      }
      const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`[cron] week ${weekId} close attempt ${attempt} failed, retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  return false;
}

/**
 * Sweep the last `CLOSE_SWEEP_WEEKS` ended weeks, closing any that are still
 * open. Runs sequentially so a slow close never overlaps the next (also enforced
 * by node-cron's `noOverlap`). Exported for testing.
 */
export async function runWeeklyCloseSweep(): Promise<void> {
  const weekIds = getRecentWeekIds(env.CLOSE_SWEEP_WEEKS);
  console.log(`[cron] sweeping ${weekIds.length} week(s): ${weekIds.join(', ')}`);
  for (const weekId of weekIds) {
    await closeWeekWithRetry(weekId);
  }
}

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
      // runWeeklyCloseSweep never throws (per-week errors are caught + retried
      // inside), so the scheduler keeps running regardless of any single failure.
      await runWeeklyCloseSweep();
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
