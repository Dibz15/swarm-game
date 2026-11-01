// Whole procedural campaign runs played headlessly (#18, #68): the human proxy
// (src/proxy/proxy.ts) fights every battle, and simple policies stand in for
// the player's choices between battles (scripts/balance/runs.ts). Runs play
// side by side, their battles on the balance pool (scripts/balance/pool.ts:
// WORKERS, BUDGET_MIN, EARLY, NOCACHE), and battles are cached.
// Reports run outcomes and length, battle win rates by node kind, difficulty
// and depth, brood attrition, biomass and reward picks.
// Usage: npx vite-node scripts/run-probe.ts [runs] [skill] [first seed]
//   PACK=swarm|wall|raid (default: rotate)   DIFFICULTY=gentle|standard|hard|brutal   PROXY='{...}' knob overrides
import type { PackId } from '../src/campaign/broods';
import type { RunDifficulty } from '../src/campaign/run';
import type { ProxyKnobs } from '../src/proxy/proxy';
import { BudgetError, Pool } from './balance/pool';
import { playRun, type Battle, type RunOutcome } from './balance/runs';

const runs = Number(process.argv[2] ?? 10);
const skill = Number(process.argv[3] ?? 1);
const firstSeed = Number(process.argv[4] ?? 0);
const knobs: Partial<ProxyKnobs> = process.env.PROXY ? JSON.parse(process.env.PROXY) : {};
const DIFFICULTY = (process.env.DIFFICULTY ?? 'standard') as RunDifficulty;
const PACKS: PackId[] = process.env.PACK ? [process.env.PACK as PackId] : ['swarm', 'wall', 'raid'];

// ---- runs ----------------------------------------------------------------------

const pool = await Pool.open();
const outcomes: RunOutcome[] = [];
try {
  await Promise.all(
    Array.from({ length: runs }, async (_, r) => {
      const seed = firstSeed + r;
      const o = await playRun(pool, seed, { pack: PACKS[seed % PACKS.length], difficulty: DIFFICULTY, skill, knobs, early: true });
      outcomes.push(o);
      const bs = o.battles;
      console.log(
        `run ${String(seed).padStart(3)} ${o.pack.padEnd(5)} ${o.status.padEnd(6)}${o.lostTo ? ` (${o.lostTo})` : ''.padEnd(9)} turns ${String(o.turns).padStart(2)}  battles ${bs.filter((b) => b.won).length}/${bs.length} won  broods left ${o.broods}  biomass ${o.biomass}${o.restored ? '  checkpoint used' : ''}  ${(pool.minutes * 60).toFixed(0)}s`,
      );
    }),
  );
} catch (e) {
  if (!(e instanceof BudgetError)) throw e;
  console.log(`\n${e.message} (${outcomes.length} of ${runs} runs done)`);
  await pool.close();
  process.exit(2);
}
await pool.close();
outcomes.sort((a, b) => a.seed - b.seed);
const battles: Battle[] = outcomes.flatMap((o) => o.battles);
const sum = (f: (o: RunOutcome) => number) => outcomes.reduce((s, o) => s + f(o), 0);
const deaths = sum((o) => o.deaths), rescues = sum((o) => o.rescues);
const lords = { broken: sum((o) => o.lords.broken), eaten: sum((o) => o.lords.eaten), fought: sum((o) => o.lords.fought), avoided: sum((o) => o.lords.avoided), battles: sum((o) => o.lords.battles), wins: sum((o) => o.lords.wins) };
const rewards: Record<string, number> = {};
const bought: Record<string, number> = {};
for (const o of outcomes) {
  for (const id of o.rewards) rewards[id] = (rewards[id] ?? 0) + 1;
  for (const [k, v] of Object.entries(o.bought)) bought[k] = (bought[k] ?? 0) + v;
}

// ---- report ----------------------------------------------------------------------

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-').padStart(4);
const won = outcomes.filter((o) => o.status === 'won').length;
console.log(`\n${runs} runs at skill ${skill}, ${DIFFICULTY}${Object.keys(knobs).length ? `, knobs ${JSON.stringify(knobs)}` : ''}: ${pct(won, runs)} won`);
const lost = (why: string) => outcomes.filter((o) => o.lostTo === why).length;
console.log(`  lost to: broods ${lost('broods')}, bloom ${lost('bloom')}; checkpoint used in ${outcomes.filter((o) => o.restored).length}`);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`  turns ${avg(outcomes.map((o) => o.turns)).toFixed(1)}, battles per run ${(battles.length / runs).toFixed(1)}, biomass per run ${avg(outcomes.map((o) => o.biomass)).toFixed(0)}`);
// Run length: battle time only (the run map and camp add a few minutes a run).
const lengths = outcomes.map((o) => o.battles.reduce((s, b) => s + b.minutes, 0)).sort((a, b) => a - b);
const early = battles.filter((b) => b.decided).length;
console.log(`  run minutes (battles): mean ${avg(lengths).toFixed(0)}, median ${lengths[lengths.length >> 1].toFixed(0)}, range ${lengths[0].toFixed(0)}–${lengths[lengths.length - 1].toFixed(0)}${early ? `; ${early} battles decided early, so these run short` : ''}`);
console.log(`  brood deaths per run ${(deaths / runs).toFixed(1)}, rescues per run ${(rescues / runs).toFixed(1)}, broods left (won runs) ${avg(outcomes.filter((o) => o.status === 'won').map((o) => o.broods)).toFixed(1)}`);
for (const p of PACKS) {
  const of = outcomes.filter((o) => o.pack === p);
  if (of.length) console.log(`  pack ${p.padEnd(5)} ${pct(of.filter((o) => o.status === 'won').length, of.length)} won of ${of.length}`);
}
const lostAt = outcomes.filter((o) => o.status === 'lost').map((o) => o.depth);
if (lostAt.length) console.log(`  runs lost at depth: ${lostAt.sort((a, b) => a - b).join(' ')}`);
console.log(
  `  warlords per run: broken ${(lords.broken / runs).toFixed(1)}, eaten by the Bloom ${(lords.eaten / runs).toFixed(1)}, fought but standing ${(lords.fought / runs).toFixed(1)}, never fought ${(lords.avoided / runs).toFixed(1)}; domain battles ${pct(lords.wins, lords.battles)} won of ${lords.battles}`,
);

const group = (label: string, key: (b: Battle) => string) => {
  const by = new Map<string, Battle[]>();
  for (const b of battles) by.set(key(b), [...(by.get(key(b)) ?? []), b]);
  console.log(`\nbattles by ${label}`);
  for (const [k, bs] of [...by].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const w = bs.filter((b) => b.won).length;
    console.log(
      `  ${k.padEnd(18)} ${String(bs.length).padStart(4)}  won ${pct(w, bs.length)}  capped ${pct(bs.filter((b) => b.capped).length, bs.length)}  ${avg(bs.map((b) => b.minutes)).toFixed(1).padStart(4)} min  army ${avg(bs.map((b) => b.army)).toFixed(0).padStart(3)} → ${avg(bs.map((b) => b.survivors)).toFixed(0)}`,
    );
  }
};
group('node kind', (b) => b.kind);
group('difficulty × rivals', (b) => `d${b.difficulty} ×${b.rivals}`);
group('depth', (b) => `depth ${b.depth}`);
console.log(`\nrewards taken: ${Object.entries(rewards).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`camp: ${Object.entries(bought).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`\n${pool.summary()}`);
