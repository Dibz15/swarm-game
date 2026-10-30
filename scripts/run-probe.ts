// Whole procedural campaign runs played headlessly (#18, #68): the human proxy
// (src/proxy/proxy.ts) fights every battle, and simple policies stand in for
// the player's choices between battles: the route, which broods to field, the
// reward to take and what to buy at the camp.
// Reports run outcomes, battle win rates by node kind, difficulty and depth,
// brood attrition, biomass and reward picks.
// Usage: npx vite-node scripts/run-probe.ts [runs] [skill] [first seed]
//   PACK=swarm|wall|raid (default: rotate)   DIFFICULTY=gentle|standard|hard|brutal   PROXY='{...}' knob overrides
import { battleReport, nodeSetup } from '../src/campaign/battle';
import { COST, KIND_NEST, UNLOCKS, fit, type PackId, type Unlock } from '../src/campaign/broods';
import { REWARD, STRAIN_SLOTS, TIER_WEIGHT } from '../src/campaign/rewards';
import { type RunDifficulty, grow, heal, hops, maxFielded, moves, needsBattle, newRun, resolveTurn, takeReward, unlock, unlockCost, unlocked, warlordFighting, type RunState } from '../src/campaign/run';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Proxy, type ProxyKnobs } from '../src/proxy/proxy';

const runs = Number(process.argv[2] ?? 10);
const skill = Number(process.argv[3] ?? 1);
const firstSeed = Number(process.argv[4] ?? 0);
const knobs: Partial<ProxyKnobs> = process.env.PROXY ? JSON.parse(process.env.PROXY) : {};
const DIFFICULTY = (process.env.DIFFICULTY ?? 'standard') as RunDifficulty;
const PACKS: PackId[] = process.env.PACK ? [process.env.PACK as PackId] : ['swarm', 'wall', 'raid'];
/** a battle still running after this long counts as a retreat (a loss) */
const CAP = 15 * 60 * TICK_HZ;

interface Battle {
  kind: string;
  difficulty: number;
  rivals: number;
  depth: number;
  won: boolean;
  capped: boolean;
  minutes: number;
  /** dots fielded (or the militia) */
  army: number;
  survivors: number;
}

// ---- policies ----------------------------------------------------------------

/** The broods to field: the biggest fit ones. */
function pickBroods(run: RunState): number[] {
  return run.broods
    .filter(fit)
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, maxFielded(run))
    .map((b) => b.id);
}

/** Next node: one step along the shortest open route to the heart; ties go to easier, then rescue, nodes. */
function pickMove(run: RunState): number {
  const back = hops(run.nodes, run.heart, (id) => run.swallowed.includes(id));
  const options = moves(run);
  const rank = (id: number) => {
    const n = run.nodes[id];
    const d = back[id] < 0 ? 999 : back[id];
    return d * 100 + (needsBattle(run, id) ? n.difficulty * 10 + n.rivals : -5) - (n.rescue !== undefined ? 3 : 0) - (n.checkpoint ? 2 : 0);
  };
  return options.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}

/** Take the offer's best reward: rarer first; strains onto the biggest brood with room. Pacts only when nothing else. */
function pickReward(run: RunState): string | null {
  if (!run.offer) return null;
  const score = (id: string) => {
    const r = REWARD[id];
    return TIER_WEIGHT.common / TIER_WEIGHT[r.tier] + (r.family === 'pact' ? -100 : r.family === 'strain' ? 2 : 1);
  };
  for (const id of [...run.offer.ids].sort((a, b) => score(b) - score(a))) {
    const r = REWARD[id];
    if (r.family === 'strain') {
      const owners = run.broods.filter((b) => b.kind === r.kind && !b.strains.includes(id)).sort((a, b) => b.size - a.size);
      const roomy = owners.find((b) => b.strains.length < STRAIN_SLOTS);
      if (roomy && takeReward(run, id, roomy.id)) return id;
      if (owners[0] && takeReward(run, id, owners[0].id, owners[0].strains[0])) return id;
      continue;
    }
    if (takeReward(run, id)) return id;
  }
  return null;
}

/** Camp: heal when short of fit broods, unlock what our broods' kinds need (then Nova), then grow caps. */
function spend(run: RunState, bought: Record<string, number>): void {
  const buy = (what: string, ok: boolean) => ok && (bought[what] = (bought[what] ?? 0) + 1);
  for (const b of run.broods) if (b.wounded && run.broods.filter(fit).length < maxFielded(run)) buy('heal', heal(run, b.id));
  const wanted: Unlock[] = [...new Set(run.broods.map((b) => KIND_NEST[b.kind]))].filter((t) => UNLOCKS.includes(t));
  for (const u of [...wanted, 'nova' as Unlock, ...UNLOCKS]) if (!unlocked(run, u) && run.biomass >= unlockCost(u) + 10) buy(`unlock ${u}`, unlock(run, u));
  const big = [...run.broods].sort((a, b) => b.size - a.size)[0];
  while (big && big.size >= big.cap - 2 && run.biomass >= COST.grow(big) + 30 && grow(run, big.id)) buy('grow', true);
}

