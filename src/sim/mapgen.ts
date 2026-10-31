import { fortify, type FortressInfo } from './fortify';
import { NEST_RADIUS, NestType, TERRAIN } from './constants';
import { PI, TAU, dcos, dsin, fbm, ridged } from './mathx';
import { Rng } from './rng';
import { TILE, Terrain, capsuleDist, emptyTerrain, type Capsule, type CaveSpec, type FieldSpec, type TerrainSpec } from './terrain';

export type MapSize = 'small' | 'medium' | 'large';

/** Each size's reference map (its area, at 1.6:1) and nests per sector; the seed picks the actual shape (#98). */
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
  /** 'noise' and 'ca' (#98): rock masses from a noise field or a cellular automaton, with the same chambers and tunnels cut through */
  mode: 'full' | 'belt' | 'noise' | 'ca';
  /** px of chamber around each nest */
  chamber: number;
  /** tunnel radius range, px */
  tunnel: [number, number];
  /** odds of each extra loop beyond the spanning tree (alternative routes) */
  loops: number;
  /** which chambers join (#98): a spanning tree (default), one hub, a single chain, or a tree with many loops */
  topology?: CaveTopology;
  /** wide tunnels' radius range, px; `choke` is the odds a tunnel is the narrow `tunnel` instead */
  wide?: [number, number];
  choke?: number;
  /** 'noise' mode: which noise, where it turns to rock, how big its features are, how much it's warped */
  field?: { kind: 'fbm' | 'ridged'; threshold: number; scale: number; warp: number };
}

export type CaveTopology = 'tree' | 'hub' | 'chain' | 'ring';

/** A 'noise' cave's field when none is given. */
const NOISE_FIELD: NonNullable<CaveParams['field']> = { kind: 'fbm', threshold: 0.63, scale: 4, warp: 0.3 };

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
  /** this player's capital is walled in: a warlord's stronghold (#100), or you, holding the line (#67) */
  fortress?: number;
  /** the map's large-scale form (default: picked by the seed, to suit its terrain and caves) */
  form?: MapForm | 'random';
  /** what fills an open form (default: picked by the seed); cave forms ignore it, and noise replaces a cave belt */
  fill?: MapFill | 'random';
}

/**
 * A map's large-scale form (#98), on top of its layout:
 * - open maps: `classic` (scattered terrain), `ring` (a solid void in the
 *   middle), `river` (bands along the sector borders, crossed at fords),
 *   `spiral` (nests along a curving arm, walls between the arms);
 * - full caves: `caves` (as #15), `regions` (big chambers, each tunnel a wide
 *   opening or a choke, joined as a hub, ring, chain or tree), `islands`
 *   (small chambers on long narrow bridges), `warrens` (organic caverns grown
 *   by a cellular automaton).
 */
export type MapForm = 'classic' | 'ring' | 'river' | 'spiral' | 'caves' | 'regions' | 'islands' | 'warrens';
export const MAP_FORMS: readonly MapForm[] = ['classic', 'ring', 'river', 'spiral', 'caves', 'regions', 'islands', 'warrens'];
const CAVE_FORMS: readonly MapForm[] = ['caves', 'regions', 'islands', 'warrens'];

/** What fills an open form between its nests (#98): scattered rocks, or rock masses from a warped noise field. */
export type MapFill = 'sprinkle' | 'noise';

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
  /** a generated map's width over height (always ≥ 1: the camera turns it to fit the screen) */
  aspect?: number;
  /** a generated map's density, 0 (sparse: few nests, far apart, big) to 1 (packed) */
  density?: number;
  /** a generated map's large-scale form, and its caves' topology if any */
  form?: MapForm;
  topology?: CaveTopology;
  fill?: MapFill;
  /** a walled-in player's fortress, as it came out (#100, #67) */
  fortress?: FortressInfo;
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

/**
 * The shapes a map can take (width over height), by player count: long maps
 * only for a 1v1, where both halves stay alike; with more players, extreme
 * shapes would stretch some sectors far more than others.
 */
