// Reward impact (#60, #68): the human proxy fights the same seeded battles
// with and without each reward, on the pool, and the win-rate change is the
// reward's impact. The army is the same in both arms: a Swarmer brood, a brood
// of the reward's kind (Shields for Swarmer strains and everything else) and a
// Spear brood, every nest type unlocked. Each army has its own baseline: a
// Raider strain is measured against Raiders without it, not against Shields. Strains go on the matching brood; anything else is held
// as a perk. Hunger does nothing in battle, so it's skipped. Lone wolf's
// one brood takes turns: the Swarmers on one seed, the second brood on the
// next, the Spears on the third.
// The rival is Brutal with 10-dot broods by default: at Normal or Hard the
// proxy wins nearly every battle, so win rates can't move.
//
// Seeds are common to every arm, so an item's impact is the mean of paired
// differences (item minus baseline, seed by seed). Sequential stopping: every
// item starts at N_START seeds and doubles them, up to N_MAX, while it has
// fewer than N_DECIDE or its interval straddles a line that decides it: a tier boundary (the thirds of
// the current impacts), the must-pick line or zero. Rewards differ by a few
// points, so it takes hundreds of seeds; a battle is about half a second, so
// the whole sweep is ten minutes or so on the pool.
// An item whose every battle plays out exactly like the baseline's was never
// used by the proxy (most power variants): it's unmeasured, not useless.
import { nodeSetup } from '../../src/campaign/battle';
import { newBrood } from '../../src/campaign/broods';
import { REWARD, REWARDS, type Tier } from '../../src/campaign/rewards';
import { newRun, type RunState } from '../../src/campaign/run';
import { Kind, TICK_HZ } from '../../src/sim/constants';
import type { PoolJob, Result } from './battle';

/** What the sweep needs of the pool. */
type Battler = { battle(job: PoolJob): Promise<Result> };

export const N_START = 16;
export const N_MAX = 384;
/** no item is decided on fewer seeds: a lucky or unlucky start can clear a line by chance (Cluster stopped at 64 seeds, 9 points off its 384-seed impact, #125) */
export const N_DECIDE = 128;
/** a must-pick: more than this many points... */
export const MUST_PICK = 0.15;
/** ...or more than this many times the median impact, once the median is at least MEDIAN_FLOOR */
export const MUST_PICK_MEDIAN = 2;
const MEDIAN_FLOOR = 0.05;
/** interval half-width in standard errors */
const Z = 1.645;
const CAP = 10 * 60 * TICK_HZ;

export interface ImpactOptions {
  seeds?: number;
  size?: number;
  diff?: number;
  ids?: string[];
}

export interface Impact {
  id: string;
  /** seeds played */
  n: number;
  /** win-rate change, item minus baseline over the same seeds */
  delta: number;
  /** its interval half-width */
  half: number;
  /** mean battle-length change, seconds */
  secs: number;
  /** the same change in logit units at the baseline's win rate: the surrogate's strength factor */
  logit: number;
  /** every battle played out exactly like the baseline's: the proxy never used it */
  unused: boolean;
}

export interface ImpactTable {
  /** the Shield army's baseline (Raider and Spear strains have their own) */
  base: { rate: number; n: number; secs: number };
  items: Impact[];
  /** the lines items are judged against */
  lines: { lower: number; upper: number; mustPick: number };
  opts: Required<ImpactOptions>;
}

/** Items tiered by thirds: everything but pacts, which are judged on their net impact alone. */
export const tiered = (id: string) => REWARD[id].family !== 'pact';

/** The second brood's kind for a reward's arm (and its baseline). */
const secondOf = (id: string | null) => {
  const r = REWARD[id ?? ''];
  return r?.kind !== undefined && r.kind !== Kind.Dot ? r.kind : Kind.Tank;
};
const baseKey = (second: number) => `base:${second}`;

/** One battle: a 1v1 against a `diff` bot next to the start of seed `k`'s run, with `id` held (or nothing, with `second` as the middle brood). */
function battle(pool: Battler, o: Required<ImpactOptions>, k: number, id: string | null, second = secondOf(id)) {
  const r = REWARD[id ?? ''];
  const run: RunState = newRun(`reward-probe-${o.seeds + k}`, 0, 'swarm', 0);
  run.broods = [Kind.Dot, second, Kind.Lancer].map((kind, b) => ({ ...newBrood(b, kind, run.seed, []), size: o.size, cap: o.size }));
  // Lone wolf fields one brood: each brood in turn, seed by seed, since a player picks which.
  run.fielded = id === 'lone-wolf' ? [run.broods[k % run.broods.length].id] : run.broods.map((b) => b.id);
  run.unlocks = { nests: 0xff, nova: true };
  if (r?.family === 'strain') run.broods.find((b) => b.kind === r.kind)!.strains.push(r.id);
  else if (r) run.perks.push(r.id);
  const node = run.nodes[run.start].links.find((l) => run.nodes[l].kind === 'conquest' && !run.nodes[l].domain) ?? run.nodes[run.start].links[0];
  Object.assign(run.nodes[node], { difficulty: o.diff, rivals: 1 });
  return pool.battle({ setup: nodeSetup(run, node, run.fielded), human: run.color, proxy: { skill: 1 }, cap: CAP }).then((res) => ({ won: +res.won, secs: res.ticks / TICK_HZ }));
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  // The value with a share q of the items at or below it: thirds of 6 items split 2/2/2.
  return s.length ? s[Math.max(0, Math.ceil(q * s.length) - 1)] : 0;
};
const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (p: number) => Math.min(0.97, Math.max(0.03, p));

