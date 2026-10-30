// Reward impact (#60, for #68): the human proxy fights the same seeded battles
// with and without each reward, and the win-rate change suggests its tier. The
// army is the same in both arms: a Swarmer brood, a brood of the reward's kind
// (Shields for Swarmer strains) and a Spear brood, every nest type unlocked.
// Strains go on the matching brood; anything else is held as a perk. Hunger
// does nothing in battle, so it's skipped.
// The rival is Brutal with 10-dot broods by default: at Normal or Hard the
// proxy wins nearly every battle, so win rates can't move. The proxy doesn't
// know Blood price: with its energy never spent, it casts (and pays) far more.
// Usage: [IDS=spikes,echo] [N=6] [SEEDS=0] [SIZE=10] [DIFF=3] npx vite-node scripts/reward-probe.ts
import { nodeSetup } from '../src/campaign/battle';
import { newBrood } from '../src/campaign/broods';
import { REWARD, REWARDS, type Tier } from '../src/campaign/rewards';
import { newRun, type RunState } from '../src/campaign/run';
import { Kind, TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Proxy } from '../src/proxy/proxy';

const N = Number(process.env.N ?? 6);
const SEEDS = Number(process.env.SEEDS ?? 0);
const SIZE = Number(process.env.SIZE ?? 10);
const DIFF = Number(process.env.DIFF ?? 3);
const IDS = process.env.IDS ? process.env.IDS.split(',') : REWARDS.map((r) => r.id).filter((id) => id !== 'hunger');
const CAP = 10 * 60 * TICK_HZ;

/** One battle: a 1v1 against a DIFF bot next to the start of seed `k`'s run, with `id` held (or nothing). */
function battle(k: number, id: string | null): { won: boolean; secs: number } {
  const r = REWARD[id ?? ''];
  const second = r?.kind !== undefined && r.kind !== Kind.Dot ? r.kind : Kind.Tank;
  const run: RunState = newRun(`reward-probe-${SEEDS + k}`, 0, 'swarm', 0);
  run.broods = [Kind.Dot, second, Kind.Lancer].map((kind, b) => ({ ...newBrood(b, kind, run.seed, []), size: SIZE, cap: SIZE }));
  run.fielded = run.broods.map((b) => b.id);
  run.unlocks = { nests: 0xff, nova: true };
  if (r?.family === 'strain') run.broods.find((b) => b.kind === r.kind)!.strains.push(r.id);
  else if (r) run.perks.push(r.id);
  const node = run.nodes[run.start].links.find((l) => run.nodes[l].kind === 'conquest' && !run.nodes[l].domain) ?? run.nodes[run.start].links[0];
  Object.assign(run.nodes[node], { difficulty: DIFF, rivals: 1 });
  const w = createWorld(nodeSetup(run, node, run.fielded));
  const proxy = new Proxy(run.color, { skill: 1 });
  while (!w.over && w.tick < CAP) {
    step(w, proxy.think(w));
    w.fx = [];
    w.deaths = [];
  }
  return { won: w.over && w.winnerTeam === w.teamOf[run.color], secs: w.tick / TICK_HZ };
}

const arm = (id: string | null) => {
  let wins = 0, secs = 0;
  for (let k = 0; k < N; k++) {
    const b = battle(k, id);
    wins += +b.won;
    secs += b.secs;
  }
  return { rate: wins / N, secs: secs / N };
};

const base = arm(null);
console.log(`baseline: won ${(100 * base.rate).toFixed(0)}%, ${base.secs.toFixed(0)} s (N=${N}, seeds ${SEEDS}..${SEEDS + N - 1}, difficulty ${DIFF})`);
const rows = IDS.map((id) => {
  const a = arm(id);
  console.log(`  ${id.padEnd(15)} ${(100 * a.rate).toFixed(0).padStart(3)}%  ${a.secs.toFixed(0).padStart(4)} s`);
  return { id, delta: a.rate - base.rate, secs: a.secs - base.secs };
});
// Biggest win-rate gain (then the quicker win) first; thirds become rare, uncommon, common.
rows.sort((p, q) => q.delta - p.delta || p.secs - q.secs);
const TIERS: Tier[] = ['rare', 'uncommon', 'common'];
console.log('\nimpact, most first (suggested tier · current):');
rows.forEach((o, k) => {
  const tier = TIERS[Math.min(2, Math.floor((3 * k) / rows.length))];
  const now = REWARD[o.id].tier;
  console.log(`  ${o.id.padEnd(15)} ${o.delta >= 0 ? '+' : ''}${(100 * o.delta).toFixed(0).padStart(3)} pts  ${o.secs >= 0 ? '+' : ''}${o.secs.toFixed(0).padStart(4)} s  ${tier}${tier === now ? '' : ` · now ${now}`}`);
});
