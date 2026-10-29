import { fortify } from './fortify';
import { NEST_RADIUS, NestType } from './constants';
import { PI, TAU, dcos, dsin } from './mathx';
import { Rng } from './rng';
import { Terrain, capsuleDist, emptyTerrain, type Capsule, type CaveSpec, type FieldSpec, type TerrainSpec } from './terrain';

export type MapSize = 'small' | 'medium' | 'large';

export const MAP_SIZES: Record<MapSize, { w: number; h: number; perSector: number }> = {
  small: { w: 1300, h: 820, perSector: 3 },
  medium: { w: 1650, h: 1040, perSector: 4 },
  large: { w: 2100, h: 1320, perSector: 5 },
};

/**
 * How much of each terrain feature to place. 0 = none, 1 = standard; values
 * above 1 add more. Crystals count per sector.
 */
export interface TerrainParams {
  walls: number;
  nebula: number;
  rifts: number;
  crystals: number;
}

export type TerrainLevel = 'none' | 'light' | 'standard' | 'heavy';
export const TERRAIN_LEVELS: readonly TerrainLevel[] = ['none', 'light', 'standard', 'heavy'];

export const TERRAIN_PRESETS: Record<TerrainLevel, TerrainParams> = {
  none: { walls: 0, nebula: 0, rifts: 0, crystals: 0 },
  light: { walls: 0.6, nebula: 0.6, rifts: 0, crystals: 1 },
  standard: { walls: 1, nebula: 1, rifts: 1, crystals: 1 },
  heavy: { walls: 1.6, nebula: 1.4, rifts: 1.5, crystals: 1 },
};

/**
 * Cave layouts. 'full': the whole map is rock, with chambers around nests
 * and crystals joined by tunnels. 'belt': a ring of rock around the center,
 * crossed by the same tunnels; the rest of the map stays open.
 */
export interface CaveParams {
  mode: 'full' | 'belt';
  /** px of chamber around each nest */
  chamber: number;
  /** tunnel radius range, px */
  tunnel: [number, number];
  /** odds of each extra loop beyond the spanning tree (alternative routes) */
  loops: number;
}

export type CaveLevel = 'off' | 'belt' | 'full';
export const CAVE_LEVELS: readonly CaveLevel[] = ['off', 'belt', 'full'];

export const CAVE_PRESETS: Record<CaveLevel, CaveParams | null> = {
  off: null,
  belt: { mode: 'belt', chamber: 30, tunnel: [24, 32], loops: 0.7 },
  full: { mode: 'full', chamber: 42, tunnel: [24, 34], loops: 0.8 },
};

export function caveParams(c: MapParams['caves']): CaveParams | null {
  if (!c) return null;
  return typeof c === 'string' ? CAVE_PRESETS[c] : c;
}

/** Neutral map events (seconds). null / empty / 0 turns one off. */
export interface EventParams {
  /** wild swarms: first arrival, then every `every`; size grows with escalation */
  swarm: { first: number; every: number; size: number } | null;
  /** supply drops */
  drop: { first: number; every: number } | null;
  /** Colossus arrival times */
  colossus: number[];
  /** seconds per regrown guard on neutral nests (0 = off) */
  regrow: number;
  /** the swarms are the Bloom's (campaign): their own cue */
  bloom?: boolean;
}

export type EventLevel = 'off' | 'calm' | 'normal' | 'wild';
export const EVENT_LEVELS: readonly EventLevel[] = ['off', 'calm', 'normal', 'wild'];

export const EVENT_PRESETS: Record<EventLevel, EventParams> = {
  off: { swarm: null, drop: null, colossus: [], regrow: 0 },
  calm: { swarm: { first: 200, every: 240, size: 22 }, drop: { first: 120, every: 150 }, colossus: [], regrow: 20 },
  normal: { swarm: { first: 150, every: 150, size: 25 }, drop: { first: 105, every: 120 }, colossus: [240], regrow: 12 },
  wild: { swarm: { first: 100, every: 90, size: 40 }, drop: { first: 75, every: 80 }, colossus: [200, 420], regrow: 7 },
};

export function eventParams(e: MapParams['events']): EventParams {
  if (!e) return EVENT_PRESETS.off;
  return typeof e === 'string' ? EVENT_PRESETS[e] : e;
}

/** Where events happen, decided with the map so every start is treated alike. */
export interface EventSpec {
  params: EventParams;
  /** on the borders between sectors, at the map edge: away from every capital */
  swarmSpawns: [number, number][];
  /** open ground about equally far (walking) from every capital */
  dropSpots: [number, number][];
  /** Colossus walks: entry, the middle, then out the opposite side */
  colossusPaths: [number, number][][];
}

