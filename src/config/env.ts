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