// ---- a battle ------------------------------------------------------------------

function fight(run: RunState, id: number, fielded: number[]): { won: boolean; capped: boolean; report: ReturnType<typeof battleReport>; army: number } {
  const setup = nodeSetup(run, id, false, fielded);
  const me = setup.players[0];
  const w = createWorld(setup);
  const proxy = new Proxy(me.faction, { skill, knobs, novaLocked: !run.unlocks.nova });
  const army = (me.army ?? []).reduce((s, a) => s + a.count, 0);
  while (!w.over && w.tick < CAP) {
    step(w, proxy.think(w));
    w.fx = [];
    w.deaths = [];
  }
  const won = w.over && w.winnerTeam === w.teamOf[me.faction];
  return { won, capped: !w.over, report: battleReport(w, me.faction, won), army };
}

// ---- runs ----------------------------------------------------------------------

const battles: Battle[] = [];
const outcomes: { status: string; lostTo?: string; turns: number; broods: number; biomass: number; restored: boolean; pack: PackId; at: number; depth: number }[] = [];
const rewards: Record<string, number> = {};
const bought: Record<string, number> = {};
let deaths = 0, rescues = 0;
const t0 = performance.now();
/** warlords (#66): how each run's ended up, and domain battles fought and won */
const lords = { broken: 0, eaten: 0, fought: 0, avoided: 0, battles: 0, wins: 0 };

for (let r = 0; r < runs; r++) {
  const pack = PACKS[(firstSeed + r) % PACKS.length];
  const run = newRun(`probe-${firstSeed + r}`, 0, pack, 0, DIFFICULTY);
  let restored = false, earned = 0;
  const met = new Set<number>();
  for (let guard = 0; guard < 80 && run.status === 'active'; guard++) {
    const picked = pickReward(run);
    if (picked) rewards[picked] = (rewards[picked] ?? 0) + 1;
    run.offer = undefined;
    spend(run, bought);
    const id = pickMove(run);
    const node = run.nodes[id];
    if (!needsBattle(run, id)) {
      resolveTurn(run, id, null, [], 0);
      continue;
    }
    const fielded = pickBroods(run);
    const lord = node.kind === 'finale' ? undefined : warlordFighting(run, id);
    const res = fight(run, id, fielded);
    if (lord) {
      met.add(lord.id);
      lords.battles++;
      if (res.won) lords.wins++;
    }
    battles.push({
      kind: node.kind,
      difficulty: node.difficulty,
      rivals: node.rivals,
      depth: node.depth,
      won: res.won,
      capped: res.capped,
      minutes: res.report.seconds / 60,
      army: res.army,
      survivors: res.report.survivors.reduce((a, b) => a + b, 0),
    });
    const turn = resolveTurn(run, id, res.report, fielded, 0);
    earned += turn.biomass;
    deaths += turn.events.filter((e) => e.what === 'died').length;
    rescues += turn.events.filter((e) => e.what === 'rescued').length;
    if (turn.checkpoint === 'restored') restored = true;
  }
  for (const w of run.warlords ?? []) {
    if (w.broken) lords.broken++;
    else if (run.swallowed.includes(w.stronghold)) lords.eaten++;
    else if (met.has(w.id)) lords.fought++;
    else lords.avoided++;
  }
  outcomes.push({ status: run.status, lostTo: run.lostTo, turns: run.turn, broods: run.broods.length, biomass: earned, restored, pack, at: run.at, depth: run.nodes[run.at].depth });
  const last = battles.slice(-run.log.length);
  console.log(
    `run ${String(firstSeed + r).padStart(3)} ${pack.padEnd(5)} ${run.status.padEnd(6)}${run.lostTo ? ` (${run.lostTo})` : ''.padEnd(9)} turns ${String(run.turn).padStart(2)}  battles ${last.filter((b) => b.won).length}/${last.length} won  broods left ${run.broods.length}  biomass ${earned}${restored ? '  checkpoint used' : ''}  ${((performance.now() - t0) / 1000).toFixed(0)}s`,
  );
}

// ---- report ----------------------------------------------------------------------

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-').padStart(4);
const won = outcomes.filter((o) => o.status === 'won').length;
console.log(`\n${runs} runs at skill ${skill}, ${DIFFICULTY}${Object.keys(knobs).length ? `, knobs ${JSON.stringify(knobs)}` : ''}: ${pct(won, runs)} won`);
const lost = (why: string) => outcomes.filter((o) => o.lostTo === why).length;
console.log(`  lost to: broods ${lost('broods')}, bloom ${lost('bloom')}; checkpoint used in ${outcomes.filter((o) => o.restored).length}`);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`  turns ${avg(outcomes.map((o) => o.turns)).toFixed(1)}, battles per run ${(battles.length / runs).toFixed(1)}, biomass per run ${avg(outcomes.map((o) => o.biomass)).toFixed(0)}`);
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