/** Everything that shapes a generated map. Same params + seed = same map. */
export interface MapParams {
  seed: number;
  size: MapSize;
  players: number;
  /** tall map for portrait screens, player 0 at the bottom */
  portrait?: boolean;
  terrain?: TerrainLevel | TerrainParams;
  /** cave layout preset or explicit params (default: open map) */
  caves?: CaveLevel | CaveParams;
  events?: EventLevel | EventParams;
  /** nests per player sector, including the natural expansion (default by size) */
  nestsPerSector?: number;
  /** relative odds of each nest type, indexed by NestType */
  typeWeights?: readonly number[];
  /** how nests are spread (default: picked by the seed) */
  layout?: MapLayout | 'random';
  /** this player's capital becomes a walled citadel (campaign strongholds, #100) */
  stronghold?: number;
}

export interface NestSpec {
  x: number;
  y: number;
  type: number;
  level: number;
  /** player index (into MatchSetup.players), or -1 for neutral */
  player: number;
  /** neutral: guards; player: starting army (0 = the default) */
  garrison: number;
  /** a player's nest is their capital unless this is false (hand-authored maps) */
  capital?: boolean;
}

export interface MapSpec {
  width: number;
  height: number;
  nests: NestSpec[];
  terrain: TerrainSpec;
  events: EventSpec;
  /** the layout a generated map used */
  layout?: MapLayout;
}

/** Hive, Forge, Spire, Den, Bastion */
export const DEFAULT_TYPE_WEIGHTS: readonly number[] = [20, 22, 22, 18, 14];

function pickType(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const wt of weights) total += wt;
  let r = rng.next() * total;
  for (let t = 0; t < weights.length; t++) {
    r -= weights[t];
    if (r < 0) return t;
  }
  return NestType.Hive;
}

export function terrainParams(t: MapParams['terrain']): TerrainParams {
  if (!t) return TERRAIN_PRESETS.none;
  return typeof t === 'string' ? TERRAIN_PRESETS[t] : t;
}

/**
 * How nests are spread over the map (#38). Every layout is still generated in
 * player 0's sector and rotated into the others, so starts stay symmetric.
 * - classic: a ring of nests around a strong center Hive
 * - open: no center nest (a contested crystal when the map has crystals), most nests out near the rim
 * - core: nests crowd toward the middle around a small center Hive
 * - clusters: a few tight pockets of nests with open ground between them
 * - lanes: nests strung along routes from each start to the center and the neighbors
 */
export type MapLayout = 'classic' | 'open' | 'core' | 'clusters' | 'lanes';
export const MAP_LAYOUTS: readonly MapLayout[] = ['classic', 'open', 'core', 'clusters', 'lanes'];

/** odds of each layout when the seed picks one */
const LAYOUT_ODDS: readonly number[] = [3, 2, 2, 2, 2];

interface LayoutCtx {
  sector: number;
  /** capital radius (fraction of the map ellipse) */
  capR: number;
  /** px per polar unit, roughly */
  unit: number;
}

interface LayoutSpec {
  center: 'hive2' | 'hive1' | 'crystal';
  /** 'one' natural expansion by each start, or 'pair': none or two small ones */
  naturals: 'one' | 'pair';
  /** scales the minimum spacing between nests */
  spacing: number;
  /** nests per sector beyond the size's default (tighter layouts fit more) */
  extra?: number;
  /** Set up one placement attempt; returns a sampler of candidate spots (radius, angle offset). */
  sampler: (rng: Rng, c: LayoutCtx) => () => [number, number];
}

const LAYOUTS: Record<MapLayout, LayoutSpec> = {
  classic: {
    center: 'hive2',
    naturals: 'one',
    spacing: 1,
    sampler: (rng, c) => () => [rng.range(0.28, 1.0), rng.range(-0.46, 0.46) * c.sector],
  },
  open: {
    center: 'crystal',
    naturals: 'one',
    spacing: 1.05,
    sampler: (rng, c) => () => {
      const u = rng.next();
      return [1 - 0.6 * u * u, rng.range(-0.48, 0.48) * c.sector];
    },
  },
  core: {
    center: 'hive1',
    naturals: 'one',
    spacing: 0.9,
    sampler: (rng, c) => () => {
      const u = rng.next();
      return [0.22 + 0.6 * u * u, rng.range(-0.46, 0.46) * c.sector];
    },
  },
  clusters: {
    center: 'crystal',
    naturals: 'one',
    spacing: 0.72,
    extra: 1,
    sampler: (rng, c) => {
      // One pocket on each border between neighbors, filled from both sides,
      // so every border holds a dense contested cluster; open ground elsewhere.
      const r = rng.range(0.52, 0.72), a = (rng.next() < 0.5 ? -1 : 1) * 0.5 * c.sector;
      return () => {
        const off = rng.range(0.25, 1) * 120, t = rng.range(0, TAU);
        return [r + (off * dcos(t)) / c.unit, a + (off * dsin(t)) / c.unit / r];
      };
    },
  },
  lanes: {
    center: 'hive2',
    naturals: 'pair',
    spacing: 0.85,
    extra: 1,
    sampler: (rng, c) => {
      // Polar polylines out of the capital: one to the center, one or two to the neighbors.
      const side = rng.next() < 0.5 ? -1 : 1;
      const lanes: [number, number, number, number][] = [
        [c.capR, 0, 0.16, rng.range(-0.08, 0.08) * c.sector],
        [c.capR, 0, rng.range(0.5, 0.72), side * 0.5 * c.sector],
      ];
      return () => {
        const [r1, a1, r2, a2] = lanes[rng.int(lanes.length)];
        const t = rng.range(0.3, 1);
        return [r1 + (r2 - r1) * t + rng.range(-0.02, 0.02), a1 + (a2 - a1) * t + rng.range(-0.02, 0.02) * c.sector];
      };
    },
  },
};

