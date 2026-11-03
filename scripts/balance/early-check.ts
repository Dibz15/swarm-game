// Early-decision check (#68): plays run-probe runs' battles out in full, then
// scores early-decision rules (battle.ts: one team over `share` of army plus
// production for `secs`) on each battle's lead trace: how often a rule calls
// the battle, how often the call is right, and how much battle time it saves.
// Each rule's verdict is stored beside this code's cached results. The pool
// uses the rule set by EARLY_SHARE/EARLY_SECS (default 0.85 for 60 s) under
// EARLY=1 only for the classes (open, stronghold) where its verdict passes:
// EARLY_AGREE of calls right, at least EARLY_MIN_CALLS calls in the class, over
// at least EARLY_MIN eligible battles.
// The battles land in the cache as played out, so scoring more rules is free.
// Usage: npx vite-node scripts/balance/early-check.ts [runs per difficulty] [skills]
//   e.g. early-check.ts 4 1,0.5  (default: 4 runs at each difficulty, skills 1 and 0.5)
import type { PackId } from '../../src/campaign/broods';
import type { RunDifficulty } from '../../src/campaign/run';
import { TICK_HZ } from '../../src/sim/constants';
import { EARLY_CLASSES, callOf, type Rule } from './battle';
import { BudgetError, EARLY_AGREE, EARLY_MIN, EARLY_MIN_CALLS, Pool, earlyFile, passes, ruleFromEnv, type EarlyVerdict, type Tally } from './pool';
import { playRun, type Battle } from './runs';

const per = Number(process.argv[2] ?? 4);
const skills = (process.argv[3] ?? '1,0.5').split(',').map(Number);
const DIFFS: RunDifficulty[] = ['gentle', 'standard', 'hard', 'brutal'];
const PACKS: PackId[] = ['swarm', 'wall', 'raid'];
const GRID: Rule[] = [0.7, 0.75, 0.8, 0.85, 0.9].flatMap((share) => [30, 60, 90].map((secs) => ({ share, secs })));

const pool = await Pool.open({ early: false });
const battles: Battle[] = [];
const jobs = DIFFS.flatMap((difficulty, d) => skills.flatMap((skill, s) => Array.from({ length: per }, (_, r) => ({ difficulty, skill, seed: 1000 + 100 * d + 10 * s + r }))));
try {
  await Promise.all(
    jobs.map(async (j) => {
      const o = await playRun(pool, j.seed, { pack: PACKS[j.seed % PACKS.length], difficulty: j.difficulty, skill: j.skill });
      battles.push(...o.battles);
    }),
  );
} catch (e) {
  if (!(e instanceof BudgetError)) throw e;
  console.log(`${e.message} (${battles.length} battles in)`);
  await pool.close();
  process.exit(2);
}
await pool.close();

const misses: string[] = [];
function score(rule: Rule, note = false): EarlyVerdict {
  const v: EarlyVerdict = { rule, byClass: {} };
  for (const b of battles) {
    const t: Tally = (v.byClass[b.cls] ??= { battles: 0, called: 0, agreed: 0, ticks: 0, saved: 0 });
    t.battles++;
    t.ticks += b.result.ticks;
    const call = callOf(b.result.trace, rule);
    if (!call || call.tick >= b.result.ticks) continue;
    t.called++;
    if ((call.team === b.team) === b.won) t.agreed++, (t.saved += b.result.ticks - call.tick);
    else if (note && EARLY_CLASSES.includes(b.cls)) misses.push(`${b.cls} ${b.kind} d${b.difficulty} ×${b.rivals} depth ${b.depth}: called ${call.team === b.team ? 'won' : 'lost'} at ${(call.tick / TICK_HZ / 60).toFixed(1)} min, ${b.won ? 'won' : b.capped ? 'capped' : 'lost'} at ${b.minutes.toFixed(1)}`);
  }
  pool.cache.write(earlyFile(rule), v);
  return v;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-').padStart(6);
const sum = (v: EarlyVerdict, k: keyof Tally) => EARLY_CLASSES.reduce((n, c) => n + (v.byClass[c]?.[k] ?? 0), 0);
console.log(`${battles.length} battles from ${jobs.length} runs; open and stronghold battles: ${sum(score(GRID[0]), 'battles')}`);
console.log(`needs ${EARLY_AGREE * 100}% right, ${EARLY_MIN_CALLS}+ calls per class, ${EARLY_MIN}+ eligible battles\n`);
console.log('rule              called   right   saves   open        stronghold');
for (const rule of GRID) {
  const v = score(rule);
  const cell = (c: (typeof EARLY_CLASSES)[number]) => {
    const t = v.byClass[c];
    return `${(t ? `${t.agreed}/${t.called}` : '-').padStart(7)} ${passes(v, c) ? 'use ' : '    '}`;
  };
  console.log(`${`${rule.share} for ${rule.secs} s`.padEnd(16)} ${pct(sum(v, 'called'), sum(v, 'battles'))} ${pct(sum(v, 'agreed'), sum(v, 'called'))} ${pct(sum(v, 'saved'), sum(v, 'ticks'))}  ${cell('open')} ${cell('stronghold')}`);
}

const rule = ruleFromEnv();
const v = score(rule, true);
console.log(`\nthe pool's rule, ${rule.share} for ${rule.secs} s (EARLY_SHARE, EARLY_SECS), by class:`);
for (const [cls, t] of Object.entries(v.byClass)) console.log(`  ${cls.padEnd(10)} ${String(t.battles).padStart(4)} battles, called ${String(t.called).padStart(4)}, right ${pct(t.agreed, t.called)}, saves ${pct(t.saved, t.ticks)}  ${passes(v, cls as never) ? 'use' : 'play out'}`);
if (misses.length) console.log(`wrong calls:\n  ${misses.join('\n  ')}`);
console.log(`\nverdicts stored for cache ${pool.fp}`);
console.log(pool.summary());
