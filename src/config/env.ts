import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MONGO_URL: z.string().min(1, 'MONGO_URL is required'),
  MONGO_DB: z.string().min(1).default('leaderboard'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
  ENABLE_CRON: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * When the weekly close runs. Default: Monday 00:05 UTC — just after the ISO
   * week boundary, so it closes the week that has just ended.
   */
  CLOSE_WEEK_CRON: z.string().default('5 0 * * 1'),
  /** Timezone for the cron expression. UTC so the boundary matches weekId. */
  CRON_TIMEZONE: z.string().default('UTC'),
  /**
   * How many recently-ended weeks each cron tick sweeps (self-healing window).
   * The tick closes the last N weeks, not just last week, so a missed run
   * (crash/deploy) is caught up next time. Already-closed weeks are cheap no-ops
   * (`closeWeek` zcard guard). Default 4 (~one month of catch-up).
   */
  CLOSE_SWEEP_WEEKS: z.coerce.number().int().positive().default(4),
  /**
   * Enables the demo "live traffic" endpoint (`POST /admin/simulate`) that keeps
   * the board visibly moving. Default ON because this whole service is a case
   * demo and the live board is a core part of it — a real production deploy,
   * where earns come from actual game clients, would set this `false`. The
   * `npm run simulate` script talks to the service directly and is NOT gated by
   * this flag. See docs/live-data-flow.md.
   */
  ENABLE_SIMULATOR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Share of the live board bumped per simulate tick when no explicit count is
   * given (0.001 = 0.1%). Kept deliberately small so a big board doesn't
   * generate too many write commands per tick on a metered/free managed Redis;
   * tune up if you want the board to move faster. In (0, 1].
   */
  SIMULATE_FRACTION: z.coerce.number().gt(0).max(1).default(0.001),
  /** Floor so a tiny/local board still visibly moves each tick. */
  SIMULATE_MIN_COUNT: z.coerce.number().int().positive().default(10),
  /**
   * Ceiling on players bumped per tick — bounds one tick's write burst (and
   * caps command usage on a metered Redis) no matter how large the board grows.
   */
  SIMULATE_MAX_COUNT: z.coerce.number().int().positive().default(2_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;