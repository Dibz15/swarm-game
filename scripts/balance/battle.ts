// One headless battle for the balance harness (#68): the human proxy against
// whatever the setup holds, until the match ends or the cap. Runs inside the
// pool's workers (worker.ts) and needs nothing from the main thread but the job.
import { battleReport } from '../../src/campaign/battle';
import type { BattleReport } from '../../src/campaign/broods';
import { LEVEL_SPAWN_MULT, NEST_KIND, NEST_SPAWN_MULT, NEUTRAL, TICK_HZ, UNIT_STATS } from '../../src/sim/constants';
import { createWorld, type MatchSetup } from '../../src/sim/setup';
import { step } from '../../src/sim/step';
import { inArmy, type World } from '../../src/sim/world';
import { Proxy, type ProxyOptions } from '../../src/proxy/proxy';

/** Early decision: end a battle once one team holds over `share` of army plus production for `secs`. */
export interface Rule {
  share: number;
  secs: number;
}
export const DEFAULT_RULE: Rule = { share: 0.85, secs: 60 };

export interface Job {
  setup: MatchSetup;
  /** the proxy's faction */
  human: number;
  proxy: ProxyOptions;
  /** a battle still running after this many ticks counts as a retreat (a loss) */
  cap: number;
  /** end the battle on this rule (the pool sets it only where early-check.ts passed it) */
  early?: Rule;
}

/** Once a second: the strongest team and its share of army plus production, in hundredths. */
export interface Trace {
  team: number[];
  share: number[];
}

export interface Result {
  won: boolean;
  capped: boolean;
  report: BattleReport;
  /** the battle was ended by the job's early rule */
  decided: boolean;
  ticks: number;
  trace: Trace;
}

/**
 * Battle classes. Early decision is only for open fights and strongholds:
 * a siege is won by holding out against waves the count doesn't see, and a
 * heart by killing a boss that isn't an army.
 */
export type BattleClass = 'open' | 'stronghold' | 'siege' | 'heart';
export const classOf = (s: MatchSetup): BattleClass => (s.heart ? 'heart' : s.siege ? 'siege' : s.stronghold ? 'stronghold' : 'open');
export const EARLY_CLASSES: readonly BattleClass[] = ['open', 'stronghold'];

/**
 * Each team's army plus production: units fielded, plus what its nests
 * would spawn in a minute at their base rates (no upkeep or width falloff).
 */
export function strength(w: World): Map<number, number> {
  const s = new Map<number, number>();
  const add = (f: number, v: number) => {
    if (f < 0 || f === NEUTRAL || !w.factions[f].active) return;
    s.set(w.teamOf[f], (s.get(w.teamOf[f]) ?? 0) + v);
  };
  for (let i = 0; i < w.n; i++) if (inArmy(w, i)) add(w.owner[i], 1);
  for (const n of w.nests) {
    if (n.owner < 0 || n.owner === NEUTRAL || n.control < 1) continue;
    const f = w.factions[n.owner];
    const kind = NEST_KIND[n.type];
    if (kind < 0) continue;
    add(n.owner, (60 * LEVEL_SPAWN_MULT[n.level] * NEST_SPAWN_MULT[n.type] * f.prodMult * f.mods.spawnRate) / UNIT_STATS[kind].interval);
  }
  return s;
}

/** The strongest team and its share of the total (team -1 when nobody has anything). */
export function lead(w: World): { team: number; share: number } {
  let total = 0, team = -1, best = 0;
  for (const [t, v] of strength(w)) {
    total += v;
    if (v > best) (best = v), (team = t);
  }
  return { team, share: total > 0 ? best / total : 0 };
}

/** Where `rule` calls the battle on a trace: the leading team and the tick, or undefined if it never does. */
export function callOf(trace: Trace, rule: Rule): { team: number; tick: number } | undefined {
  const need = Math.round(rule.secs), over = Math.round(rule.share * 100);
  let run = 0;
  for (let s = 0; s < trace.team.length; s++) {
    const ahead = trace.share[s] > over && trace.team[s] >= 0;
    run = !ahead ? 0 : run > 0 && trace.team[s] === trace.team[s - 1] ? run + 1 : 1;
    if (run > need) return { team: trace.team[s], tick: (s + 1) * TICK_HZ };
  }
  return undefined;
}

export function playBattle(job: Job): Result {
  const w = createWorld(job.setup);
  const proxy = new Proxy(job.human, job.proxy);
  const trace: Trace = { team: [], share: [] };
  let call: ReturnType<typeof callOf>;
  while (!w.over && w.tick < job.cap) {
    step(w, proxy.think(w));
    w.fx = [];
    w.deaths = [];
    if (w.tick % TICK_HZ) continue;
    const l = lead(w);
    trace.team.push(l.team);
    trace.share.push(Math.floor(l.share * 100));
    if (job.early && (call = callOf(trace, job.early))) break;
  }
  const decided = !!call;
  const won = call ? call.team === w.teamOf[job.human] : w.over && w.winnerTeam === w.teamOf[job.human];
  return { won, capped: !w.over && !decided, report: battleReport(w, job.human, won), decided, ticks: w.tick, trace };
}
