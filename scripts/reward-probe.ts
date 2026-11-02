// Reward impact (#60, #68, scripts/balance/impact.ts): win-rate change per
// reward over common seeds, with seeds added only where an item is undecided.
// Suggests tiers by thirds of impact, flags must-picks (to nerf) and rewards
// with no impact (to buff). Pacts keep their tier and are judged on net impact;
// Blood price needs a playtest (the proxy doesn't know to spare its energy).
// The table is written to the cache (reward-impact.json) for the surrogate.
// Battles run on the balance pool (WORKERS, BUDGET_MIN, NOCACHE) and are cached.
// Usage: [IDS=spikes,echo] [SEEDS=0] [SIZE=10] [DIFF=3] npx vite-node scripts/reward-probe.ts
import { REWARD } from '../src/campaign/rewards';
import { IMPACT_FILE, measureImpact, verdicts, type ImpactTable } from './balance/impact';
import { BudgetError, Pool } from './balance/pool';

const pool = await Pool.open();
let t: ImpactTable;
try {
  t = await measureImpact(
    pool,
    {
      ids: process.env.IDS?.split(','),
      seeds: process.env.SEEDS ? Number(process.env.SEEDS) : undefined,
      size: process.env.SIZE ? Number(process.env.SIZE) : undefined,
      diff: process.env.DIFF ? Number(process.env.DIFF) : undefined,
    },
    console.log,
  );
} catch (e) {
  if (!(e instanceof BudgetError)) throw e;
  console.log(e.message);
  await pool.close();
  process.exit(2);
}
await pool.close();
if (!process.env.IDS) pool.cache.write(IMPACT_FILE, t);

const pts = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}`.padStart(4);
console.log(`\nbaseline: won ${(100 * t.base.rate).toFixed(0)}%, ${t.base.secs.toFixed(0)} s over ${t.base.n} seeds (from ${t.opts.seeds}, difficulty ${t.opts.diff}, broods of ${t.opts.size})`);
console.log(`lines: thirds at ${pts(t.lines.lower)} and ${pts(t.lines.upper)} pts, must-pick over ${pts(t.lines.mustPick)} pts`);
const v = verdicts(t);
console.log('\nimpact, most first (seeds · ±interval · suggested tier · now · flag):');
for (const i of [...t.items].sort((a, b) => b.delta - a.delta || a.secs - b.secs)) {
  const r = REWARD[i.id];
  const { tier, flag } = v[i.id];
  console.log(
    `  ${i.id.padEnd(15)} ${pts(i.delta)} pts ±${(100 * i.half).toFixed(0).padStart(2)}  ${String(i.n).padStart(2)} seeds  ${i.secs >= 0 ? '+' : ''}${i.secs.toFixed(0).padStart(4)} s  ${r.family.padEnd(6)} ${tier.padEnd(8)} ${tier === r.tier ? '' : `now ${r.tier}`.padEnd(13)}${flag}`,
  );
}
console.log(`\n${pool.summary()}`);
