// The run surrogate (#68): each battle's outcome drawn from a model fitted to
// the battle panel (model.ts builds it), while the real run logic (map,
// Bloom, routing, rewards, camp, warlords; runs.ts policies) plays the rest.
// Thousands of runs take seconds.
//
// The model, per node kind: logistic win odds with an intercept per band,
// slopes for the node's bot level and rivals (the route picks easy nodes, so
// a band's average node would be too hard), the Bloom's pressure on the node
// and its strength (its swarms in battle), the run's bot shift, log army
// (relative to the band's typical) and skill, plus each node's own hardness:
// battles are seeded, so a node that beat you tends to beat you again.
// Hardness is a random effect (its spread fitted on the panel, where each node
// is measured at three army sizes); the surrogate draws it once per node per
// run, so retries share it. Survivors, nests held and minutes come from the
// band's measured means, won or lost.
import { armyFor } from '../../src/campaign/battle';
import type { BattleReport } from '../../src/campaign/broods';
import { RUN_DIFFICULTY, difficultyOf, bloomStrength, pressure, warlordFighting, type RunState } from '../../src/campaign/run';
import { TICK_HZ } from '../../src/sim/constants';
import { Rng, hashString } from '../../src/sim/rng';
import { CAP, type Fight, type Result } from './battle';
import { dot, sigmoid } from './fit';

export type CellKind = 'conquest' | 'domination' | 'stronghold' | 'hold' | 'finale';
export const KINDS: readonly CellKind[] = ['conquest', 'domination', 'stronghold', 'hold', 'finale'];
export const BANDS = 4;
/** The panel's kind for a node: a standing warlord's stronghold is its own kind. */
export function cellKind(run: RunState, id: number): CellKind {
  const n = run.nodes[id];
  if (n.kind === 'finale' || n.kind === 'hold') return n.kind;
  const w = warlordFighting(run, id);
  if (w && w.stronghold === id && !w.broken) return 'stronghold';
  return n.kind === 'domination' ? 'domination' : 'conquest';
}

export function bandOf(run: RunState, id: number): number {
  const far = Math.max(1, run.nodes[run.heart].depth);
  return Math.min(BANDS - 1, Math.floor((BANDS * run.nodes[id].depth) / far));
}

export const shiftOf = (run: RunState) => RUN_DIFFICULTY[difficultyOf(run)].bots;

// ---- the panel's shape ----------------------------------------------------------------

export interface PanelBattle {
  kind: CellKind;
  /** the node measured (run seed and node id): its battles share a hardness */
  node: string;
  band: number;
  shift: number;
  /** the node's bot level and rivals */
  difficulty: number;
  rivals: number;
  /** the Bloom's pressure on the node (0..1) and its strength (nodes swallowed) */
  pressure: number;
  strength: number;
  /** army over the band's typical */
  ratio: number;
  skill: number;
  army: number;
  won: boolean;
  capped: boolean;
  survivors: number;
  nests: number;
  seconds: number;
}

export interface Outcome {
  n: number;
  /** survivors over the army */
  survive: number;
  nests: number;
  seconds: number;
  capped: number;
}

export interface Panel {
  fp: string;
  /** median army fielded on the route, per band */
  typical: number[];
  battles: PanelBattle[];
  /** per kind: logistic weights over features() */
  weights: Partial<Record<CellKind, number[]>>;
  /** per kind: the spread (sd, logit) of node hardness */
  hardness: Partial<Record<CellKind, number>>;
  /** per kind and band: means for won (0) and lost (1) battles */
  outcomes: Partial<Record<CellKind, (Outcome | null)[][]>>;
}

/** The model's features: an intercept per band, then bot level, rivals, Bloom pressure and strength, shift, log army and skill. */
export interface Where {
  band: number;
  difficulty: number;
  rivals: number;
  pressure: number;
  strength: number;
  shift: number;
  ratio: number;
  skill: number;
}
export function features(b: Where): number[] {
  const x = new Array(BANDS).fill(0);
  x[b.band] = 1;
  return [...x, b.difficulty, b.rivals, b.pressure, b.strength / 5, b.shift, Math.log(Math.max(0.25, Math.min(2, b.ratio))), 1 - b.skill];
}

// ---- the surrogate -----------------------------------------------------------------

/** The model's win odds for a battle, at a node `hard` sds harder than the usual (0: the median node). */
export function winOdds(panel: Panel, kind: CellKind, at: Where, hard = 0): number {
  const w = panel.weights[kind] ?? panel.weights.conquest!;
  // A kind never seen in this band borrows the nearest band's intercept.
  const seen = (b: number) => panel.battles.some((x) => x.kind === kind && x.band === b);
  let b = at.band;
  for (let d = 1; !seen(b) && d < BANDS; d++) b = seen(at.band - d) ? at.band - d : seen(at.band + d) ? at.band + d : b;
  return sigmoid(dot(w, features({ ...at, band: b })) - hard * (panel.hardness[kind] ?? 0));
}

function outcomeOf(panel: Panel, kind: CellKind, band: number, won: boolean): Outcome {
  const rows = panel.outcomes[kind] ?? panel.outcomes.conquest!;
  for (let d = 0; d < BANDS; d++)
    for (const b of [band - d, band + d]) {
      const o = rows[b]?.[won ? 0 : 1];
      if (o) return o;
    }
  return { n: 0, survive: won ? 0.7 : 0, nests: won ? 3 : 0, seconds: 300, capped: 0 };
}

/** A Fight that draws each battle's outcome from the panel's model, seeded by the run and turn. */
export function surrogateFight(panel: Panel): Fight {
  return async (job, { run, id, fielded, army }) => {
    const kind = cellKind(run, id), band = bandOf(run, id);
    // The node's hardness: one draw per node per run, so retries share it.
    const h = new Rng(hashString(`hardness:${run.seed}:${id}`));
    const hard = Math.sqrt(-2 * Math.log(1 - h.next())) * Math.cos(2 * Math.PI * h.next());
    const n = run.nodes[id];
    const p = winOdds(panel, kind, { band, difficulty: n.difficulty, rivals: n.rivals, pressure: pressure(run, id), strength: bloomStrength(run), shift: shiftOf(run), ratio: army / panel.typical[band], skill: job.proxy.skill ?? 1 }, hard);
    const rng = new Rng(hashString(`surrogate:${run.seed}:${run.turn}:${id}`));
    const won = rng.next() < p;
    const o = outcomeOf(panel, kind, band, won);
    const survivors = [0, 0, 0, 0];
    for (const a of armyFor(run, fielded)) if (a.kind < survivors.length) survivors[a.kind] += Math.round(o.survive * a.count);
    const capped = !won && rng.next() < o.capped;
    const seconds = capped ? CAP / TICK_HZ : o.seconds;
    const report: BattleReport = { won, survivors, nests: Math.round(o.nests), seconds };
    const r: Result = { won, capped, report, decided: false, ticks: Math.round(seconds * TICK_HZ), trace: { team: [], share: [] } };
    return r;
  };
}
