/**
 * Live-traffic simulator — drive the leaderboard so it visibly moves during a
 * demo. A separate process (traffic generator ≠ API): the honest model, since in
 * production real game clients generate earns, not the leaderboard service.
 *
 * Usage:  npm run simulate [intervalMs] [count]
 *   intervalMs  gap between batches (default 2000)
 *   count       players bumped per batch (default SIMULATE_DEFAULTS.count)
 *
 * Each tick applies a batch of random earns to random existing players via the
 * SAME `simulateEarns` service the `POST /admin/simulate` endpoint uses, so
 * there's one source of truth for the behaviour. Touches only Redis ranking +
 * earn_total; the money path is untouched. Ctrl-C to stop (graceful).
 *
 * The endpoint (browser-driven, gated by ENABLE_SIMULATOR) covers the deployed
 * demo; this script is for local dev / driving a continuous stream by hand.
 */
import { getRedis, closeRedis } from '../db/redis.js';
import { simulateEarns, SIMULATE_DEFAULTS } from '../services/simulate.js';
import { getCurrentWeekId } from '../utils/week.js';

const intervalMs = Number(process.argv[2] ?? 2000);
const count = Number(process.argv[3] ?? SIMULATE_DEFAULTS.count);

if (!Number.isInteger(intervalMs) || intervalMs < 100) {
  console.error(`[simulate] invalid intervalMs: ${process.argv[2]} (min 100)`);
  process.exit(1);
}
if (!Number.isInteger(count) || count <= 0) {
  console.error(`[simulate] invalid count: ${process.argv[3]}`);
  process.exit(1);
}

let running = true;
let ticks = 0;

async function shutdown(): Promise<void> {
  if (!running) return;
  running = false;
  console.log('\n[simulate] stopping…');
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

async function main(): Promise<void> {
  getRedis();
  console.log(
    `[simulate] weekId=${getCurrentWeekId()} interval=${intervalMs}ms count=${count} — Ctrl-C to stop`,
  );

  while (running) {
    try {
      const result = await simulateEarns(getCurrentWeekId(), {
        ...SIMULATE_DEFAULTS,
        count,
      });
      ticks += 1;
      if (result.playersHit === 0) {
        console.warn('[simulate] board is empty — run `npm run seed` first');
      } else if (ticks % 10 === 0) {
        console.log(
          `[simulate] tick ${ticks}: +${result.totalEarned} across ${result.playersHit} players`,
        );
      }
    } catch (err) {
      console.error('[simulate] tick failed (will keep going):', err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch(async (err) => {
  console.error('[simulate] fatal:', err);
  await closeRedis().catch(() => undefined);
  process.exit(1);
});
