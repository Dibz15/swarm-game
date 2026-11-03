// Whole campaign runs for the balance harness (#18, #68): the human proxy
// fights every battle (on the pool), and simple policies stand in for the
// player's choices between battles: the route, which broods to field, the
// reward to take and what to buy at the camp. The run logic stays on the main
// thread, so many runs share the pool at once.
import { nodeSetup } from '../../src/campaign/battle';
import { COST, KIND_NEST, UNLOCKS, fit, type PackId, type Unlock } from '../../src/campaign/broods';
import { REWARD, STRAIN_SLOTS, TIER_WEIGHT } from '../../src/campaign/rewards';
import { type RunDifficulty, grow, heal, hops, maxFielded, moves, needsBattle, newRun, resolveTurn, takeReward, unlock, unlockCost, unlocked, warlordFighting, type RunState } from '../../src/campaign/run';
import type { ProxyKnobs } from '../../src/proxy/proxy';
import { TICK_HZ } from '../../src/sim/constants';
import { classOf, type BattleClass, type Result } from './battle';
import type { Pool } from './pool';

/** a battle still running after this long counts as a retreat (a loss) */
export const CAP = 15 * 60 * TICK_HZ;

export interface Battle {
  kind: string;
  difficulty: number;
  rivals: number;
  depth: number;
  won: boolean;
  capped: boolean;
  /** ended by the early-decision rule, so `minutes` stops at the call */
  decided: boolean;
  minutes: number;
  /** dots fielded (or the militia) */
  army: number;
  survivors: number;
  /** the human's team, to check the result's early call against */
  team: number;
  cls: BattleClass;
  result: Result;
}

export interface RunOutcome {
  seed: number;
  pack: PackId;
  status: string;
  lostTo?: string;
  turns: number;
  broods: number;
  biomass: number;
  restored: boolean;
  at: number;
  depth: number;
  battles: Battle[];
  rewards: string[];
  bought: Record<string, number>;
  deaths: number;
  rescues: number;
  /** warlords (#66): how each ended up, and domain battles fought and won */
  lords: { broken: number; eaten: number; fought: number; avoided: number; battles: number; wins: number };
}

export interface RunOptions {
  pack: PackId;
  difficulty: RunDifficulty;
  skill: number;
  knobs?: Partial<ProxyKnobs>;
  /** ask the pool for early decisions */
  early?: boolean;
}

// ---- policies ----------------------------------------------------------------

/** The broods to field: the biggest fit ones. */
export function pickBroods(run: RunState): number[] {
  return run.broods
    .filter(fit)
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, maxFielded(run))
    .map((b) => b.id);
}

/** Next node: one step along the shortest open route to the heart; ties go to easier, then rescue, nodes. */
export function pickMove(run: RunState): number {
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
export function pickReward(run: RunState): string | null {
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
export function spend(run: RunState, bought: Record<string, number>): void {
  const buy = (what: string, ok: boolean) => ok && (bought[what] = (bought[what] ?? 0) + 1);
  for (const b of run.broods) if (b.wounded && run.broods.filter(fit).length < maxFielded(run)) buy('heal', heal(run, b.id));
  const wanted: Unlock[] = [...new Set(run.broods.map((b) => KIND_NEST[b.kind]))].filter((t) => UNLOCKS.includes(t));
  for (const u of [...wanted, 'nova' as Unlock, ...UNLOCKS]) if (!unlocked(run, u) && run.biomass >= unlockCost(u) + 10) buy(`unlock ${u}`, unlock(run, u));
  const big = [...run.broods].sort((a, b) => b.size - a.size)[0];
  while (big && big.size >= big.cap - 2 && run.biomass >= COST.grow(big) + 30 && grow(run, big.id)) buy('grow', true);
}

// ---- a run ---------------------------------------------------------------------

/** One run, `probe-${seed}`, with its battles on the pool. */
export async function playRun(pool: Pool, seed: number, o: RunOptions): Promise<RunOutcome> {
  const run = newRun(`probe-${seed}`, 0, o.pack, 0, o.difficulty);
  const out: RunOutcome = {
    seed, pack: o.pack, status: '', turns: 0, broods: 0, biomass: 0, restored: false, at: 0, depth: 0,
    battles: [], rewards: [], bought: {}, deaths: 0, rescues: 0,
    lords: { broken: 0, eaten: 0, fought: 0, avoided: 0, battles: 0, wins: 0 },
  };
  const met = new Set<number>();
  for (let guard = 0; guard < 80 && run.status === 'active'; guard++) {
    const picked = pickReward(run);
    if (picked) out.rewards.push(picked);
    run.offer = undefined;
    spend(run, out.bought);
    const id = pickMove(run);
    const node = run.nodes[id];
    if (!needsBattle(run, id)) {
      resolveTurn(run, id, null, [], 0);
      continue;
    }
    const fielded = pickBroods(run);
    const lord = node.kind === 'finale' ? undefined : warlordFighting(run, id);
    const setup = nodeSetup(run, id, fielded);
    const me = setup.players[0];
    const army = (me.army ?? []).reduce((s, a) => s + a.count, 0);
    const res = await pool.battle({ setup, human: me.faction, proxy: { skill: o.skill, knobs: o.knobs, novaLocked: !run.unlocks.nova }, cap: CAP, early: o.early });
    if (lord) {
      met.add(lord.id);
      out.lords.battles++;
      if (res.won) out.lords.wins++;
    }
    out.battles.push({
      kind: node.kind,
      difficulty: node.difficulty,
      rivals: node.rivals,
      depth: node.depth,
      won: res.won,
      capped: res.capped,
      decided: res.decided,
      minutes: res.report.seconds / 60,
      army,
      survivors: res.report.survivors.reduce((a, b) => a + b, 0),
      team: me.team,
      cls: classOf(setup),
      result: res,
    });
    const turn = resolveTurn(run, id, res.report, fielded, 0);
    out.biomass += turn.biomass;
    out.deaths += turn.events.filter((e) => e.what === 'died').length;
    out.rescues += turn.events.filter((e) => e.what === 'rescued').length;
    if (turn.checkpoint === 'restored') out.restored = true;
  }
  for (const w of run.warlords ?? []) {
    if (w.broken) out.lords.broken++;
    else if (run.swallowed.includes(w.stronghold)) out.lords.eaten++;
    else if (met.has(w.id)) out.lords.fought++;
    else out.lords.avoided++;
  }
  Object.assign(out, { status: run.status, lostTo: run.lostTo, turns: run.turn, broods: run.broods.length, at: run.at, depth: run.nodes[run.at].depth });
  return out;
}