const ASPECTS: Record<number, readonly number[]> = {
  2: [1, 1.3, 1.6, 2],
  3: [1, 1.3, 1.6],
  4: [1, 1.3, 1.6],
  5: [1, 1.3],
  6: [1, 1.3],
};

/** odds of each layout when the seed picks one */
const LAYOUT_ODDS: readonly number[] = [3, 2, 2, 2, 2];

interface LayoutCtx {
  sector: number;
  /** capital radius (fraction of the map ellipse) */
  capR: number;
  /** px per polar unit, roughly */
  unit: number;
  /** a river runs along the sector borders: keep pockets off them */
  river: boolean;
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
      const r = rng.range(0.52, 0.72), a = (rng.next() < 0.5 ? -1 : 1) * (c.river ? 0.3 : 0.5) * c.sector;
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

/** A form that suits the map's caves and terrain, weighted. */
function pickForm(rng: Rng, cp: CaveParams | null, tp: TerrainParams): MapForm {
  const odds: [MapForm, number][] =
    cp?.mode === 'full'
      ? [['caves', 2], ['regions', 3], ['islands', 2], ['warrens', 2]]
      : cp?.mode === 'belt'
        ? [['classic', 3], ['spiral', 2]]
        : [
            ['classic', 3],
            ['ring', tp.walls > 0 || tp.rifts > 0 || tp.nebula > 0 ? 2 : 0],
            ['river', tp.walls > 0 || tp.rifts > 0 ? 3 : 0],
            ['spiral', 2],
          ];
  let total = 0;
  for (const [, o] of odds) total += o;
  let r = rng.next() * total;
  for (const [f, o] of odds) {
    r -= o;
    if (r < 0) return f;
  }
  return odds[0][0];
}

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
  const players = p.players;
  const P = Math.max(2, players);
  const sector = TAU / P;

  // The map's shape and density come from the seed alone, never the screen
  // (#98): every player sees the same map, and the camera turns it to fit.
  // On its own stream, so the nest draws don't shift with it.
  const shape = new Rng(p.seed ^ 0x5a9e01);
  const aspect = shape.pick(ASPECTS[Math.min(P, 6)]);
  const density = shape.next();
  // Sparse maps spread the same nests over more ground: long crossings.
  const area = dims.w * dims.h * (1.35 - 0.5 * density) * shape.range(0.95, 1.05);
  const w = Math.round(Math.sqrt(area * aspect)), h = Math.round(area / Math.sqrt(area * aspect));
  // The form suits the terrain: cave forms need full caves, ring and river need something to build with.
  const tp = terrainParams(p.terrain);
  let cp = caveParams(p.caves);
  const form = p.form && p.form !== 'random' ? p.form : pickForm(shape, cp, tp);
  if (CAVE_FORMS.includes(form)) {
    const full = cp?.mode === 'full' ? cp : CAVE_PRESETS.full!;
    const topology: CaveTopology = form === 'regions' ? shape.pick(['tree', 'hub', 'ring', 'chain'] as const) : form === 'islands' ? shape.pick(['chain', 'tree'] as const) : 'tree';
    if (form === 'regions') cp = { ...full, chamber: full.chamber * 1.9, tunnel: [22, 28], wide: [46, 62], choke: 0.5, loops: 0.6, topology };
    else if (form === 'islands') cp = { ...full, chamber: full.chamber * 0.85, tunnel: [22, 26], loops: 0.3, topology };
    else if (form === 'warrens') cp = { mode: 'ca', chamber: full.chamber * 0.9, tunnel: [24, 30], loops: 0.6 };
    else cp = full;
  }
  // Open forms on a walled map: scattered rocks, or (about a third) rock masses from warped noise.
  // Asked for, a fill applies to any open form (noise rock replaces a cave belt).
  const fill: MapFill | undefined = CAVE_FORMS.includes(form)
    ? undefined
    : p.fill && p.fill !== 'random'
      ? p.fill
      : cp
        ? undefined
        : tp.walls > 0 && shape.next() < 0.35
          ? 'noise'
          : 'sprinkle';
  if (fill === 'noise') {
    const kind = shape.next() < 0.6 ? 'fbm' : 'ridged';
    cp = { mode: 'noise', chamber: 36, tunnel: [26, 34], loops: 0.7, field: { kind, threshold: kind === 'fbm' ? shape.range(0.6, 0.66) : shape.range(0.84, 0.9), scale: shape.range(3, 5), warp: shape.range(0, 0.6) } };
  }
  const ring = form === 'ring', spiral = form === 'spiral';
  const cx = w / 2, cy = h / 2;

