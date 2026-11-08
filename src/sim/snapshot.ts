import { Bot, type BotConfig, type BotState } from './ai/bot';
import { MAX_UNITS } from './constants';
import { Rng } from './rng';
import { createWorld, type MatchSetup } from './setup';
import type { World } from './world';

/**
 * World snapshots (#155): an exact copy of the simulation at a tick, for
 * multiplayer rejoin and late join, desync reports and host migration.
 *
 * The world is copied generically: every own field of `World` is saved
 * unless it's listed in SKIP, so a field added later is covered without
 * touching this file. Unit typed arrays are saved raw up to the high-water
 * slot `n`. Everything else goes through JSON with tags for what JSON can't
 * carry exactly (Rng instances, NaN/±Infinity, -0). Anything else that isn't
 * plain data (a Map, a Set, a class instance) throws, so a new kind of state
 * can't be silently left out.
 *
 * Restoring builds a fresh world from the same MatchSetup (terrain, flow
 * fields and choke caches come back with it) and overwrites every saved
 * field. `fullHash` hashes the encoded bytes, so it covers exactly what a
 * snapshot covers.
 */

/** Fields that are constant after setup, derived, or output-only (drained by the client). */
const SKIP = new Set([
  'seed', 'width', 'height', // checked against the setup on restore
  'grid', // rebuilt every step (and on restore)
  'terrain', // static after construction; caches never change the sim
  'uidToSlot', // rebuilt from uid + alive
  'bots', // saved as {faction, cfg, state} below
  'beams', 'beamCount', 'deaths', 'fx', // render output
]);

export type SnapArray = Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

export interface WorldSnap {
  /** tagged JSON of every non-array field (plus `bots`) */
  json: string;
  /** typed arrays by World field name, in declaration order */
  arrays: [string, SnapArray][];
}

interface SavedBot {
  faction: number;
  cfg: BotConfig;
  state: BotState;
}

function replacer(this: unknown, key: string, v: unknown): unknown {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $n: 'NaN' };
    if (v === Infinity) return { $n: 'Infinity' };
    if (v === -Infinity) return { $n: '-Infinity' };
    if (Object.is(v, -0)) return { $n: '-0' };
    return v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Rng) return { $rng: v.s };
  if (Array.isArray(v)) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`snapshot: can't save field "${key}" (${proto?.constructor?.name ?? 'unknown'}); add it to snapshot.ts`);
  }
  return v;
}

const NUMS: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };

function reviver(_key: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.$n === 'string' && Object.keys(o).length === 1) return NUMS[o.$n];
    if (typeof o.$rng === 'number' && Object.keys(o).length === 1) {
      const r = new Rng(1);
      r.s = o.$rng;
      return r;
    }
  }
  return v;
}

/** Copy everything that changes as the match plays. */
export function snapshotWorld(w: World): WorldSnap {
  const state: Record<string, unknown> = {};
  const arrays: [string, SnapArray][] = [];
  const src = w as unknown as Record<string, unknown>;
  for (const key of Object.keys(w)) {
    if (SKIP.has(key)) continue;
    const v = src[key];
    if (ArrayBuffer.isView(v)) {
      const a = v as SnapArray;
      arrays.push([key, (a.length === MAX_UNITS ? a.slice(0, w.n) : a.slice()) as SnapArray]);
    } else if (key === 'events' && w.events) {
      // the schedule is part of the map: restore takes it from the setup
      state[key] = { ...w.events, spec: undefined };
    } else {
      state[key] = v;
    }
  }
  const bots: SavedBot[] = w.bots.map((b) => ({ faction: b.faction, cfg: b.cfg, state: b.exportState() }));
  state.bots = bots;
  return { json: JSON.stringify(state, replacer), arrays };
}

/** A new world equal to the one the snapshot was taken from. `setup` must be the match's own. */
export function restoreWorld(setup: MatchSetup, snap: WorldSnap): World {
  const w = createWorld(setup);
  const dst = w as unknown as Record<string, unknown>;
  const state = JSON.parse(snap.json, reviver) as Record<string, unknown>;
  for (const [key, a] of snap.arrays) {
    const target = dst[key];
    if (!ArrayBuffer.isView(target)) throw new Error(`snapshot: world has no typed array "${key}"`);
    const t = target as SnapArray;
    if (a.length > t.length || t.constructor !== a.constructor) throw new Error(`snapshot: array "${key}" doesn't fit`);
    t.fill(0);
    t.set(a as never);
  }
  for (const key of Object.keys(state)) {
    if (key === 'bots') continue;
    if (!(key in dst)) throw new Error(`snapshot: world has no field "${key}"`);
    const v = state[key];
    if (key === 'rng') {
      w.rng.s = (v as Rng).s;
    } else if (key === 'events' && v) {
      const spec = w.events?.spec;
      if (!spec) throw new Error('snapshot: events in the snapshot but not in the setup');
      dst[key] = { ...(v as object), spec };
    } else {
      dst[key] = v;
    }
  }
  w.uidToSlot.clear();
  for (let i = 0; i < w.n; i++) if (w.alive[i]) w.uidToSlot.set(w.uid[i], i);
  w.bots = (state.bots as SavedBot[]).map((s) => {
    const b = new Bot(s.faction, s.cfg, w.seed);
    b.importState(s.state);
    return b;
  });
  w.grid.build(w);
  return w;
}

