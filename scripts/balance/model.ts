// The battle panel for the run surrogate (#68, surrogate.ts): node kind
// (conquest, domination, stronghold, hold, finale) × depth band (4) × army (3
// sizes) × bot shift (Gentle -1, Standard/Hard 0, Brutal +1), SEEDS battles
// per cell at skill 1, and skill 0.5 on every third cell. Its battles come
// from real run states: run-probe runs on the pool (their own seeds, apart
// from validation's), snapshot before each battle, wins, losses and all. A
// snapshot stands in for its node and for the other nodes of its band, so
// strongholds and holds the route skips still get measured. The army is the
// snapshot's fielded broods scaled to ARMY of the band's typical.
import { armyFor, nodeSetup } from '../../src/campaign/battle';
import type { PackId } from '../../src/campaign/broods';
import { bloomStrength, needsBattle, pressure, type RunDifficulty, type RunState } from '../../src/campaign/run';
import { mixedLogistic } from './fit';
import type { Pool } from './pool';
import { pickBroods, playRun } from './runs';
import { CAP, type Fight } from './battle';
import { BANDS, KINDS, bandOf, cellKind, features, shiftOf, type CellKind, type Outcome, type Panel, type PanelBattle } from './surrogate';

export * from './surrogate';

/** army sizes, as a share of the band's typical army */
export const ARMY = [0.5, 0.8, 1.1];
export const SHIFTS = [-1, 0, 1];
/** battles per cell */
export const SEEDS = 6;
/** runs per difficulty the snapshots come from */
const RUNS = 16;
const DIFFS_OF: Record<number, RunDifficulty[]> = { [-1]: ['gentle'], 0: ['standard', 'hard'], 1: ['brutal'] };
const PACKS: PackId[] = ['swarm', 'wall', 'raid'];
const PANEL_FILE = 'panel.json';

const armyOf = (run: RunState, fielded: number[]) => armyFor(run, fielded).reduce((s, a) => s + a.count, 0);

// ---- snapshots ------------------------------------------------------------------

interface Snapshot {
  /** the run state before the battle, as JSON */
  state: string;
  id: number;
  kind: CellKind;
  band: number;
  shift: number;
  run: number;
}

/** Seeds of the runs the panel's snapshots come from: apart from run-probe's (and validation's) from 0. */
const SNAP_SEED = 5000;

/**
 * Real runs on the pool (run-probe's policies and battles), recording the run
 * state before each battle. Per run, each kind and band keeps one snapshot:
 * the first battle the route actually fights there, or else a stand-in, an
 * unvisited node of that kind in the band of a battle it did fight (with that
 * battle's state, so a little early). Also the army fielded on the route, per band.
 */
async function snapshots(pool: Pool): Promise<{ snaps: Snapshot[]; armies: number[][] }> {
  const snaps: Snapshot[] = [];
  const armies: number[][] = Array.from({ length: BANDS }, () => []);
  const jobs: Promise<unknown>[] = [];
  Object.values(DIFFS_OF).forEach((diffs, d) =>
    diffs.forEach((difficulty, i) => {
      for (let k = 0; k < RUNS; k++) {
        const seed = SNAP_SEED + 1000 * d + 100 * i + k;
        const kept = new Map<string, Snapshot & { fought: boolean }>();
        const record: Fight = (job, { run, id, army }) => {
          const band = bandOf(run, id);
          armies[band].push(army);
          const state = JSON.stringify(run);
          const snap = (n: number) => ({ state, id: n, kind: cellKind(run, n), band, shift: shiftOf(run), run: seed });
          const own = snap(id);
          const key = `${own.kind}:${band}`;
          if (!kept.get(key)?.fought) kept.set(key, { ...own, fought: true });
          for (const n of run.nodes) {
            if (n.id === id || !needsBattle(run, n.id) || run.swallowed.includes(n.id) || n.kind === 'start' || bandOf(run, n.id) !== band) continue;
            const s = snap(n.id);
            if (!kept.has(`${s.kind}:${band}`)) kept.set(`${s.kind}:${band}`, { ...s, fought: false });
          }
          return pool.battle(job);
        };
        jobs.push(playRun(record, seed, { pack: PACKS[k % PACKS.length], difficulty, skill: 1 }).then(() => snaps.push(...[...kept.values()].map(({ fought: _, ...s }) => s))));
      }
    }),
  );
  await Promise.all(jobs);
  // Runs finish in any order: sort so the cells' picks don't depend on it.
  snaps.sort((x, y) => x.run - y.run || x.band - y.band || x.id - y.id);
  return { snaps, armies };
}

