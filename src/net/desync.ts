import { BUILD } from '../game/recording';
import { replayLog } from '../game/replay';
import type { TimedCommand } from '../game/session';
import { NEUTRAL } from '../sim/constants';
import type { MatchSetup } from '../sim/setup';
import type { World } from '../sim/world';
import { decodeSnap, diffSnaps, hashBytes, serializeWorld, type SnapDiff } from '../sim/snapshot';
import type { Ctrl, Turn } from './protocol';

/**
 * Desyncs (#165): when players' worlds stop matching, find out where, and
 * keep enough to find out why later.
 *
 * The host collects every player's world at the first tick that differs,
 * diffs the odd ones out against the majority's, and anyone can download a
 * bundle: the setup, every closed turn, the hashes each player reported, the
 * worlds, the diff and the browser. `analyzeBundle` (and scripts/desync.ts)
 * replays the turns to see whose world left the true course, and when.
 * No DOM in here.
 */

/**
 * Make this world differ, by the smallest amount there is (#165): the lowest
 * bit of a faction's energy, or of a unit's x. For tests and `?desync=`.
 * Returns the field it touched.
 */
export function nudgeWorld(w: World, what: 'energy' | 'x' = 'energy'): string {
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const flip = (v: number) => {
    f64[0] = v;
    u32[0] ^= 1;
    return f64[0];
  };
  if (what === 'x') {
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i]) continue;
      w.x[i] = flip(w.x[i]);
      return `x[${i}]`;
    }
  }
  const f = w.factions.find((x) => x.active && !x.eliminated && x.id !== NEUTRAL)!;
  f.energy = flip(f.energy);
  return `factions[${f.id}].energy`;
}

/** What the host found at a desync. */
export interface DesyncReport {
  tick: number;
  /** each seat's hash at `tick` */
  hashes: Record<number, number>;
  /** the seats outside the majority (every seat when there's none) */
  odd: number[];
  /** each seat's world at `tick`, as it came (seats that sent none are in `missing`) */
  snaps: Map<number, Uint8Array>;
  missing: number[];
  /** whose world the others were compared with (-1: no world to compare with) */
  ref: number;
  /** per seat, the fields that differ from the reference's */
  diffs: Record<number, SnapDiff[]>;
  /** the first differing field, in words, for everyone's screen */
  first: string | null;
}

/** Compare what came in: the majority's world against each odd one's. `prefer`: the seat to use as reference if it can be (the host's own). */
export function analyzeDesync(tick: number, hashes: Map<number, number>, odd: number[], snaps: Map<number, Uint8Array>, prefer: number): DesyncReport {
  const seats = [...hashes.keys()];
  const majority = odd.length < seats.length ? seats.filter((s) => !odd.includes(s)) : seats;
  const ref = majority.includes(prefer) && snaps.has(prefer) ? prefer : (majority.find((s) => snaps.has(s)) ?? -1);
  const diffs: Record<number, SnapDiff[]> = {};
  let first: string | null = null;
  if (ref >= 0) {
    const a = decodeSnap(snaps.get(ref)!);
    for (const s of seats) {
      if (s === ref || !snaps.has(s) || (odd.length < seats.length && !odd.includes(s))) continue;
      try {
        diffs[s] = diffSnaps(a, decodeSnap(snaps.get(s)!), 20);
      } catch {
        diffs[s] = [{ path: '(its world could not be read)', a: null, b: null }];
      }
      first ??= diffs[s][0]?.path ?? null;
    }
  }
  return {
    tick,
    hashes: Object.fromEntries(hashes),
    odd,
    snaps,
    missing: seats.filter((s) => !snaps.has(s)),
    ref,
    diffs,
    first,
  };
}