// ---- bytes ----------------------------------------------------------------

const MAGIC = 0x31535753; // "SWS1"
const TYPES: (new (b: ArrayBuffer) => SnapArray)[] = [
  Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array,
];
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Layout (little-endian): magic u32, json byte length u32, array count u32,
 * json utf-8, then per array: name length u8, name, type u8, element count
 * u32, padding to the element size, raw elements.
 */
export function encodeSnap(s: WorldSnap): Uint8Array {
  if (!LITTLE) throw new Error('snapshot: big-endian platforms are not supported');
  const enc = new TextEncoder();
  const json = enc.encode(s.json);
  const names = s.arrays.map(([k]) => enc.encode(k));
  let size = 12 + json.length;
  s.arrays.forEach(([, a], i) => {
    size += 1 + names[i].length + 1 + 4;
    size = align(size, a.BYTES_PER_ELEMENT) + a.byteLength;
  });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, json.length, true);
  dv.setUint32(8, s.arrays.length, true);
  out.set(json, 12);
  let o = 12 + json.length;
  s.arrays.forEach(([, a], i) => {
    const t = TYPES.findIndex((T) => a instanceof T);
    if (t < 0) throw new Error('snapshot: unsupported array type');
    out[o++] = names[i].length;
    out.set(names[i], o);
    o += names[i].length;
    out[o++] = t;
    dv.setUint32(o, a.length, true);
    o = align(o + 4, a.BYTES_PER_ELEMENT);
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  });
  return out;
}

export function decodeSnap(bytes: Uint8Array): WorldSnap {
  if (!LITTLE) throw new Error('snapshot: big-endian platforms are not supported');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('snapshot: not a world snapshot');
  const dec = new TextDecoder();
  const jsonLen = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const json = dec.decode(bytes.subarray(12, 12 + jsonLen));
  const arrays: [string, SnapArray][] = [];
  let o = 12 + jsonLen;
  for (let i = 0; i < count; i++) {
    const nl = bytes[o++];
    const name = dec.decode(bytes.subarray(o, o + nl));
    o += nl;
    const T = TYPES[bytes[o++]];
    if (!T) throw new Error('snapshot: bad array type');
    const len = dv.getUint32(o, true);
    const el = (T as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
    o = align(o + 4, el);
    const end = o + len * el;
    if (end > bytes.length) throw new Error('snapshot: truncated');
    // copy out, so the arrays don't alias (or depend on the alignment of) the input
    arrays.push([name, new T(bytes.slice(o, end).buffer)]);
    o = end;
  }
  return { json, arrays };
}

function align(o: number, n: number): number {
  return Math.ceil(o / n) * n;
}

/** Snapshot bytes for `w`. */
export function serializeWorld(w: World): Uint8Array {
  return encodeSnap(snapshotWorld(w));
}

/** Checksum of everything a snapshot holds (FNV-1a over its bytes). Wider than `worldHash`. */
export function fullHash(w: World): number {
  return hashBytes(serializeWorld(w));
}

export function hashBytes(b: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- diffing --------------------------------------------------------------

/** A snapshot as one plain object (typed arrays as number arrays), for diffing and dumps. */
export function snapToObject(s: WorldSnap): Record<string, unknown> {
  const o = JSON.parse(s.json) as Record<string, unknown>;
  for (const [k, a] of s.arrays) o[k] = Array.from(a);
  return o;
}

export interface SnapDiff {
  path: string;
  a: unknown;
  b: unknown;
}

/**
 * Differences between two snapshots, in field order, up to `max`. Unit-array
 * paths name the slot and that slot's uid in each snapshot, e.g. `x[12] (uid 340/340)`.
 */
export function diffSnaps(sa: WorldSnap, sb: WorldSnap, max = 20): SnapDiff[] {
  const a = snapToObject(sa), b = snapToObject(sb);
  const ua = a.uid as number[] | undefined, ub = b.uid as number[] | undefined;
  const unitArrays = new Set(sa.arrays.filter(([, x]) => x.length === (a.n as number)).map(([k]) => k));
  const out: SnapDiff[] = [];
  const walk = (x: unknown, y: unknown, path: string, top: string): void => {
    if (out.length >= max) return;
    if (x === y) return;
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      if (Array.isArray(x) !== Array.isArray(y)) {
        out.push({ path, a: x, b: y });
        return;
      }
      if (Array.isArray(x)) {
        const ya = y as unknown[];
        const n = Math.max(x.length, ya.length);
        for (let i = 0; i < n && out.length < max; i++) {
          const unit = path === top && unitArrays.has(top);
          const p = unit ? `${path}[${i}] (uid ${ua?.[i] ?? '-'}/${ub?.[i] ?? '-'})` : `${path}[${i}]`;
          walk(x[i], ya[i], p, top);
        }
        return;
      }
      const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(xo), ...Object.keys(yo)])];
      for (const k of keys) walk(xo[k], yo[k], path ? `${path}.${k}` : k, top || k);
      return;
    }
    out.push({ path, a: x, b: y });
  };
  walk(a, b, '', '');
  return out;
}