/** The lines that decide a reward: the tier boundaries (thirds of tiered impacts) and the must-pick line. */
export function linesOf(items: { id: string; delta: number }[]): ImpactTable['lines'] {
  const ds = items.filter((i) => tiered(i.id)).map((i) => i.delta);
  const median = quantile(ds, 0.5);
  return {
    lower: quantile(ds, 1 / 3),
    upper: quantile(ds, 2 / 3),
    mustPick: median >= MEDIAN_FLOOR ? Math.min(MUST_PICK, MUST_PICK_MEDIAN * median) : MUST_PICK,
  };
}

/** Is `x` within the interval? */
const straddles = (i: Impact, x: number) => Math.abs(i.delta - x) < i.half;

export async function measureImpact(pool: Battler, opts: ImpactOptions = {}, log = (_: string) => {}): Promise<ImpactTable> {
  const o: Required<ImpactOptions> = {
    seeds: opts.seeds ?? 0,
    size: opts.size ?? 10,
    diff: opts.diff ?? 3,
    ids: opts.ids ?? REWARDS.map((r) => r.id).filter((id) => id !== 'hunger'),
  };
  const played = new Map<string, { won: number; secs: number }[]>();
  const play = async (key: string, n: number, id: string | null, second?: number) => {
    const have = played.get(key) ?? [];
    const more = await Promise.all(Array.from({ length: Math.max(0, n - have.length) }, (_, j) => battle(pool, o, have.length + j, id, second)));
    played.set(key, [...have, ...more]);
  };
  const seconds = [...new Set(o.ids.map(secondOf))];
  const want = new Map(o.ids.map((id) => [id, N_START]));
  let items: Impact[] = [];
  let lines: ImpactTable['lines'] = { lower: 0, upper: 0, mustPick: MUST_PICK };
  for (let round = 0; ; round++) {
    const most = (second: number) => Math.max(...[...want].filter(([id]) => secondOf(id) === second).map(([, n]) => n));
    await Promise.all([...seconds.map((k) => play(baseKey(k), most(k), null, k)), ...[...want].map(([id, n]) => play(id, n, id))]);
    items = o.ids.map((id) => {
      const base = played.get(baseKey(secondOf(id)))!;
      const arm = played.get(id)!;
      const d = arm.map((b, k) => b.won - base[k].won);
      const unused = arm.every((b, k) => b.won === base[k].won && b.secs === base[k].secs);
      const n = d.length;
      const delta = d.reduce((s, v) => s + v, 0) / n;
      const sd = Math.sqrt(d.reduce((s, v) => s + (v - delta) ** 2, 0) / Math.max(1, n - 1));
      // An all-agreeing arm still isn't certain: floor the sd at one flip in n.
      const half = (Z * Math.max(sd, 1 / Math.sqrt(n))) / Math.sqrt(n);
      const rate = base.slice(0, n).reduce((s, b) => s + b.won, 0) / n;
      const secs = arm.reduce((s, b, k) => s + b.secs - base[k].secs, 0) / n;
      return { id, n, delta, half, secs, logit: unused ? 0 : logit(clamp(rate + delta)) - logit(clamp(rate)), unused };
    });
    lines = linesOf(items.filter((i) => !i.unused));
    const open = items.filter((i) => !i.unused && i.n < N_MAX && (i.n < N_DECIDE || [lines.lower, lines.upper, lines.mustPick, 0].some((x) => straddles(i, x))));
    log(`round ${round}: ${items.length} items, ${open.length} undecided`);
    if (!open.length) break;
    for (const i of open) want.set(i.id, Math.min(N_MAX, 2 * i.n));
  }
  const base = played.get(baseKey(Kind.Tank))!;
  return {
    base: { rate: base.reduce((s, b) => s + b.won, 0) / base.length, n: base.length, secs: base.reduce((s, b) => s + b.secs, 0) / base.length },
    items,
    lines,
    opts: o,
  };
}

export interface Verdict {
  /** suggested tier (pacts keep theirs) */
  tier: Tier;
  flag: '' | 'must-pick' | 'no impact' | 'unmeasured' | 'playtest';
}

/** Tier by thirds of measured impact; flag must-picks to nerf, rewards with no impact to buff, and the unmeasured. */
export function verdicts(t: ImpactTable): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const i of t.items) {
    const r = REWARD[i.id];
    // Unmeasured items and pacts keep their tier.
    const tier: Tier = !tiered(i.id) || i.unused ? r.tier : i.delta > t.lines.upper ? 'rare' : i.delta > t.lines.lower ? 'uncommon' : 'common';
    // Blood price can't be judged here: the proxy doesn't know to spare its energy.
    const flag = i.id === 'blood-price' ? 'playtest' : i.unused ? 'unmeasured' : i.delta > t.lines.mustPick ? 'must-pick' : i.delta <= 0 ? 'no impact' : '';
    out[i.id] = { tier, flag };
  }
  return out;
}

export const IMPACT_FILE = 'reward-impact.json';
