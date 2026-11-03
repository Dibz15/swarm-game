// Campaign runs on the surrogate (#68, scripts/balance/model.ts): the real run
// logic with each battle's outcome drawn from the battle panel's model, so a
// thousand runs per difficulty take seconds once the panel is measured. The
// panel's battles run on the balance pool (WORKERS, BUDGET_MIN) and are
// cached, so only a code change measures it again.
// Reports win % per difficulty × skill against the targets, losses by depth
// band, run minutes, the biomass curve and warlords.
// Usage: npx vite-node scripts/surrogate-probe.ts [runs] [first seed]
//   DIFFICULTY=gentle,standard (default: all four)   SKILLS=1,0.5 (default: those with targets)
import type { PackId } from '../src/campaign/broods';
import type { RunDifficulty } from '../src/campaign/run';
import { buildPanel, surrogateFight } from './balance/model';
import { BudgetError, Pool } from './balance/pool';
import { playRun } from './balance/runs';
import { TARGETS, summarize } from './balance/summary';

const runs = Number(process.argv[2] ?? 1000);
const firstSeed = Number(process.argv[3] ?? 0);
const DIFFS = (process.env.DIFFICULTY?.split(',') ?? Object.keys(TARGETS)) as RunDifficulty[];
const PACKS: PackId[] = ['swarm', 'wall', 'raid'];

const pool = await Pool.open();
let panel;
try {
  panel = await buildPanel(pool, console.log);
} catch (e) {
  if (!(e instanceof BudgetError)) throw e;
  console.log(e.message);
  await pool.close();
  process.exit(2);
}
await pool.close();
console.log(`${pool.summary()}\n`);

const fight = surrogateFight(panel);
const t0 = performance.now();
for (const difficulty of DIFFS) {
  const skills = process.env.SKILLS ? process.env.SKILLS.split(',').map(Number) : Object.keys(TARGETS[difficulty]).map(Number).sort((a, b) => b - a);
  for (const skill of skills) {
    const os = await Promise.all(Array.from({ length: runs }, (_, r) => playRun(fight, firstSeed + r, { pack: PACKS[(firstSeed + r) % PACKS.length], difficulty, skill })));
    console.log(summarize(os, difficulty, skill).join('\n'));
  }
}
console.log(`\nsurrogate runs: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