  // Per-map variety: nests per sector and spacing follow the density (dense:
  // more nests, packed; sparse: fewer, far apart), starts a little in or out
  // and turned, and a slightly squashed or stretched ellipse.
  const roll = Math.max(-1, Math.min(2, Math.round(-1 + 3 * density + rng.range(-0.5, 0.5))));
  let perSector = p.nestsPerSector ?? Math.max(2, dims.perSector + (L.extra ?? 0) + roll);
  // A 1v1 has only two sectors to fill: never sparser than the size's
  // default (one more each when there's no center nest), and only varies upward.
  if (!p.nestsPerSector && P === 2) perSector = Math.max(perSector, dims.perSector + (L.center === 'crystal' ? 1 : 0) + Math.max(0, roll));
  const spacing = L.spacing * (1.35 - 0.6 * density) * rng.range(0.92, 1.08);
  const capR = rng.range(0.76, 0.9);
  // Spiral: each sector's nests follow one arm, curling `twist` (radians) from the middle out.
  const arm = spiral ? { dir: rng.next() < 0.5 ? -1 : 1, twist: rng.range(0.55, 0.9) * sector } : null;
  const base = PI + rng.range(-0.15, 0.15) * sector; // player 0 starts on the left
  const ax = w * 0.5 * 0.88 * rng.range(0.96, 1.04), ay = h * 0.5 * 0.84 * rng.range(0.96, 1.04);
  const pos = (r: number, a: number): [number, number] => [cx + dcos(a) * r * ax, cy + dsin(a) * r * ay];
  const ctx: LayoutCtx = { sector, capR, unit: Math.min(w * 0.44, h * 0.42), river: form === 'river' };
  const minDist = (p.size === 'small' ? 100 : 110) * spacing;
  // Gulfs: on some maps, empty ground in every sector that nests stay out of
  // (a packed core with an empty rim, or pockets with gulfs between).
  const gulfs: [number, number, number][] = [];
  if (rng.next() < 0.35) {
    const n = 1 + rng.int(2);
    for (let tries = 0; tries < 20 && gulfs.length < n; tries++) {
      const r = rng.range(0.35, 0.85), da = rng.range(-0.45, 0.45) * sector, R = rng.range(90, 160) * (p.size === 'large' ? 1.15 : 1);
      const [gx, gy] = pos(r, base + da), [kx, ky] = pos(capR, base);
      // Never over the start, the middle, or its natural expansion.
      if ((gx - kx) ** 2 + (gy - ky) ** 2 < (R + 140) ** 2 || (gx - cx) ** 2 + (gy - cy) ** 2 < (R + 60) ** 2) continue;
      gulfs.push([gx, gy, R]);
    }
  }
  const inGulf = (x: number, y: number) => gulfs.some(([gx, gy, R]) => (gx - x) ** 2 + (gy - y) ** 2 < R * R);

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
    if (L.center !== 'crystal' && !ring) {
      const big = L.center === 'hive2';
      nests.push({ x: cx, y: cy, type: NestType.Hive, level: big ? 2 : 1, player: -1, garrison: big ? 14 + P * 2 : 8 + P });
      polar.push({ r: 0, a: 0, sec: 0 });
    }