function pickLayout(rng: Rng): MapLayout {
  let total = 0;
  for (const o of LAYOUT_ODDS) total += o;
  let r = rng.next() * total;
  for (let i = 0; i < MAP_LAYOUTS.length; i++) {
    r -= LAYOUT_ODDS[i];
    if (r < 0) return MAP_LAYOUTS[i];
  }
  return 'classic';
}

/**
 * Rotationally symmetric map: nests and terrain are generated in player 0's
 * sector (in polar coordinates on the map's ellipse) and copied into every
 * other sector, so each start has the same options. The layout, nest count,
 * spacing and start placement vary by seed (#38).
 */
export function generateMap(p: MapParams): MapSpec {
  const rng = new Rng(p.seed ^ 0xa5a5a5);
  const dims = MAP_SIZES[p.size];
  const layout = !p.layout || p.layout === 'random' ? pickLayout(rng) : p.layout;
  const L = LAYOUTS[layout];
  const weights = p.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
  const portrait = !!p.portrait;
  const w = portrait ? dims.h : dims.w;
  const h = portrait ? dims.w : dims.h;
  const players = p.players;
  const P = Math.max(2, players);
  const cx = w / 2, cy = h / 2;
  const sector = TAU / P;

  // Per-map variety: ±1 nest per sector, looser or tighter spacing, starts a
  // little in or out and turned, and a slightly squashed or stretched ellipse.
  const roll = rng.int(3) - 1;
  let perSector = p.nestsPerSector ?? Math.max(2, dims.perSector + (L.extra ?? 0) + roll);
  // A 1v1 has only two sectors to fill: never sparser than the size's
  // default (one more each when there's no center nest), and only varies upward.
  if (!p.nestsPerSector && P === 2) perSector = Math.max(perSector, dims.perSector + (L.center === 'crystal' ? 1 : 0) + Math.max(0, roll));
  const spacing = L.spacing * rng.range(0.85, 1.2);
  const capR = rng.range(0.76, 0.9);
  const base = (portrait ? PI / 2 : PI) + rng.range(-0.15, 0.15) * sector; // player 0 starts bottom / left
  const ax = w * 0.5 * 0.88 * rng.range(0.96, 1.04), ay = h * 0.5 * 0.84 * rng.range(0.96, 1.04);
  const pos = (r: number, a: number): [number, number] => [cx + dcos(a) * r * ax, cy + dsin(a) * r * ay];
  const ctx: LayoutCtx = { sector, capR, unit: Math.min(w * 0.44, h * 0.42) };
  const minDist = (p.size === 'small' ? 100 : 110) * spacing;

  /** One placement attempt: all nests, in polar terms too. */
  const attempt = (rng: Rng) => {
    const nests: NestSpec[] = [];
    /** where each nest sits in polar terms: radius, angle from `base`, sector */
    const polar: Polar[] = [];
    for (let k = 0; k < P; k++) {
      const [x, y] = pos(capR, base + k * sector);
      nests.push({ x, y, type: NestType.Hive, level: 1, player: k < players ? k : -1, garrison: k < players ? 0 : 8 });
      polar.push({ r: capR, a: k * sector, sec: k });
    }
    if (L.center !== 'crystal') {
      const big = L.center === 'hive2';
      nests.push({ x: cx, y: cy, type: NestType.Hive, level: big ? 2 : 1, player: -1, garrison: big ? 14 + P * 2 : 8 + P });
      polar.push({ r: 0, a: 0, sec: 0 });
    }

    const fits = (r: number, da: number) => {
      if (r < 0.12 || r > 1.02) return false;
      for (let k = 0; k < P; k++) {
        const [x, y] = pos(r, base + da + k * sector);
        if (x < 60 || x > w - 60 || y < 60 || y > h - 60) return false;
        for (const n of nests) {
          if ((n.x - x) ** 2 + (n.y - y) ** 2 < minDist * minDist) return false;
        }
      }
      // Clear of the open middle, kept for its crystal.
      if (L.center === 'crystal' && (pos(r, base + da)[0] - cx) ** 2 + (pos(r, base + da)[1] - cy) ** 2 < 90 * 90) return false;
      return true;
    };
    const place = (r: number, da: number, type: number, level: number, garrison: number) => {
      for (let k = 0; k < P; k++) {
        const [x, y] = pos(r, base + da + k * sector);
        nests.push({ x, y, type, level, player: -1, garrison });
        polar.push({ r, a: da + k * sector, sec: k });
      }
    };

    // Keep the mix varied: at most one Bastion and two of any other type per
    // sector, so a seed can't produce a map that is mostly turrets.
    const typeCount = new Map<number, number>();
    const allowed = (t: number) => (typeCount.get(t) ?? 0) < (t === NestType.Bastion ? 1 : 2);

    let placed = 0;
    if (L.naturals === 'one') {
      // A cheap "natural expansion" right next to each start: Hive, Forge or Spire.
      const naturalType = rng.pick([NestType.Hive, NestType.Forge, NestType.Spire]);
      for (let tries = 0; tries < 40; tries++) {
        const da = (rng.next() < 0.5 ? -1 : 1) * rng.range(0.12, 0.28) * sector;
        const r = capR - rng.range(0.18, 0.31);
        if (fits(r, da)) {
          place(r, da, naturalType, 1, naturalType === NestType.Forge ? 6 : 4);
          typeCount.set(naturalType, 1);
          placed++;
          break;
        }
      }
    } else if (rng.next() < 0.5) {
      // Two small Hives flanking the start, or none at all.
      for (const side of [-1, 1]) {
        for (let tries = 0; tries < 30; tries++) {
          const da = side * rng.range(0.14, 0.26) * sector;
          const r = capR - rng.range(0.16, 0.28);
          if (fits(r, da)) {
            place(r, da, NestType.Hive, 1, 3);
            typeCount.set(NestType.Hive, (typeCount.get(NestType.Hive) ?? 0) + 1);
            placed++;
            break;
          }
        }
      }
    }

    const sample = L.sampler(rng, ctx);
    for (let tries = 0; tries < 400 && placed < perSector; tries++) {
      const [r, da] = sample();
      if (!fits(r, da)) continue;
      let type = pickType(rng, weights);
      for (let k = 0; k < 6 && !allowed(type); k++) type = pickType(rng, weights);
      if (!allowed(type)) type = [NestType.Forge, NestType.Spire, NestType.Swift, NestType.Hive].find(allowed) ?? NestType.Hive;
      typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
      const level = rng.next() < 0.15 ? 2 : 1;
      let g = Math.round(4 + (1 - Math.min(1, r)) * 9 + rng.int(4) + (level - 1) * 6);
      if (type === NestType.Bastion) g = Math.round(g * 0.6);
      if (type === NestType.Forge) g += 2;
      place(r, da, type, level, g);
      placed++;
    }
    return { nests, polar };
  };

  // The ellipse stretches each sector differently, so with 3+ players one
  // start can end up with nearer expansions. Try a few and keep the fairest.
  let best = attempt(rng), bestSpread = expansionSpread(best.nests, P);
  for (let k = 0; k < 6 && bestSpread > 1.08; k++) {
    const next = attempt(new Rng(rng.int(0x7fffffff)));
    const spread = expansionSpread(next.nests, P);
    if (spread < bestSpread) {
      best = next;
      bestSpread = spread;
    }
  }
  const { nests, polar } = best;

  // Terrain gets its own stream so tuning it never reshuffles the nests.
  const frame: Frame = { w, h, P, sector, base, pos, nests, polar, size: p.size, centerCrystal: L.center === 'crystal' };
  const terrain = generateTerrain(new Rng(p.seed ^ 0x7e4a1c), terrainParams(p.terrain), caveParams(p.caves), frame);
  const events = generateEvents(new Rng(p.seed ^ 0x3c9d17), eventParams(p.events), terrain, frame);
  const spec: MapSpec = { width: w, height: h, nests, terrain, events, layout };
  // A stronghold's walls go up last, on their own stream: the rest is the same map.
  if (p.stronghold !== undefined) fortify(spec, p.stronghold, p.size, new Rng(p.seed ^ 0x51f0a7));
  return spec;
}