/** Everything needed to see a desync again, as JSON. */
export interface DesyncBundle {
  swarmDesync: 1;
  build: string;
  date: string;
  setup: MatchSetup;
  /** the seat of whoever downloaded it, and whether they were hosting */
  seat: number;
  host: boolean;
  /** the first tick that differed */
  tick: number;
  hashes: Record<number, number>;
  odd: number[];
  /** every hash each seat reported, [tick, hash], as far as this player saw them */
  reported: Record<number, [number, number][]>;
  /** closed turns from `first` on: the whole match from the host, what a guest held from a guest */
  turns: { first: number; list: Turn[] };
  /** each seat's world at `tick`, base64 */
  snaps: Record<number, string>;
  diffs: Record<number, SnapDiff[]>;
  env: { ua: string; platform: string; cores: number; language: string };
}

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function buildBundle(o: {
  setup: MatchSetup;
  seat: number;
  host: boolean;
  report: Pick<DesyncReport, 'tick' | 'hashes' | 'odd' | 'snaps' | 'diffs'>;
  reported: Record<number, [number, number][]>;
  turns: { first: number; turns: Turn[] };
}): DesyncBundle {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    swarmDesync: 1,
    build: BUILD,
    date: new Date().toISOString(),
    setup: o.setup,
    seat: o.seat,
    host: o.host,
    tick: o.report.tick,
    hashes: o.report.hashes,
    odd: o.report.odd,
    reported: o.reported,
    turns: { first: o.turns.first, list: o.turns.turns },
    snaps: Object.fromEntries([...o.report.snaps].map(([s, b]) => [s, b64(b)])),
    diffs: o.report.diffs,
    env: { ua: nav?.userAgent ?? 'node', platform: nav?.platform ?? '', cores: nav?.hardwareConcurrency ?? 0, language: nav?.language ?? '' },
  };
}

/** What a bundle says, replayed: per seat, where it left the replay's course, and how its world differs there. */
export interface BundleFinding {
  seat: number;
  /** the first reported hash tick that doesn't match the replay (null: all match) */
  divergedAt: number | null;
  /** fields where the seat's world at the bundle's tick differs from the replay's */
  paths: string[];
}

/**
 * Replay a bundle's turns from its setup (control entries included) and
 * compare each seat's reported hashes with the replay's at the same ticks.
 * Needs the whole match (`turns.first === 1`): the host's bundle.
 */
export function analyzeBundle(b: DesyncBundle): { partial: boolean; findings: BundleFinding[] } {
  if (b.turns.first !== 1) return { partial: true, findings: [] };
  const log: TimedCommand[] = [];
  const ctrl: { tick: number; ctrl: Ctrl }[] = [];
  b.turns.list.forEach((t, i) => {
    const tick = b.turns.first + i;
    for (const e of t.entries) log.push({ tick, cmd: e.cmd });
    for (const c of t.ctrl ?? []) ctrl.push({ tick, ctrl: c });
  });
  const wanted = new Set<number>();
  for (const rows of Object.values(b.reported)) for (const [t] of rows) if (t <= b.tick) wanted.add(t);
  wanted.add(b.tick);
  const truth = new Map<number, number>();
  let atTick = null as Uint8Array | null;
  replayLog(b.setup, log, ctrl, b.tick, (w) => {
    if (!wanted.has(w.tick)) return;
    const bytes = serializeWorld(w);
    truth.set(w.tick, hashBytes(bytes));
    if (w.tick === b.tick) atTick = bytes;
  });
  const findings: BundleFinding[] = [];
  const seats = new Set([...Object.keys(b.hashes), ...Object.keys(b.reported)].map(Number));
  for (const seat of [...seats].sort((x, y) => x - y)) {
    const rows = (b.reported[seat] ?? []).filter(([t]) => truth.has(t)).sort((x, y) => x[0] - y[0]);
    const bad = rows.find(([t, h]) => truth.get(t) !== h);
    let divergedAt = bad ? bad[0] : null;
    if (divergedAt === null && b.hashes[seat] !== undefined && truth.has(b.tick) && truth.get(b.tick) !== b.hashes[seat]) divergedAt = b.tick;
    let paths: string[] = [];
    const snap = b.snaps[seat];
    if (snap && atTick) {
      try {
        paths = diffSnaps(decodeSnap(atTick), decodeSnap(unb64(snap)), 20).map((d) => d.path);
      } catch {
        paths = ['(its world could not be read)'];
      }
    }
    findings.push({ seat, divergedAt, paths });
  }
  return { partial: false, findings };
}