    /** `tight` < 1 lets a crowded sector squeeze its last nests in. */
    const fits = (r: number, da: number, tight = 1) => {
      // A ring keeps its middle clear for the void.
      if (r < (ring ? 0.42 : 0.12) || r > 1.02) return false;
      // A river keeps its banks clear: nests stay off the sector borders.
      if (form === 'river' && 0.5 * sector - Math.abs(da) < 75 / (r * ctx.unit)) return false;
      const md = minDist * tight;
      for (let k = 0; k < P; k++) {
        const [x, y] = pos(r, base + da + k * sector);
        if (x < 60 || x > w - 60 || y < 60 || y > h - 60) return false;
        for (const n of nests) {
          if ((n.x - x) ** 2 + (n.y - y) ** 2 < md * md) return false;
        }
      }
      // Clear of the open middle, kept for its crystal.
      if (L.center === 'crystal' && !ring && (pos(r, base + da)[0] - cx) ** 2 + (pos(r, base + da)[1] - cy) ** 2 < 90 * 90) return false;
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

    const sample = arm
      ? () => {
          // Along the arm, a little either side of it.
          const t = rng.next();
          return [0.24 + 0.76 * t + rng.range(-0.04, 0.04), arm.dir * arm.twist * (0.5 - t) + rng.range(-0.06, 0.06) * sector] as [number, number];
        }
      : L.sampler(rng, ctx);
    for (let tries = 0; tries < 400 && placed < perSector; tries++) {
      const [r, da] = sample();
      // Late tries ignore the gulfs and squeeze closer, so a crowded sector still fills.
      if (!fits(r, da, tries < 300 ? 1 : 0.8) || (tries < 300 && inGulf(...pos(r, base + da)))) continue;
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
  const frame: Frame = { w, h, P, sector, base, pos, nests, polar, size: p.size, centerCrystal: L.center === 'crystal' && !ring, form, arm, unit: ctx.unit };
  const terrain = generateTerrain(new Rng(p.seed ^ 0x7e4a1c), tp, cp, frame);
  const events = generateEvents(new Rng(p.seed ^ 0x3c9d17), eventParams(p.events), terrain, frame);
  const spec: MapSpec = { width: w, height: h, nests, terrain, events, layout, aspect: w / h, density, form, topology: cp?.topology, fill };
  // A fortress goes up last, on its own stream: the rest is the same map.
  // Every wild-swarm spawn must reach it too (Hold the line's waves come from them).
  if (p.fortress !== undefined) spec.fortress = fortify(spec, p.fortress, p.size, new Rng(p.seed ^ 0x51f0a7), events.swarmSpawns) ?? undefined;
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

  // A free point that can walk to the first capital: rock (#98) can wall off
  // a pocket, so step in toward the middle until the ground connects, and
  // failing that toward the capital itself (which always does).
  const cap0 = nests[0];
  const reachable = (x: number, y: number, clear: number): [number, number] => {
    for (const [tx, ty] of [[w / 2, h / 2], [cap0.x, cap0.y]]) {
      for (let k = 0; k <= 12; k++) {
        const p = t.freePoint(x + ((tx - x) * k) / 12, y + ((ty - y) * k) / 12, clear);
        if (Number.isFinite(t.pathDist(p[0], p[1], cap0.x, cap0.y, 0))) return p;
        if (tx === x && ty === y) break;
      }
    }
    return t.freePoint(cap0.x, cap0.y, clear);
  };
  // Swarm entries: one per sector border, pushed to the map edge.
  for (let k = 0; k < P; k++) {
    const [x, y] = pos(1.08, base + (k + 0.5) * sector);
    spec.swarmSpawns.push(reachable(clamp(x, 30, w - 30), clamp(y, 30, h - 30), 20));
  }
  // The Colossus enters at one border and leaves by the one across the map.
  const mid = reachable(w / 2, h / 2, 30);
  for (let k = 0; k < P; k++) {
    const to = spec.swarmSpawns[(k + Math.floor(P / 2)) % P];
    spec.colossusPaths.push([spec.swarmSpawns[k], mid, to]);
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
  if (spec.dropSpots.length === 0) spec.dropSpots.push(mid);
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
  form: MapForm;
  /** spiral form: the arm the nests follow */
  arm: { dir: number; twist: number } | null;
  /** px per polar unit, roughly */
  unit: number;
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
  const tryWalls = (parts: PolarCapsule[], gap: number, pad = 30): boolean => {
    const caps = parts.flatMap(rotate);
    if (!caps.every((c) => inMap(c, pad) && clearOfNests(c, gap) && clearOfCrystals(c, 16))) return false;
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

  // ---- forms (#98) ----------------------------------------------------
  // Placed before the scattered terrain, which then has to keep them connected.
  // Rock if the map has walls, else the strongest field it has.
  const material = (): 'wall' | 'rift' | 'nebula' | null => (tp.walls > 0 ? 'wall' : tp.rifts > 0 ? 'rift' : tp.nebula > 0 ? 'nebula' : null);
  /** Put down one form piece in every sector: walls must keep the map connected; fields just keep off the nests. */
  const formPiece = (parts: PolarCapsule[], kind: 'wall' | 'rift' | 'nebula', gap: number): boolean => {
    if (kind === 'wall') return tryWalls(parts, gap, 200);
    const caps = parts.flatMap(rotate);
    if (!caps.every((c) => clearOfNests(c, gap) && clearOfCrystals(c, 10))) return false;
    for (const c of caps) spec.fields.push({ ...c, kind });
    return true;
  };
  if (f.form === 'ring') {
    // A solid void in the middle that everyone has to go round.
    const kind = material();
    if (kind) {
      // One disc at the center (shared, so it's placed once), plus lobes so it isn't perfectly round.
      const R = rng.range(0.24, 0.3);
      const rad = R * f.unit * (kind === 'nebula' ? 1.3 : 1);
      const c: Capsule = { x1: w / 2, y1: h / 2, x2: w / 2, y2: h / 2, r: rad };
      if (kind === 'wall') {
        const next = [...spec.walls, c];
        if (clearOfNests(c, 30) && new Terrain({ walls: next, fields: [], crystals: [], cave: spec.cave }, w, h).connected(points)) spec.walls = next;
      } else if (clearOfNests(c, 30)) spec.fields.push({ ...c, kind });
      formPiece([{ r1: R * 0.6, a1: rng.range(-0.3, 0.3) * sector, r2: R * 0.6, a2: rng.range(-0.3, 0.3) * sector, rad: rad * 0.55 }], kind, 30);
    }
  } else if (f.form === 'river') {
    // Bands along every sector border, from near the middle out past the
    // edge, crossed at 2-3 fords: rock, or a rift you can wade through.
    const kind = tp.walls > 0 && (tp.rifts <= 0 || rng.next() < 0.5) ? 'wall' : 'rift';
    const segs = 8, r0 = 0.2, r1 = 1.14;
    const fords = new Set<number>();
    const nf = 2 + rng.int(2);
    while (fords.size < nf) fords.add(1 + rng.int(segs - 1));
    const wob = () => (0.5 + rng.range(-0.04, 0.04)) * sector;
    let pa = wob();
    for (let k = 0; k < segs; k++) {
      const a = wob();
      const ra = r0 + ((r1 - r0) * k) / segs, rb = r0 + ((r1 - r0) * (k + 1)) / segs;
      if (!fords.has(k)) formPiece([{ r1: ra, a1: pa, r2: rb, a2: a, rad: (kind === 'wall' ? 24 : 15) * scale }], kind, 24);
      pa = a;
    }
  } else if (f.form === 'spiral' && tp.walls > 0 && f.arm) {
    // Walls between the arms: the arm's curve, half a sector over, with gaps.
    const { dir, twist } = f.arm;
    const segs = 6;
    const curve = (t: number): [number, number] => [0.3 + 0.66 * t, dir * twist * (0.5 - (0.3 + 0.66 * t - 0.24) / 0.76) + 0.5 * sector];
    for (let k = 0; k < segs; k++) {
      if (rng.next() < 0.3) continue;
      const [ra, aa] = curve(k / segs), [rb, ab] = curve((k + 0.8) / segs);
      formPiece([{ r1: ra, a1: aa, r2: rb, a2: ab, rad: rng.range(15, 20) * scale }], 'wall', 34);
    }
  }

  // Full caves are all walls already: only scattered outcrops go on top.
  const fullCave = cp?.mode === 'full' || cp?.mode === 'ca';
  // Forms bring their own structure: no bulwark or border ridges to blur it.
  if (tp.walls > 0 && !fullCave && f.form === 'classic') {
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
    const rocks = Math.round(tp.walls * rng.range(2.5, 4.5) * (fullCave ? 0.4 : cp?.mode === 'noise' ? 0.3 : f.form !== 'classic' ? 0.6 : 1));
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
  // Noise and warrens rock is grown once; the attempts only re-cut the tunnels.
  const grid = cp.mode === 'noise' || cp.mode === 'ca' ? fieldGrid(new Rng(rng.int(0x7fffffff)), cp, f) : null;
  const field = grid && cp.mode === 'noise' ? fieldCaps(grid, f, (k) => grid.rock[k] === 1) : null;
  let best: CaveSpec | null = null, bestSpread = Infinity;
  for (let attempt = 0; attempt < 16 && bestSpread > 1.05; attempt++) {
    const cave = generateCaves(new Rng(rng.int(0x7fffffff)), cp, f, crystals, crystalR, scale, field, cp.mode === 'ca' ? grid : null);
    const t = new Terrain({ walls: [], fields: [], crystals: [], cave }, w, h);
    const detours = nests.slice(0, P).map((n) => t.pathDist(n.x, n.y, center.x, center.y, 0) / Math.sqrt((n.x - center.x) ** 2 + (n.y - center.y) ** 2));
    const spread = Math.max(...detours) / Math.min(...detours);
    if (spread < bestSpread) {
      bestSpread = spread;
      best = cave;
    }
  }
  if (grid) {
    // The grid only roughly knows where rock pieces leave room to walk: fill
    // whatever open ground the first start can't actually reach.
    const lost = new Terrain({ walls: [], fields: [], crystals: [], cave: best! }, w, h).cutOff(nests[0].x, nests[0].y);
    if (lost.length) best = { ...best!, fill: lost.map(([x1, x2, y]) => ({ x1, y1: y, x2, y2: y, r: TILE - TERRAIN.wallMargin - 1 })) };
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
function generateCaves(rng: Rng, cp: CaveParams, f: Frame, crystals: { r: number; a: number }[], crystalR: number, scale: number, field: Capsule[] | null = null, caverns: FieldGrid | null = null): CaveSpec {
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

  // Join the sector's chambers (#98): a spanning tree (Kruskal), a chain (the
  // same, but no chamber with more than two tunnels), or a hub (one chamber,
  // the one nearest all the others, tunnels to every other). Ring is a tree
  // with many loops. The center joins the sectors.
  const topology = cp.topology ?? 'tree';
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const degree = nodes.map(() => 0);
  const chosen: Edge[] = [];
  const inner = edges.filter((e) => !e.cross);
  if (topology === 'hub') {
    let hub = 0, hd = Infinity;
    nodes.forEach((_, i) => {
      const d = inner.filter((e) => e.i === i || e.j === i).reduce((t, e) => t + e.len, 0);
      if (d < hd) {
        hd = d;
        hub = i;
      }
    });
    for (const e of inner) if (e.i === hub || e.j === hub) chosen.push(e);
  } else {
    for (const e of inner) {
      const a = find(e.i), b = find(e.j);
      if (a === b || (topology === 'chain' && (degree[e.i] >= 2 || degree[e.j] >= 2))) continue;
      parent[a] = b;
      degree[e.i]++;
      degree[e.j]++;
      chosen.push(e);
    }
    // A chain can strand a chamber whose neighbors are full: join it anyway.
    if (topology === 'chain') {
      for (const e of inner) {
        const a = find(e.i), b = find(e.j);
        if (a === b) continue;
        parent[a] = b;
        chosen.push(e);
      }
    }
  }
  const longest = Math.max(...chosen.map((e) => e.len));
  // Neighbors always share a border tunnel: the shortest one.
  const border = edges.find((e) => e.cross);
  if (border) chosen.push(border);
  // Loops: a few more short tunnels, for flanks and second routes (a ring: many; a chain or hub: none).
  const maxLoops = topology === 'ring' ? 4 + nodes.length : topology === 'tree' ? 1 + Math.round(cp.loops * 3) : 0;
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
    // Regions: each tunnel is a wide opening or a narrow choke.
    const [lo, hi] = cp.wide && rng.next() >= (cp.choke ?? 0) ? cp.wide : cp.tunnel;
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
      rotate(pr, pa, r, a, rng.range(lo, hi) * scale);
      pr = r;
      pa = a;
    }
  };
  for (const e of chosen) {
    const A = nodes[e.i], B = nodes[e.j];
    tunnel(A.r, A.a, B.r, B.a + (e.cross ? sector : 0));
  }

  let zone: Capsule[] | null = null;
  if (cp.mode === 'full' || caverns) {
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
  }
  if (caverns) {
    // Warrens: solid rock like the caves, with the grown caverns carved out
    // wherever they open onto a chamber or tunnel (the rest stay rock).
    const seeds: number[] = [];
    for (let i = 0; i < caverns.rows; i++) {
      for (let j = 0; j < caverns.cols; j++) {
        const [x, y] = pos(caverns.rAt(i), base + caverns.aAt(j));
        if (carves.some((c) => capsuleDist(c, x, y) < c.r)) seeds.push(i * caverns.cols + j);
      }
    }
    const open = floodOpen(caverns, seeds);
    // Just over half a cell's diagonal: open cells join up with no specks
    // left where four meet, and the rock between caverns stays.
    carves.push(...fieldCaps(caverns, f, (k) => open[k] === 1, 0.72));
  } else if (field) {
    zone = field;
  } else if (cp.mode !== 'full') {
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

/** A polar grid of rock and open cells over player 0's sector (#98); its angle wraps round into the next sector. */
interface FieldGrid {
  rows: number;
  cols: number;
  /** 1 = rock */
  rock: Uint8Array;
  /** the polar radius of row i */
  rAt: (i: number) => number;
  /** the polar angle of column j, from the sector's middle */
  aAt: (j: number) => number;
}

/**
 * The cell grid for the 'noise' and 'ca' cave modes (#98): a polar grid over
 * player 0's sector whose angle wraps round (the next sector is the same grid
 * turned), so every sector gets the same rock and the borders join up
 * without a seam. 'noise' thresholds warped fBm or ridged noise, sampled
 * round a circle so it wraps too; 'ca' grows caverns with a cellular automaton.
 */
function fieldGrid(rng: Rng, cp: CaveParams, f: Frame): FieldGrid {
  const { sector, pos, w, h } = f;
  const r0 = 0.12, r1 = cp.mode === 'ca' ? 1.22 : 1.1;
  // Size the grid by the ellipse's long axis, so no cell is wider than
  // FIELD_CELL anywhere: the capsules have a fixed radius, and stretched
  // cells would leave seams between them on wide maps.
  const [ex, ey] = pos(1, 0), [fx, fy] = pos(1, PI / 2);
  const uMax = Math.max(Math.abs(ex - w / 2), Math.abs(fy - h / 2), Math.abs(ey - h / 2), Math.abs(fx - w / 2));
  const rows = Math.ceil(((r1 - r0) * uMax) / FIELD_CELL);
  const cols = Math.max(8, Math.round((sector * uMax) / FIELD_CELL));
  const rock = new Uint8Array(rows * cols);
  const rAt = (i: number) => r0 + ((i + 0.5) * (r1 - r0)) / rows;
  const aAt = (j: number) => ((j + 0.5) / cols - 0.5) * sector;
  if (cp.mode === 'noise') {
    const { kind, threshold, scale, warp } = cp.field ?? NOISE_FIELD;
    const seed = rng.int(0x7fffffff);
    /** Warped noise at polar (r, a), on a true circle so features come out round. */
    const at = (r: number, a: number) => {
      let x = r * dcos(a) * scale, y = r * dsin(a) * scale;
      if (warp > 0) {
        const wx = fbm(x + 5.2, y + 1.3, seed + 7, 3), wy = fbm(x + 1.7, y + 9.2, seed + 11, 3);
        x += (wx - 0.5) * warp * 4;
        y += (wy - 0.5) * warp * 4;
      }
      return kind === 'fbm' ? fbm(x, y, seed) : ridged(x, y, seed);
    };
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        // Near a border, blend in the noise from the far side of the sector:
        // at the border both sides read the same mix, so there's no seam.
        const a = aAt(j), r = rAt(i);
        const e = Math.min(1, Math.max(0, (Math.abs(a) / sector - 0.3) / 0.2));
        const wt = 0.5 * e * e * (3 - 2 * e);
        const v = wt > 0 ? (1 - wt) * at(r, a) + wt * at(r, a - Math.sign(a) * sector) : at(r, a);
        rock[i * cols + j] = v > threshold ? 1 : 0;
      }
    }
    // Fill enclosed pockets: open ground walled off from both the middle and
    // the rim would be unreachable (tunnels are only cut between chambers).
    // A first pass on the grid; fairestCave checks the real ground after.
    const seeds: number[] = [];
    for (let j = 0; j < cols; j++) for (const i of [0, rows - 1]) if (!rock[i * cols + j]) seeds.push(i * cols + j);
    const seen = floodOpen({ rows, cols, rock, rAt, aAt }, seeds);
    for (let k = 0; k < rock.length; k++) if (!rock[k] && !seen[k]) rock[k] = 1;
  } else {
    // Caverns: random fill, then a few rounds of "rock if most neighbors are".
    for (let k = 0; k < rock.length; k++) rock[k] = rng.next() < 0.47 ? 1 : 0;
    const next = new Uint8Array(rock.length);
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          let n = 0;
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              if (!di && !dj) continue;
              const ii = i + di;
              // Off the outside counts as rock; the middle as open.
              if (ii >= rows) n++;
              else if (ii >= 0) n += rock[ii * cols + ((j + dj + cols) % cols)];
            }
          }
          const k = i * cols + j;
          next[k] = n >= 5 || (rock[k] && n >= 4) ? 1 : 0;
        }
      }
      rock.set(next);
    }
  }
  return { rows, cols, rock, rAt, aAt };
}