/**
 * How unevenly the starts are served: each capital's walk (straight line) to
 * its 3 nearest neutral nests, as max over min across capitals.
 */
export function expansionSpread(nests: readonly NestSpec[], P: number): number {
  const reach: number[] = [];
  for (let k = 0; k < P; k++) {
    const c = nests[k];
    const d = nests
      .filter((n, i) => i >= P && n.player < 0)
      .map((n) => Math.sqrt((n.x - c.x) ** 2 + (n.y - c.y) ** 2))
      .sort((a, b) => a - b);
    reach.push(d.slice(0, 3).reduce((s, v) => s + v, 0));
  }
  return Math.max(...reach) / Math.max(1, Math.min(...reach));
}

function generateEvents(rng: Rng, params: EventParams, terrain: TerrainSpec, f: Frame): EventSpec {
  const spec: EventSpec = { params, swarmSpawns: [], dropSpots: [], colossusPaths: [] };
  if (!params.swarm && !params.drop && params.colossus.length === 0) return spec;
  const { w, h, P, sector, base, pos, nests } = f;
  const t = new Terrain(terrain, w, h);
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  // Swarm entries: one per sector border, pushed to the map edge.
  for (let k = 0; k < P; k++) {
    const [x, y] = pos(1.08, base + (k + 0.5) * sector);
    spec.swarmSpawns.push(t.freePoint(clamp(x, 30, w - 30), clamp(y, 30, h - 30), 20));
  }
  // The Colossus enters at one border and leaves by the one across the map.
  for (let k = 0; k < P; k++) {
    const to = spec.swarmSpawns[(k + Math.floor(P / 2)) % P];
    spec.colossusPaths.push([spec.swarmSpawns[k], t.freePoint(w / 2, h / 2, 30), to]);
  }

  // Drop spots: open ground, scored by how evenly far it is from every start.
  const capitals = nests.slice(0, P);
  const cand: { x: number; y: number; spread: number }[] = [];
  for (let tries = 0; tries < 80 && cand.length < 24; tries++) {
    const x = rng.range(w * 0.12, w * 0.88), y = rng.range(h * 0.12, h * 0.88);
    if (t.clearance(x, y) < 34) continue;
    if (terrain.fields.some((c) => c.kind === 'rift' && capsuleDist(c, x, y) < 40)) continue;
    if (nests.some((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < (NEST_RADIUS[n.type] + 70) ** 2)) continue;
    if (terrain.crystals.some((c) => (c.x - x) ** 2 + (c.y - y) ** 2 < (c.r + 60) ** 2)) continue;
    const d = capitals.map((n) => t.pathDist(n.x, n.y, x, y, 0));
    const spread = (Math.max(...d) - Math.min(...d)) / Math.max(1, Math.min(...d));
    if (Number.isFinite(spread)) cand.push({ x, y, spread });
  }
  cand.sort((a, b) => a.spread - b.spread);
  for (const c of cand.slice(0, 6)) spec.dropSpots.push([c.x, c.y]);
  if (spec.dropSpots.length === 0) spec.dropSpots.push(t.freePoint(w / 2, h / 2, 30));
  return spec;
}

interface Frame {
  w: number;
  h: number;
  P: number;
  sector: number;
  base: number;
  pos: (r: number, a: number) => [number, number];
  nests: NestSpec[];
  polar: Polar[];
  size: MapSize;
  /** no center nest: the middle is open, with a crystal when the map has any */
  centerCrystal: boolean;
}

interface Polar {
  r: number;
  a: number;
  sec: number;
}

/** A feature in player 0's sector: capsules in polar (r, angle offset) coordinates. */
interface PolarCapsule {
  r1: number;
  a1: number;
  r2: number;
  a2: number;
  rad: number;
}

function generateTerrain(rng: Rng, tp: TerrainParams, cp: CaveParams | null, f: Frame): TerrainSpec {
  const spec = emptyTerrain();
  if (tp.walls <= 0 && tp.nebula <= 0 && tp.rifts <= 0 && tp.crystals <= 0 && !cp) return spec;
  const { w, h, P, sector, base, pos, nests } = f;
  const scale = f.size === 'small' ? 0.9 : f.size === 'large' ? 1.15 : 1;

  /** Copy a sector-local feature into every sector. */
  const rotate = (pc: PolarCapsule): Capsule[] => {
    const out: Capsule[] = [];
    for (let k = 0; k < P; k++) {
      const [x1, y1] = pos(pc.r1, base + pc.a1 + k * sector);
      const [x2, y2] = pos(pc.r2, base + pc.a2 + k * sector);
      out.push({ x1, y1, x2, y2, r: pc.rad });
    }
    return out;
  };
  const inMap = (c: Capsule, pad: number) =>
    Math.min(c.x1, c.x2) - c.r > -pad && Math.max(c.x1, c.x2) + c.r < w + pad &&
    Math.min(c.y1, c.y2) - c.r > -pad && Math.max(c.y1, c.y2) + c.r < h + pad;
  /** Clearance from every nest edge. */
  const clearOfNests = (c: Capsule, gap: number) =>
    nests.every((n) => capsuleDist(c, n.x, n.y) > NEST_RADIUS[n.type] + gap);
  const capitals = nests.slice(0, P);
  const clearOfCrystals = (c: Capsule, gap: number) => spec.crystals.every((o) => capsuleDist(c, o.x, o.y) > o.r + gap);
  const points = nests.map((n): [number, number] => [n.x, n.y]);

  // ---- crystals -------------------------------------------------------
  // The first sits on the border between neighbors, so it's contested; more
  // go deeper into each sector.
  const crystals = Math.round(tp.crystals);
  const crystalPolar: { r: number; a: number }[] = [];
  // Open-center layouts put one more in the middle, shared by everyone.
  if (f.centerCrystal && crystals > 0) spec.crystals.push({ x: w / 2, y: h / 2, r: 34 * scale });
  for (let k = 0, tries = 0; k < crystals && tries < 40; tries++) {
    const a = k === 0 ? (0.5 + rng.range(-0.06, 0.06)) * sector : rng.range(-0.35, 0.35) * sector;
    const r = rng.range(0.42, 0.66);
    const R = 30 * scale;
    const spots = rotate({ r1: r, a1: a, r2: r, a2: a, rad: R });
    const ok = spots.every(
      (c) =>
        inMap(c, -20) &&
        nests.every((n) => (n.x - c.x1) ** 2 + (n.y - c.y1) ** 2 > (R + NEST_RADIUS[n.type] + 50) ** 2) &&
        spec.crystals.every((o) => (o.x - c.x1) ** 2 + (o.y - c.y1) ** 2 > (R * 4) ** 2),
    );
    if (!ok) continue;
    for (const c of spots) spec.crystals.push({ x: c.x1, y: c.y1, r: R });
    crystalPolar.push({ r, a });
    k++;
  }

  // ---- caves ------------------------------------------------------------
  // Carved before the walls, so wall checks see the rock.
  if (cp) spec.cave = fairestCave(rng, cp, f, crystalPolar, spec.crystals[0]?.r ?? 0, scale);
  const caveT = spec.cave ? new Terrain(spec, w, h) : null;
  /** open cave ground at least `gap` from rock (always true on open maps) */
  const inOpen = (x: number, y: number, gap: number) => !caveT || caveT.rockDist(x, y) > gap;
  // ---- walls ----------------------------------------------------------
  // Each candidate feature is added to all sectors at once, then kept only if
  // every nest is still reachable from every other.
  const tryWalls = (parts: PolarCapsule[], gap: number): boolean => {
    const caps = parts.flatMap(rotate);
    if (!caps.every((c) => inMap(c, 30) && clearOfNests(c, gap) && clearOfCrystals(c, 16))) return false;
    const next = [...spec.walls, ...caps];
    if (!new Terrain({ walls: next, fields: [], crystals: [], cave: spec.cave }, w, h).connected(points)) return false;
    spec.walls = next;
    return true;
  };
  const arc = (r: number, a0: number, a1: number, rad: number, segs: number): PolarCapsule[] => {
    const out: PolarCapsule[] = [];
    for (let s = 0; s < segs; s++) {
      out.push({ r1: r, a1: a0 + ((a1 - a0) * s) / segs, r2: r, a2: a0 + ((a1 - a0) * (s + 1)) / segs, rad });
    }
    return out;
  };

  // Full caves are all walls already: only scattered outcrops go on top.
  const fullCave = cp?.mode === 'full';
  if (tp.walls > 0 && !fullCave) {
    // Center bulwark: an arc in each sector around the middle nest, with gaps
    // between sectors that become the chokepoints into the center.
    if (rng.next() < 0.55 + 0.35 * tp.walls) {
      for (let tries = 0; tries < 8; tries++) {
        const r = rng.range(0.26, 0.36);
        const span = rng.range(0.42, 0.62) * sector;
        const off = rng.range(-0.12, 0.12) * sector;
        if (tryWalls(arc(r, off - span / 2, off + span / 2, rng.range(14, 20) * scale, 3), 34)) break;
      }
    }
    // Ridges between neighboring sectors: flanks and lanes.
    const ridges = Math.round(tp.walls * rng.range(1, 2));
    for (let k = 0, tries = 0; k < ridges && tries < 30; tries++) {
      const a = (0.5 + rng.range(-0.1, 0.1)) * sector;
      const r1 = rng.range(0.45, 0.62);
      const r2 = r1 + rng.range(0.2, 0.36);
      const bend = rng.range(-0.08, 0.08) * sector;
      if (tryWalls([{ r1, a1: a, r2, a2: a + bend, rad: rng.range(16, 24) * scale }], 40)) k++;
    }
  }
  if (tp.walls > 0) {
    // Outcrops: scattered rocks, some elongated. In caves, fewer: cover inside chambers.
    const rocks = Math.round(tp.walls * rng.range(2.5, 4.5) * (fullCave ? 0.4 : 1));
    for (let k = 0, tries = 0; k < rocks && tries < 60; tries++) {
      const r = rng.range(0.3, 0.95);
      const a = rng.range(-0.5, 0.5) * sector;
      const long = rng.next() < 0.5;
      const len = long ? rng.range(0.05, 0.12) : 0;
      const da = long ? rng.range(-0.15, 0.15) * sector : 0;
      if (tryWalls([{ r1: r, a1: a, r2: r + len, a2: a + da, rad: rng.range(16, 32) * scale }], 34)) k++;
    }
  }

  // ---- fields ---------------------------------------------------------
  const addField = (parts: PolarCapsule[], kind: FieldSpec['kind'], check: (c: Capsule) => boolean): boolean => {
    const caps = parts.flatMap(rotate);
    if (!caps.every((c) => inMap(c, 0) && check(c))) return false;
    // In caves, fields sit in open ground: rifts well inside, so none walls off a tunnel.
    const gap = kind === 'rift' ? 30 : 0;
    if (!caps.every((c) => inOpen(c.x1, c.y1, gap) && inOpen(c.x2, c.y2, gap))) return false;
    for (const c of caps) spec.fields.push({ ...c, kind });
    return true;
  };

  // Nebula: soft clouds that slow everything inside. Not on anyone's capital.
  const clouds = Math.round(tp.nebula * rng.range(0.8, 1.6));
  for (let k = 0, tries = 0; k < clouds && tries < 40; tries++) {
    const r = rng.range(0.3, 0.8);
    const a = rng.range(-0.5, 0.5) * sector;
    const rad = rng.range(36, 60) * scale;
    const puffs: PolarCapsule[] = [{ r1: r, a1: a, r2: r, a2: a, rad }];
    const extra = 1 + rng.int(2);
    for (let e = 0; e < extra; e++) {
      const r2 = r + rng.range(-0.08, 0.08), a2 = a + rng.range(-0.1, 0.1) * sector;
      puffs.push({ r1: r2, a1: a2, r2, a2, rad: rad * rng.range(0.6, 0.9) });
    }
    const ok = addField(puffs, 'nebula', (c) => capitals.every((n) => capsuleDist(c, n.x, n.y) > 90) && clearOfCrystals(c, -10));
    if (ok) k++;
  }

  // Rifts: narrow damaging strips across tempting shortcuts. Never on a nest.
  const rifts = Math.round(tp.rifts * rng.range(0.6, 1.3));
  for (let k = 0, tries = 0; k < rifts && tries < 40; tries++) {
    const r = rng.range(0.32, 0.75);
    const a = rng.range(-0.45, 0.45) * sector;
    const len = rng.range(0.1, 0.2);
    const da = rng.range(-0.25, 0.25) * sector;
    const ok = addField([{ r1: r, a1: a, r2: r + len, a2: a + da, rad: rng.range(9, 13) * scale }], 'rift', (c) =>
      nests.every((n) => capsuleDist(c, n.x, n.y) > NEST_RADIUS[n.type] + 40) && clearOfCrystals(c, 10),
    );
    if (ok) k++;
  }

  return spec;
}

/**
 * Rotating a layout around an ellipse stretches it differently in each
 * sector, so a tunnel that runs straight for one start can wind for another.
 * Try a few layouts and keep the one where every start's walk to the center
 * is the most alike (as a detour over the straight line).
 */
function fairestCave(rng: Rng, cp: CaveParams, f: Frame, crystals: { r: number; a: number }[], crystalR: number, scale: number): CaveSpec {
  const { w, h, P, nests } = f;
  const center = { x: w / 2, y: h / 2 };
  let best: CaveSpec | null = null, bestSpread = Infinity;
  for (let attempt = 0; attempt < 16 && bestSpread > 1.05; attempt++) {
    const cave = generateCaves(new Rng(rng.int(0x7fffffff)), cp, f, crystals, crystalR, scale);
    const t = new Terrain({ walls: [], fields: [], crystals: [], cave }, w, h);
    const detours = nests.slice(0, P).map((n) => t.pathDist(n.x, n.y, center.x, center.y, 0) / Math.sqrt((n.x - center.x) ** 2 + (n.y - center.y) ** 2));
    const spread = Math.max(...detours) / Math.min(...detours);
    if (spread < bestSpread) {
      bestSpread = spread;
      best = cave;
    }
  }
  return best!;
}

/**
 * Carve a cave system in player 0's sector and rotate it into the others:
 * a chamber around every nest and crystal, a spanning tree of tunnels between
 * them, one tunnel across the sector border, and a few extra loops so there's
 * more than one way in. Everything is a carved capsule, so the open space is
 * connected by construction.
 */
function generateCaves(rng: Rng, cp: CaveParams, f: Frame, crystals: { r: number; a: number }[], crystalR: number, scale: number): CaveSpec {
  const { w, h, P, sector, base, pos, nests, polar } = f;
  // Polar units are fractions of the map ellipse; this converts px to them (roughly).
  const unit = Math.min(w * 0.44, h * 0.42);
  const carves: Capsule[] = [];
  const rotate = (r1: number, a1: number, r2: number, a2: number, rad: number) => {
    for (let k = 0; k < P; k++) {
      const [x1, y1] = pos(r1, base + a1 + k * sector);
      const [x2, y2] = pos(r2, base + a2 + k * sector);
      carves.push({ x1, y1, x2, y2, r: rad });
    }
  };

  // Sector 0's chambers. The center nest (r = 0) is shared by every sector.
  type Node = { r: number; a: number; R: number };
  const nodes: Node[] = [];
  polar.forEach((p, i) => {
    if (p.sec !== 0) return;
    const n = nests[i];
    const boost = p.r === 0 ? 1.5 : n.player >= 0 ? 1.4 : 1;
    nodes.push({ r: p.r, a: p.a, R: NEST_RADIUS[n.type] + cp.chamber * boost * scale });
  });
  for (const c of crystals) nodes.push({ r: c.r, a: c.a, R: crystalR + 34 * scale });
  // No center nest: still carve a chamber there (around its crystal, if any), so the sectors meet.
  if (f.centerCrystal) nodes.push({ r: 0, a: 0, R: 34 * scale + 40 * scale });

  for (const n of nodes) {
    rotate(n.r, n.a, n.r, n.a, n.R);
    // A few lumpy side pockets so chambers aren't perfect circles.
    const lumps = 2 + rng.int(2);
    for (let k = 0; k < lumps; k++) {
      const off = (n.R * rng.range(0.35, 0.65)) / unit;
      const dr = rng.range(-1, 1) * off;
      const da = n.r > 0.05 ? (rng.range(-1, 1) * off) / n.r : 0;
      rotate(n.r + dr, n.a + da, n.r + dr, n.a + da, n.R * rng.range(0.5, 0.75));
    }
  }

  // Candidate tunnels: every pair inside the sector, and every pair across
  // the border into the next sector (angle + sector).
  const xy = (r: number, a: number) => pos(r, base + a);
  type Edge = { i: number; j: number; cross: boolean; len: number };
  const edges: Edge[] = [];
  const dist = (r1: number, a1: number, r2: number, a2: number) => {
    const [x1, y1] = xy(r1, a1), [x2, y2] = xy(r2, a2);
    // sqrt, not hypot: hypot isn't guaranteed identical across browsers.
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      edges.push({ i, j, cross: false, len: dist(nodes[i].r, nodes[i].a, nodes[j].r, nodes[j].a) });
    }
    for (let j = 0; j < nodes.length; j++) {
      if (nodes[i].r === 0 || nodes[j].r === 0) continue;
      edges.push({ i, j, cross: true, len: dist(nodes[i].r, nodes[i].a, nodes[j].r, nodes[j].a + sector) });
    }
  }
  edges.sort((a, b) => a.len - b.len || a.i - b.i || a.j - b.j);

  // Spanning tree (Kruskal) inside the sector; the center joins the sectors.
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const chosen: Edge[] = [];
  for (const e of edges) {
    if (e.cross) continue;
    const a = find(e.i), b = find(e.j);
    if (a === b) continue;
    parent[a] = b;
    chosen.push(e);
  }
  const longest = Math.max(...chosen.map((e) => e.len));
  // Neighbors always share a border tunnel: the shortest one.
  const border = edges.find((e) => e.cross);
  if (border) chosen.push(border);
  // Loops: a few more short tunnels, for flanks and second routes.
  const maxLoops = 1 + Math.round(cp.loops * 3);
  for (let k = 0, e = 0; e < edges.length && k < maxLoops; e++) {
    const c = edges[e];
    if (chosen.includes(c) || c.len > longest * 1.5) continue;
    if (rng.next() < cp.loops) {
      chosen.push(c);
      k++;
    }
  }

  const tunnel = (r1: number, a1: number, r2: number, a2: number) => {
    // A tunnel into the center comes straight in from its other end.
    if (r1 === 0) a1 = a2;
    if (r2 === 0) a2 = a1;
    const segs = Math.max(2, Math.round(dist(r1, a1, r2, a2) / 70));
    let pr = r1, pa = a1;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      let r = r1 + (r2 - r1) * t, a = a1 + (a2 - a1) * t;
      if (s < segs) {
        // Wander a little so tunnels bend.
        r += (rng.range(-1, 1) * 22) / unit;
        if (r > 0.05) a += (rng.range(-1, 1) * 22) / unit / r;
      }
      rotate(pr, pa, r, a, rng.range(cp.tunnel[0], cp.tunnel[1]) * scale);
      pr = r;
      pa = a;
    }
  };
  for (const e of chosen) {
    const A = nodes[e.i], B = nodes[e.j];
    tunnel(A.r, A.a, B.r, B.a + (e.cross ? sector : 0));
  }

  let zone: Capsule[] | null = null;
  if (cp.mode === 'full') {
    // The deep: a tunnel in from the map edge on each border, where wild swarms enter.
    const ea = 0.5 * sector;
    let best = 0, bd = Infinity;
    nodes.forEach((n, i) => {
      if (n.r === 0) return;
      for (const a of [n.a, n.a + sector]) {
        const d = dist(1.12, ea, n.r, a);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    });
    const n = nodes[best];
    const na = Math.abs(n.a - ea) < Math.abs(n.a + sector - ea) ? n.a : n.a + sector;
    tunnel(1.12, ea, n.r, na);
  } else {
    // Belt: a thick ring of rock around the center, built from arcs.
    zone = [];
    const r = 0.5, rad = 0.26 * unit, segs = 4;
    for (let s = 0; s < segs; s++) {
      for (let k = 0; k < P; k++) {
        const [x1, y1] = pos(r, base + (s / segs) * sector + k * sector);
        const [x2, y2] = pos(r, base + ((s + 1) / segs) * sector + k * sector);
        zone.push({ x1, y1, x2, y2, r: rad });
      }
    }
  }
  return { carves, zone };
}