// ---- the panel --------------------------------------------------------------------

/**
 * Measure the panel on the pool and fit the model. The battles are cached, so
 * a rebuild on unchanged code is just the run logic and the fit (seconds).
 * The panel is also written to the cache as panel.json, for later probes.
 */
export async function buildPanel(pool: Pool, log = (_: string) => {}): Promise<Panel> {
  const { snaps, armies } = await snapshots(pool);
  const typical = armies.map((a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 30));

  // Cells: SEEDS snapshots from distinct runs, each army scaled to ARMY of typical.
  const jobs: Promise<PanelBattle>[] = [];
  let cell = 0;
  for (const kind of KINDS)
    for (let band = 0; band < BANDS; band++)
      for (const shift of SHIFTS) {
        const pick: Snapshot[] = [];
        for (const s of snaps) if (s.kind === kind && s.band === band && s.shift === shift && !pick.some((p) => p.run === s.run) && pick.length < SEEDS) pick.push(s);
        if (!pick.length) continue;
        for (const factor of ARMY) {
          const skills = cell++ % 3 === 0 ? [1, 0.5] : [1];
          for (const s of pick) for (const skill of skills) jobs.push(measure(pool, s, factor * typical[band], typical[band], skill));
        }
      }
  log(`panel: ${snaps.length} snapshots, ${cell} cells, ${jobs.length} battles`);
  const battles = await Promise.all(jobs);

  const weights: Panel['weights'] = {};
  const hardness: Panel['hardness'] = {};
  const outcomes: Panel['outcomes'] = {};
  for (const kind of KINDS) {
    const of = battles.filter((b) => b.kind === kind);
    if (!of.length) continue;
    const ids = [...new Set(of.map((b) => b.node))];
    const fit = mixedLogistic(of.map(features), of.map((b) => +b.won), of.map((b) => ids.indexOf(b.node)));
    weights[kind] = fit.w;
    hardness[kind] = fit.sd;
    outcomes[kind] = Array.from({ length: BANDS }, (_, band) => [true, false].map((won) => mean(of.filter((b) => b.band === band && b.won === won))));
  }
  const panel: Panel = { fp: pool.fp, typical, battles, weights, hardness, outcomes };
  pool.cache.write(PANEL_FILE, panel);
  return panel;
}

function mean(bs: PanelBattle[]): Outcome | null {
  if (!bs.length) return null;
  const avg = (f: (b: PanelBattle) => number) => bs.reduce((s, b) => s + f(b), 0) / bs.length;
  return { n: bs.length, survive: avg((b) => b.survivors / Math.max(1, b.army)), nests: avg((b) => b.nests), seconds: avg((b) => b.seconds), capped: avg((b) => +b.capped) };
}

/** One panel battle: the snapshot's run with its fielded broods scaled to `target` dots. */
async function measure(pool: Pool, s: Snapshot, target: number, typical: number, skill: number): Promise<PanelBattle> {
  const run = JSON.parse(s.state) as RunState;
  const fielded = pickBroods(run);
  const now = armyOf(run, fielded);
  if (now > 0) for (const b of run.broods) if (fielded.includes(b.id)) b.size = Math.max(1, Math.round((b.size * target) / now));
  const army = armyOf(run, fielded);
  const setup = nodeSetup(run, s.id, fielded);
  const me = setup.players[0];
  const r = await pool.battle({ setup, human: me.faction, proxy: { skill, novaLocked: !run.unlocks.nova }, cap: CAP });
  return {
    kind: s.kind, node: `${s.run}:${s.id}`, band: s.band, shift: s.shift, difficulty: run.nodes[s.id].difficulty, rivals: run.nodes[s.id].rivals, pressure: pressure(run, s.id), strength: bloomStrength(run), ratio: army / typical, skill, army,
    won: r.won, capped: r.capped, survivors: r.report.survivors.reduce((a, b) => a + b, 0), nests: r.report.nests, seconds: r.report.seconds,
  };
}