const FIELD_CELL = 22;

/** The open cells 4-connected to any of `seeds` (cell indices), wrapping round the angle. */
function floodOpen(g: FieldGrid, seeds: number[]): Uint8Array {
  const { rows, cols, rock } = g;
  const seen = new Uint8Array(rock.length);
  const stack: number[] = [];
  for (const k of seeds) {
    if (rock[k] || seen[k]) continue;
    seen[k] = 1;
    stack.push(k);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const i = Math.floor(k / cols), j = k % cols;
    for (const [ii, jj] of [[i + 1, j], [i - 1, j], [i, (j + 1) % cols], [i, (j + cols - 1) % cols]]) {
      if (ii < 0 || ii >= rows) continue;
      const n = ii * cols + jj;
      if (rock[n] || seen[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

/** Runs of up to 3 picked cells along each ring, as capsules (radius `rad`, in cells) in every sector. */
function fieldCaps(g: FieldGrid, f: Frame, pick: (k: number) => boolean, rad = 0.78): Capsule[] {
  const { rows, cols, rAt, aAt } = g;
  const { P, pos, base, sector } = f;
  const out: Capsule[] = [];
  for (let i = 0; i < rows; i++) {
    const r = rAt(i);
    for (let j = 0; j < cols; ) {
      if (!pick(i * cols + j)) {
        j++;
        continue;
      }
      let e = j;
      while (e + 1 < cols && e - j < 2 && pick(i * cols + e + 1)) e++;
      for (let k = 0; k < P; k++) {
        const [x1, y1] = pos(r, base + aAt(j) + k * sector);
        const [x2, y2] = pos(r, base + aAt(e) + k * sector);
        out.push({ x1, y1, x2, y2, r: rad * FIELD_CELL });
      }
      j = e + 1;
    }
  }
  return out;
}
