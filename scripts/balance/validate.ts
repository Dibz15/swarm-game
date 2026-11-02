// Surrogate validation (#68): full-fidelity runs against the surrogate, per
// difficulty at skill 1. Passes when the surrogate's win rate is within
// WIN_TOLERANCE of the full runs' and its losses by depth band have the same
// shape (total variation distance within SHAPE_TOLERANCE).
// Full runs use run-probe's seeds and policies, so their battles share its cache.
// 36 full runs by default: at 12, a run win rate is only good to about ±14
// points (Gentle and Standard both came out 58%; at 36, 58% and 39%), and
// the loss shape rests on a handful of losses.
// Usage: npx vite-node scripts/balance/validate.ts [full runs per difficulty] [surrogate runs]
//   (default 36 and 1000)   DIFFICULTY=standard,hard
import type { PackId } from '../../src/campaign/broods';
import type { RunDifficulty } from '../../src/campaign/run';
import { buildPanel, surrogateFight } from './model';
import { BudgetError, Pool } from './pool';
import { playRun, type RunOutcome } from './runs';
import { TARGETS, lossBands, runMinutes, winRate } from './summary';

const full = Number(process.argv[2] ?? 36);
const many = Number(process.argv[3] ?? 1000);
const DIFFS = (process.env.DIFFICULTY?.split(',') ?? Object.keys(TARGETS)) as RunDifficulty[];
const PACKS: PackId[] = ['swarm', 'wall', 'raid'];
export const WIN_TOLERANCE = 0.15;
export const SHAPE_TOLERANCE = 0.3;

const pool = await Pool.open();
const opts = (difficulty: RunDifficulty, seed: number) => ({ pack: PACKS[seed % PACKS.length], difficulty, skill: 1 });
let panel, real: RunOutcome[][];
try {
  [panel, real] = await Promise.all([
    buildPanel(pool, console.log),
    Promise.all(DIFFS.map((d) => Promise.all(Array.from({ length: full }, (_, s) => playRun(pool, s, opts(d, s)))))),
  ]);
} catch (e) {
  if (!(e instanceof BudgetError)) throw e;
  console.log(e.message);
  await pool.close();
  process.exit(2);
}
await pool.close();
console.log(`${pool.summary()}\n`);

const fight = surrogateFight(panel);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);
const med = (xs: number[]) => xs[xs.length >> 1] ?? NaN;
let ok = true;
console.log(`difficulty   full (${full})  surrogate (${many})   losses by band: full | surrogate          minutes   verdict`);
for (const [i, d] of DIFFS.entries()) {
  const sur = await Promise.all(Array.from({ length: many }, (_, s) => playRun(fight, s, opts(d, s))));
  const a = winRate(real[i]), b = winRate(sur);
  const ha = lossBands(real[i]), hb = lossBands(sur);
  const tv = ha.reduce((s, x, k) => s + Math.abs(x - hb[k]), 0) / 2;
  const lostA = real[i].some((o) => o.status === 'lost');
  const pass = Math.abs(a - b) <= WIN_TOLERANCE && (!lostA || tv <= SHAPE_TOLERANCE);
  ok &&= pass;
  console.log(
    `${d.padEnd(12)} ${pct(a)}        ${pct(b)}              ${ha.map(pct).join(' ')} | ${hb.map(pct).join(' ')}   ${med(runMinutes(real[i])).toFixed(0).padStart(3)} | ${med(runMinutes(sur)).toFixed(0).padStart(3)}  ${pass ? 'pass' : 'FAIL'} (Δ ${pct(Math.abs(a - b))}, shape ${tv.toFixed(2)})`,
  );
}
console.log(`\n${ok ? 'surrogate validated' : 'surrogate off'}: win rate within ${pct(WIN_TOLERANCE)}, loss shape within ${SHAPE_TOLERANCE}`);
