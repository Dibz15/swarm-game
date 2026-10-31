import { fortify, type FortressInfo } from './fortify';
import { NEST_RADIUS, NestType, TERRAIN } from './constants';
import { PI, TAU, datan2, dcos, dsin, fbm, ridged } from './mathx';
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
            ['islands', tp.rifts > 0 ? 2 : 0],
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
  // Islands are a cave form on a caves map; elsewhere they sit in a rift sea.
  const sea = form === 'islands' && cp?.mode !== 'full';
  if (sea) cp = null;
  else if (CAVE_FORMS.includes(form)) {
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
  /** pos's inverse: polar radius and angle from `base`, in [-PI, PI) */
  const polarOf = (x: number, y: number): [number, number] => {
    const u = (x - cx) / ax, v = (y - cy) / ay;
    let a = datan2(v, u) - base;
    a -= TAU * Math.floor((a + PI) / TAU);
    return [Math.sqrt(u * u + v * v), a];
  };
  const ctx: LayoutCtx = { sector, capR, unit: Math.min(w * 0.44, h * 0.42), river: form === 'river' };
  const minDist = (p.size === 'small' ? 100 : 110) * spacing;
  const islands = form === 'islands';
  // Warrens: grow the caverns first, so nests can spread through them out to the edges.
  const caverns = cp?.mode === 'ca' ? fieldGrid(new Rng(p.seed ^ 0x2c4a77), cp, { sector, pos, w, h }) : null;
  const hollows: number[] = [];
  if (caverns) {
    // Cells well inside a cavern: open, with most of their neighbors open too.
    const { rows, cols, rock } = caverns;
    for (let i = 1; i < rows - 1; i++) {
      for (let j = 0; j < cols; j++) {
        if (rock[i * cols + j]) continue;
        let n = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) n += rock[(i + di) * cols + ((j + dj + cols) % cols)] ? 0 : 1;
        if (n >= 8) hollows.push(i * cols + j);
      }
    }
  }
  // Gulfs: on some maps, empty ground in every sector that nests stay out of
  // (a packed core with an empty rim, or pockets with gulfs between).
  const gulfs: [number, number, number][] = [];
  if (rng.next() < 0.35 && !islands && !caverns) {
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

    // Islands: the home island round the start, one in the middle if there's
    // a center nest, and more spread through the sector with sea between.
    const isl: Island[] | null = islands ? [{ r: capR, a: 0, R: rng.range(0.22, 0.27) }] : null;
    if (isl) {
      if (L.center !== 'crystal' && !ring) isl.push({ r: 0, a: 0, R: rng.range(0.18, 0.24) });
      const want = isl.length + Math.max(1, Math.min(4, Math.round((perSector - 1) / 2)));
      const gap = (70 * (p.size === 'large' ? 1.15 : 1)) / ctx.unit;
      for (let tries = 0; tries < 80 && isl.length < want; tries++) {
        const R = rng.range(0.19, 0.26), r = rng.range(0.32, 1.0), a = rng.range(-0.42, 0.42) * sector;
        // Clear of the others (and of its own copies next door), with sea between.
        if (isl.some((o) => islandDist(o, r, a, sector) < o.R + R + gap)) continue;
        if (r * Math.min(1, sector) < R + gap / 2) continue;
        isl.push({ r, a, R });
      }
    }

    /** `tight` < 1 lets a crowded sector squeeze its last nests in. */
    const fits = (r: number, da: number, tight = 1) => {
      // A ring keeps its middle clear for the void; warrens reach out into the caverns.
      if (r < (ring ? 0.42 : 0.12) || r > (caverns ? 1.16 : 1.02)) return false;
      // A river keeps its banks clear: nests stay off the sector borders.
      if (form === 'river' && 0.5 * sector - Math.abs(da) < 75 / (r * ctx.unit)) return false;
      // Islands pack their nests close, but never closer than 70 px.
      const md = isl ? Math.max(70, minDist * tight * 0.72) : minDist * tight;
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
    if (isl || caverns) {
      // Islands and warrens place every nest with their own sampler below.
    } else if (L.naturals === 'one') {
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

    const sample = isl
      ? () => {
          // Anywhere on one of the islands.
          const o = isl[rng.int(isl.length)];
          const rr = Math.sqrt(rng.next()) * o.R * 0.8, t = rng.range(-PI, PI);
          if (o.r === 0) return [Math.max(0.13, rr), rng.range(-0.5, 0.5) * sector] as [number, number];
          return [o.r + rr * dcos(t), o.a + (rr * dsin(t)) / Math.max(o.r, 0.25)] as [number, number];
        }
      : caverns && hollows.length
      ? () => {
          // Deep in a cavern, weighted by area (outer cells are bigger).
          for (;;) {
            const k = hollows[rng.int(hollows.length)];
            const r = caverns.rAt(Math.floor(k / caverns.cols));
            if (rng.next() * 1.2 < r) return [r, caverns.aAt(k % caverns.cols)] as [number, number];
          }
        }
      : arm
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
    return { nests, polar, isl };
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
  const { nests, polar, isl } = best;

  // Terrain gets its own stream so tuning it never reshuffles the nests.
  const frame: Frame = { w, h, P, sector, base, pos, polarOf, nests, polar, size: p.size, centerCrystal: L.center === 'crystal' && !ring, form, arm, unit: ctx.unit, islands: isl, caverns, density };
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
  polarOf: (x: number, y: number) => [number, number];
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
  /** islands form: sector 0's islands (the home one first), in polar terms; R is their radius */
  islands: Island[] | null;
  /** warrens: the cavern grid the nests were placed in */
  caverns: FieldGrid | null;
  /** 0 = sparse, 1 = dense */
  density: number;
}

interface Island {
  r: number;
  a: number;
  R: number;
}

/** Polar distance from (r, a) to an island, matching how nests are scattered round it (angles within one sector of it). */
function islandDist(i: Island, r: number, a: number, sector: number): number {
  if (i.r === 0) return r;
  let best = Infinity;
  for (const k of [-1, 0, 1]) {
    const da = (a - i.a - k * sector) * Math.max(i.r, 0.25);
    best = Math.min(best, Math.sqrt((r - i.r) ** 2 + da * da));
  }
  return best;
}

interface Polar {
  r: number;
  a: number;
  sec: number;
}

/** A crystal in player 0's sector, in polar terms, and where each start's copy actually went (`at[k]`, sector k). */
interface CrystalPlace {
  r: number;
  a: number;
  at: [number, number][];
}

/** A feature in player 0's sector: capsules in polar (r, angle offset) coordinates. */
interface PolarCapsule {
  r1: number;
  a1: number;
  r2: number;
  a2: number;
  rad: number;
}

/**
 * How high the ground is at a point of a noise or warrens map (0 low to 1
 * high; -1 in rock or off the grid), for tests and dev tools (#114). Kept
 * beside the spec, not in it, so it never goes out with a match.
 */
export const groundHeight = new WeakMap<TerrainSpec, (x: number, y: number) => number>();

function generateTerrain(rng: Rng, tp: TerrainParams, cp: CaveParams | null, f: Frame): TerrainSpec {
  const spec = emptyTerrain();
  if (tp.walls <= 0 && tp.nebula <= 0 && tp.rifts <= 0 && tp.crystals <= 0 && !cp) return spec;
  const { w, h, P, sector, base, pos, polarOf, nests } = f;
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
  /** A px capsule in sector 0 (or just over its border), in polar terms for `rotate`. */
  const polarCap = (c: Capsule): PolarCapsule => {
    const [r1, a1] = polarOf(c.x1, c.y1);
    let [r2, a2] = polarOf(c.x2, c.y2);
    if (a2 - a1 > PI) a2 -= TAU;
    else if (a1 - a2 > PI) a2 += TAU;
    return { r1, a1, r2, a2, rad: c.r };
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
  const material = (): 'wall' | 'rift' | 'nebula' | null => (tp.walls > 0 ? 'wall' : tp.rifts > 0 ? 'rift' : tp.nebula > 0 ? 'nebula' : null);
  const R = 30 * scale;

  // ---- form plans (#114) ---------------------------------------------
  // Drawn first: the crystals and fields go where the form's pieces leave room.
  /** ring: the void in the middle, and the polar radius just outside it */
  const ring = f.form === 'ring' ? (() => {
    const kind = material();
    const V = rng.range(0.24, 0.3);
    const rad = V * f.unit * (kind === 'nebula' ? 1.3 : 1);
    return { kind, V, rad, rim: (kind ? rad : 0.3 * f.unit) / f.unit + (R + 34) / f.unit };
  })() : null;
  /** river: bands along every sector border from near the middle out past the edge, crossed at fords */
  const river = f.form === 'river' ? (() => {
    const kind: 'wall' | 'rift' = tp.walls > 0 && (tp.rifts <= 0 || rng.next() < 0.5) ? 'wall' : 'rift';
    const segs = 8, r0 = 0.2, r1 = 1.14;
    const fords = new Set<number>();
    const nf = 2 + rng.int(2);
    while (fords.size < nf) fords.add(1 + rng.int(segs - 1));
    // Rock runs fairly straight; a rift meanders.
    const amp = kind === 'wall' ? 0.04 : 0.07;
    const angs = Array.from({ length: segs + 1 }, () => (0.5 + rng.range(-amp, amp)) * sector);
    const at = (k: number) => ({ r: r0 + ((r1 - r0) * (k + 0.5)) / segs, a: (angs[k] + angs[k + 1]) / 2 });
    // The fords by how central they are: the first gets a crystal, the next a rift pool.
    const ford = [...fords].sort((p, q) => Math.abs(at(p).r - 0.55) - Math.abs(at(q).r - 0.55) || p - q).map(at);
    return { kind, segs, r0, r1, fords, angs, ford };
  })() : null;
  /** spiral: the line between two arms, where its walls go */
  const spiralGap = f.arm ? (t: number): [number, number] => [0.3 + 0.66 * t, f.arm!.dir * f.arm!.twist * (0.5 - (0.3 + 0.66 * t - 0.24) / 0.76) + 0.5 * sector] : null;
  // Noise and warrens maps know their ground: valleys and ridges.
  const grid = cp?.mode === 'ca' ? f.caverns : cp?.mode === 'noise' ? fieldGrid(new Rng(rng.int(0x7fffffff)), cp, f) : null;
  /** how high the ground is at polar (r, a): -1 off the grid or in rock */
  const height = (r: number, a: number) => {
    const k = grid?.height ? grid.cellAt(r, a) : -1;
    return k < 0 || grid!.rock[k] ? -1 : grid!.height![k];
  };
  if (grid?.height) groundHeight.set(spec, (x, y) => height(...polarOf(x, y)));

  // ---- crystals (#114) -------------------------------------------------
  // Objectives: a contested one between neighbors (on the border, a ford, the
  // void's rim, the spiral's inner tip, a far chamber or island) and, on dense
  // maps, a safe one near home. Sparse maps have one, worth more.
  const crystalPolar: CrystalPlace[] = [];
  /**
   * `walk` is how far a start is from a spot, `open` whether a crystal fits
   * there. Caves carve round the crystals, and the rift sea leaves them dry,
   * so those maps place them first, by straight lines; open maps place them
   * once the walls are up, by real walks.
   */
  const placeCrystals = (walk: (x: number, y: number, n: NestSpec) => number, open: (x: number, y: number) => boolean) => {
    const want = Math.round(tp.crystals * (f.density > 0.6 || f.form === 'spiral' ? 2 : 1));
    // Open-center layouts put one more in the middle, shared by everyone.
    if (f.centerCrystal) spec.crystals.push({ x: w / 2, y: h / 2, r: 34 * scale });
    const own = nests.map((_, i) => i).filter((i) => f.polar[i].sec === 0 && nests[i].player < 0 && f.polar[i].r > 0);
    /** a spot beside a nest, in its chamber */
    const besideNest = (i: number): [number, number] => {
      const t = rng.range(-PI, PI), d = NEST_RADIUS[nests[i].type] + R + rng.range(52, 76);
      return polarOf(nests[i].x + dcos(t) * d, nests[i].y + dsin(t) * d);
    };
    const cap = nests[0];
    /** On an island's ground (any sector's copy of it) */
    const onIsland = (x: number, y: number) => {
      const [r, a] = polarOf(x, y);
      const sa = a - sector * Math.round(a / sector);
      return f.islands!.some((o) => islandDist(o, r, sa, sector) < o.R * 0.85);
    };
    const toMid = datan2(h / 2 - cap.y, w / 2 - cap.x);
    const chambers = cp?.mode === 'full' && f.form !== 'islands';
    const samplers: Record<'contested' | 'safe', () => [number, number]> = {
      contested: () => {
        if (river) {
          const o = river.ford[0];
          return [o.r + rng.range(-0.03, 0.03), o.a - (R + 30 + rng.range(0, 14)) / (o.r * f.unit)];
        }
        if (ring) return [ring.rim + rng.range(0, 0.05), (0.5 + rng.range(-0.08, 0.08)) * sector];
        if (f.arm) return [0.3 + rng.range(-0.03, 0.05), f.arm.dir * f.arm.twist * 0.42 + rng.range(-0.05, 0.05) * sector];
        if (f.islands && f.islands.length > 1) {
          // The island farthest from home.
          const far = f.islands.slice(1).filter((o) => o.r > 0).sort((p, q) => islandDist(f.islands![0], q.r, q.a, sector) - islandDist(f.islands![0], p.r, p.a, sector))[0];
          if (far) return [far.r + rng.range(-0.4, 0.4) * far.R, far.a + (rng.range(-0.4, 0.4) * far.R) / far.r];
        }
        if (chambers && own.length) {
          // A chamber near the border.
          const near = [...own].sort((p, q) => Math.abs(f.polar[q].a) - Math.abs(f.polar[p].a) || p - q);
          return besideNest(near[rng.int(Math.min(2, near.length))]);
        }
        return [rng.range(0.42, 0.66), (0.5 + rng.range(-0.06, 0.06)) * sector];
      },
      safe: () => {
        if (f.arm) return [0.92 + rng.range(-0.04, 0.02), -f.arm.dir * f.arm.twist * 0.4 + rng.range(-0.05, 0.05) * sector];
        if (f.islands && f.islands.length > 1) {
          const near = f.islands.slice(1).filter((o) => o.r > 0).sort((p, q) => islandDist(f.islands![0], p.r, p.a, sector) - islandDist(f.islands![0], q.r, q.a, sector))[0];
          if (near) return [near.r + rng.range(-0.4, 0.4) * near.R, near.a + (rng.range(-0.4, 0.4) * near.R) / near.r];
        }
        if (chambers && own.length) {
          const near = [...own].sort((p, q) => (nests[p].x - cap.x) ** 2 + (nests[p].y - cap.y) ** 2 - ((nests[q].x - cap.x) ** 2 + (nests[q].y - cap.y) ** 2) || p - q);
          return besideNest(near[rng.int(Math.min(2, near.length))]);
        }
        // Inward from the capital, a short walk away.
        const t = toMid + rng.range(-1.1, 1.1), d = rng.range(115, 175) * scale;
        return polarOf(cap.x + dcos(t) * d, cap.y + dsin(t) * d);
      },
    };
    /** Every copy clear of the nests, the map edge and the other crystals, and each start's nearest about as far off. */
    /** The copies of a crystal at (r, a), and how unevenly the starts then reach their nearest: null if they don't fit. */
    const fits = (r: number, a: number, gap: number, loose = false): { spots: Capsule[]; spread: number } | null => {
      const room = (x: number, y: number) =>
        x > R - 20 && x < w - R + 20 && y > R - 20 && y < h - R + 20 &&
        open(x, y) &&
        (!ring?.kind || (x - w / 2) ** 2 + (y - h / 2) ** 2 > (ring.rad + R + 24) ** 2) &&
        (loose || !f.islands || onIsland(x, y)) &&
        nests.every((n) => (n.x - x) ** 2 + (n.y - y) ** 2 > (R + NEST_RADIUS[n.type] + gap) ** 2) &&
        spec.crystals.every((o) => (o.x - x) ** 2 + (o.y - y) ** 2 > (R * 4) ** 2);
      const spots = rotate({ r1: r, a1: a, r2: r, a2: a, rad: R });
      if (!spots.every((c) => room(c.x1, c.y1))) return null;
      // The ellipse stretches each sector its own way: put every other copy
      // as far from its two nearest starts as sector 0's is from its own two,
      // where those two circles cross (nearest the turned copy).
      if (P > 2) {
        const c0 = spots[0];
        const d0 = capitals.map((n, i) => ({ i, d: Math.sqrt((n.x - c0.x1) ** 2 + (n.y - c0.y1) ** 2) })).sort((p, q) => p.d - q.d || p.i - q.i);
        const [u, v] = d0;
        for (let k = 1; k < P; k++) {
          const A = capitals[(u.i + k) % P], B = capitals[(v.i + k) % P], c = spots[k];
          const dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy);
          if (d > u.d + v.d || d < Math.abs(u.d - v.d) || d < 1) continue;
          const t = (u.d * u.d - v.d * v.d + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, u.d * u.d - t * t));
          const mx = A.x + (dx * t) / d, my = A.y + (dy * t) / d;
          let best: [number, number] | null = null, bd = 200 * 200;
          for (const sgn of [-1, 1]) {
            const x = mx - (sgn * dy * hh) / d, y = my + (sgn * dx * hh) / d;
            const e = (x - c.x1) ** 2 + (y - c.y1) ** 2;
            if (e < bd && room(x, y)) [best, bd] = [[x, y], e];
          }
          if (best) [c.x1, c.y1, c.x2, c.y2] = [best[0], best[1], best[0], best[1]];
        }
      }
      const all = [...spec.crystals.map((o) => [o.x, o.y]), ...spots.map((c) => [c.x1, c.y1])];
      const d = capitals.map((n) => Math.min(...all.map(([x, y]) => walk(x, y, n))));
      return { spots, spread: Math.max(...d) / Math.min(...d) };
    };
    const roles: ('contested' | 'safe')[] = Array.from({ length: want }, (_, k) => (k === 1 ? 'safe' : 'contested'));
    // Islands share their ground, and a river's banks are narrow: there a crystal may sit closer to the nests.
    const gap = f.islands || river ? 24 : 50;
    for (const role of roles) {
      // A few spots that fit: of the fair ones, the highest ground (on noise
      // and warrens maps, ridges and pocket mouths); failing that the fairest.
      // If the role finds no room, anywhere on the border.
      type Spot = { r: number; a: number; spots: Capsule[]; spread: number; score: number };
      const found: Spot[] = [];
      for (let t = 0; t < 60 && found.length < 10; t++) {
        const plain = t >= 40;
        const [r, a] = plain ? [rng.range(0.42, 0.66), (0.5 + rng.range(-0.06, 0.06)) * sector] : samplers[role]();
        const fit = fits(r, a, plain ? 50 : gap, plain);
        if (fit) found.push({ r, a, ...fit, score: height(r, a) });
      }
      // None fair: look wider through the sector, and on a crowded map closer to the nests.
      for (let t = 0; t < 80 && !found.some((o) => o.spread <= 1.12); t++) {
        const r = rng.range(0.35, 0.8), a = rng.range(-0.5, 0.5) * sector;
        // (Off the islands too, as a last resort: the sea leaves a crystal dry ground.)
        const fit = fits(r, a, t < 40 ? gap : Math.min(gap, 25), t >= 40);
        if (fit) found.push({ r, a, ...fit, score: height(r, a) });
      }
      const fair = found.filter((o) => o.spread <= 1.12);
      const best = fair.length ? fair.reduce((p, q) => (q.score > p.score ? q : p)) : found.length ? found.reduce((p, q) => (q.spread < p.spread ? q : p)) : null;
      if (!best) continue;
      for (const c of best.spots) spec.crystals.push({ x: c.x1, y: c.y1, r: R });
      crystalPolar.push({ r: best.r, a: best.a, at: best.spots.map((c) => [c.x1, c.y1]) });
    }
    // Two a sector share the yield; one alone on a sparse map is worth more.
    const value = crystalPolar.length >= 2 ? 0.75 : f.density < 0.35 ? 1.5 : 1;
    if (value !== 1) for (const c of spec.crystals) if (c.x !== w / 2 || c.y !== h / 2) c.value = value;
  };
  const early = !!cp || f.form === 'islands';
  if (tp.crystals > 0 && early) placeCrystals((x, y, n) => Math.sqrt((x - n.x) ** 2 + (y - n.y) ** 2), () => true);

  // ---- caves ------------------------------------------------------------
  // Carved before the walls, so wall checks see the rock.
  if (cp) spec.cave = fairestCave(rng, cp, f, crystalPolar, spec.crystals[0]?.r ?? 0, scale, grid);
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
  /** Put down one form piece in every sector: walls must keep the map connected; fields just keep off the nests. */
  const formPiece = (parts: PolarCapsule[], kind: 'wall' | 'rift' | 'nebula', gap: number): boolean => {
    if (kind === 'wall') return tryWalls(parts, gap, 200);
    const caps = parts.flatMap(rotate);
    if (!caps.every((c) => clearOfNests(c, gap) && clearOfCrystals(c, 10))) return false;
    for (const c of caps) spec.fields.push({ ...c, kind });
    return true;
  };
  if (ring?.kind) {
    // A solid void in the middle that everyone has to go round.
    const { kind, V, rad } = ring;
    // One disc at the center (shared, so it's placed once), plus lobes so it isn't perfectly round.
    const c: Capsule = { x1: w / 2, y1: h / 2, x2: w / 2, y2: h / 2, r: rad };
    if (kind === 'wall') {
      const next = [...spec.walls, c];
      if (clearOfNests(c, 30) && new Terrain({ walls: next, fields: [], crystals: [], cave: spec.cave }, w, h).connected(points)) spec.walls = next;
    } else if (clearOfNests(c, 30)) spec.fields.push({ ...c, kind });
    formPiece([{ r1: V * 0.6, a1: rng.range(-0.3, 0.3) * sector, r2: V * 0.6, a2: rng.range(-0.3, 0.3) * sector, rad: rad * 0.55 }], kind, 30);
  } else if (river) {
    // Crossed at 2-3 fords: rock, or a meandering rift you can wade through
    // that pools at some of its bends.
    const { kind, segs, r0, r1, fords, angs } = river;
    for (let k = 0; k < segs; k++) {
      const ra = r0 + ((r1 - r0) * k) / segs, rb = r0 + ((r1 - r0) * (k + 1)) / segs;
      if (fords.has(k)) continue;
      formPiece([{ r1: ra, a1: angs[k], r2: rb, a2: angs[k + 1], rad: (kind === 'wall' ? 24 : rng.range(13, 18)) * scale }], kind, 24);
      if (kind === 'rift' && !fords.has(k + 1) && k + 1 < segs && rng.next() < 0.4) formPiece([{ r1: rb, a1: angs[k + 1], r2: rb, a2: angs[k + 1], rad: rng.range(22, 28) * scale }], 'rift', 24);
    }
  } else if (f.form === 'islands' && f.islands && !cp) {
    seaOfRift(spec, f, scale);
  } else if (spiralGap && tp.walls > 0) {
    // Walls between the arms, with gaps.
    const segs = 6;
    for (let k = 0; k < segs; k++) {
      if (rng.next() < 0.3) continue;
      const [ra, aa] = spiralGap(k / segs), [rb, ab] = spiralGap((k + 0.8) / segs);
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

  const ground = new Terrain({ walls: spec.walls, fields: [], crystals: [], cave: spec.cave }, w, h);
  if (tp.crystals > 0 && !early) {
    placeCrystals(
      (x, y, n) => ground.pathDist(x, y, n.x, n.y, 0),
      (x, y) => ground.clearance(x, y) > R + 16 && spec.fields.every((o) => o.kind !== 'rift' || capsuleDist(o, x, y) > o.r + R + 10),
    );
  }

  // ---- routes (#114) --------------------------------------------------
  // The walking lines from each of sector 0's nests to its two nearest, minus
  // the ends by the nests: where a field makes a choice, go round or through.
  const routes: number[][] = [];
  nests.forEach((a, i) => {
    if (f.polar[i].sec !== 0) return;
    const near = nests.map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 })).filter((o) => o.j !== i).sort((p, q) => p.d - q.d || p.j - q.j);
    for (const { j } of near.slice(0, 2)) {
      // Walked from the far end, so one flow field (toward `a`) serves both.
      const b = nests[j];
      const tr = ground.trace(b.x, b.y, a.x, a.y, 0);
      const ka = NEST_RADIUS[a.type] + 50, kb = NEST_RADIUS[b.type] + 50;
      const mid: number[] = [];
      for (let k = 0; k < tr.length; k += 2) {
        const x = tr[k], y = tr[k + 1];
        if ((x - a.x) ** 2 + (y - a.y) ** 2 > ka * ka && (x - b.x) ** 2 + (y - b.y) ** 2 > kb * kb) mid.push(x, y);
      }
      if (mid.length >= 8) routes.push(mid);
    }
  });
  /** A point well along a route and the way the route runs there. */
  const onRoute = (): [number, number, number, number] | null => {
    if (!routes.length) return null;
    const p = routes[rng.int(routes.length)], n = p.length / 2;
    const k = Math.floor(n * rng.range(0.25, 0.75));
    const k0 = Math.max(0, k - 3), k1 = Math.min(n - 1, k + 3);
    const dx = p[k1 * 2] - p[k0 * 2], dy = p[k1 * 2 + 1] - p[k0 * 2 + 1];
    const L = Math.sqrt(dx * dx + dy * dy);
    return L < 1 ? null : [p[k * 2], p[k * 2 + 1], dx / L, dy / L];
  };
  /** Far enough from the other fields that they read as separate features (a form's own pieces, like a river, need less). */
  const fixed = spec.fields.length;
  const apart = (x: number, y: number, gap: number) => spec.fields.every((o, i) => capsuleDist(o, x, y) > o.r + (i < fixed ? 24 : gap));

  // ---- fields ---------------------------------------------------------
  const addField = (parts: PolarCapsule[], kind: FieldSpec['kind'], check: (c: Capsule) => boolean): boolean => {
    const caps = parts.flatMap(rotate);
    if (!caps.length || !caps.every((c) => inMap(c, 0) && check(c))) return false;
    // In caves, nebula sits in open ground.
    if (kind === 'nebula' && !caps.every((c) => inOpen(c.x1, c.y1, 0) && inOpen(c.x2, c.y2, 0))) return false;
    // Rifts never stand in the way alone: the nests still connect with every rift treated as rock.
    if (kind === 'rift') {
      const rifts = spec.fields.filter((o) => o.kind === 'rift');
      if (!new Terrain({ walls: [...spec.walls, ...rifts, ...caps], fields: [], crystals: [], cave: spec.cave }, w, h).connected(points)) return false;
    }
    for (const c of caps) spec.fields.push({ ...c, kind });
    return true;
  };
  const nebulaOk = (c: Capsule) => capitals.every((n) => capsuleDist(c, n.x, n.y) > 90) && clearOfCrystals(c, 8);
  const riftOk = (c: Capsule) => nests.every((n) => capsuleDist(c, n.x, n.y) > NEST_RADIUS[n.type] + 40) && clearOfCrystals(c, 10);
  /** A soft cloud of 2-3 puffs round (x, y), spread along (nx, ny). */
  const cloud = (x: number, y: number, nx: number, ny: number, rad: number): PolarCapsule[] => {
    const out = [polarCap({ x1: x, y1: y, x2: x, y2: y, r: rad })];
    const extra = 1 + rng.int(2);
    for (let e = 0; e < extra; e++) {
      const s = (e % 2 ? -1 : 1) * rad * rng.range(0.5, 0.9), o = rng.range(-0.3, 0.3) * rad;
      const px = x + nx * s - ny * o, py = y + ny * s + nx * o;
      out.push(polarCap({ x1: px, y1: py, x2: px, y2: py, r: rad * rng.range(0.6, 0.9) }));
    }
    return out;
  };
  /** A rift across a route at (x, y) running (dx, dy): a curve, a broken line, a fork, or a pool. */
  const riftAcross = (x: number, y: number, dx: number, dy: number): Capsule[] => {
    const nx = -dy, ny = dx;
    const shape = rng.pick(['curve', 'curve', 'broken', 'fork', 'pool'] as const);
    const out: Capsule[] = [];
    if (shape === 'pool') {
      // A few wide, overlapping blobs.
      const n = 2 + rng.int(3);
      for (let k = 0; k < n; k++) {
        const ox = x + rng.range(-26, 26) * scale, oy = y + rng.range(-26, 26) * scale;
        const t = rng.range(-PI, PI), l = rng.range(0, 24) * scale;
        out.push({ x1: ox, y1: oy, x2: ox + dcos(t) * l, y2: oy + dsin(t) * l, r: rng.range(17, 25) * scale });
      }
      return out;
    }
    // A bowed line across the route, off-center so one way round is shorter.
    const rad = rng.range(9, 13) * scale;
    const L = rng.range(100, 170) * scale, bow = rng.range(-0.35, 0.35) * L, shift = rng.range(-0.3, 0.3) * L;
    const segs = 5;
    const at = (s: number): [number, number] => {
      const u = (s / segs) * 2 - 1;
      const along = shift + (u * L) / 2, off = bow * (1 - u * u);
      return [x + nx * along + dx * off, y + ny * along + dy * off];
    };
    const gap = shape === 'broken' ? 1 + rng.int(segs - 2) : -1;
    for (let s = 0; s < segs; s++) {
      if (s === gap) continue;
      const [x1, y1] = at(s), [x2, y2] = at(s + 1);
      out.push({ x1, y1, x2, y2, r: rad });
    }
    if (shape === 'fork') {
      // A branch off one joint, back along the route a way.
      const [bx, by] = at(1 + rng.int(segs - 1));
      const side = rng.next() < 0.5 ? -1 : 1, spin = rng.next() < 0.5 ? -1 : 1;
      const l = L * rng.range(0.3, 0.45);
      const ex = side * dx + spin * 0.7 * nx, ey = side * dy + spin * 0.7 * ny, el = Math.sqrt(ex * ex + ey * ey);
      const [mx, my] = [bx + (ex / el) * l * 0.5, by + (ey / el) * l * 0.5];
      out.push({ x1: bx, y1: by, x2: mx, y2: my, r: rad * 0.9 });
      out.push({ x1: mx, y1: my, x2: mx + (dx * side * l) / 2, y2: my + (dy * side * l) / 2, r: rad * 0.8 });
    }
    // In caves, only the stretch in open ground.
    return out.filter((c) => inOpen(c.x1, c.y1, 0) && inOpen(c.x2, c.y2, 0));
  };

  // Nebula: soft clouds that slow everything inside. Not on anyone's capital.
  // Across routes (in caves, the wide openings, not the chokes), in a noise
  // map's valleys, round a ring's void, between a spiral's arms.
  const valleys: number[] = [];
  if (grid?.height) {
    for (let k = 0; k < grid.rock.length; k++) {
      const r = grid.rAt(Math.floor(k / grid.cols));
      if (!grid.rock[k] && r > 0.3 && r < 0.9) valleys.push(k);
    }
    valleys.sort((p, q) => grid.height![p] - grid.height![q] || p - q);
    valleys.length = Math.max(1, Math.ceil(valleys.length * 0.15));
  }
  const nebulaGen: Record<string, () => PolarCapsule[] | null> = {
    route: () => {
      const at = onRoute();
      if (!at) return null;
      const [x, y, dx, dy] = at;
      if (cp && ground.clearance(x, y) < 45 * scale) return null;
      if (!apart(x, y, 80)) return null;
      const rad = rng.range(36, 56) * scale, side = rng.range(-0.5, 0.5) * rad;
      return cloud(x - dy * side, y + dx * side, -dy, dx, rad);
    },
    valley: () => {
      if (!valleys.length) return null;
      const k = valleys[rng.int(valleys.length)];
      const [x, y] = pos(grid!.rAt(Math.floor(k / grid!.cols)), base + grid!.aAt(k % grid!.cols));
      if (!apart(x, y, 80)) return null;
      const t = rng.range(-PI, PI);
      return cloud(x, y, dcos(t), dsin(t), rng.range(36, 56) * scale);
    },
    halo: () => {
      if (!ring || ring.kind === 'nebula') return null;
      // A few puffs strung round the void's rim.
      const r = ring.rim * rng.range(0.92, 1.02), a0 = rng.range(-0.5, 0.5) * sector, step = 46 / (r * f.unit);
      const n = 2 + rng.int(2), rad = rng.range(30, 40) * scale;
      return Array.from({ length: n }, (_, k) => ({ r1: r, a1: a0 + k * step, r2: r, a2: a0 + k * step, rad: rad * (k % 2 ? 0.8 : 1) }));
    },
    arms: () => {
      if (!spiralGap) return null;
      const t = rng.range(0.15, 0.85);
      const [r, a] = spiralGap(t), [r2, a2] = spiralGap(t + 0.08);
      const [x, y] = pos(r, base + a), [x2, y2] = pos(r2, base + a2);
      const L = Math.sqrt((x2 - x) ** 2 + (y2 - y) ** 2) || 1;
      return cloud(x, y, (x2 - x) / L, (y2 - y) / L, rng.range(34, 50) * scale);
    },
  };
  const firstNebula = ring ? 'halo' : spiralGap ? 'arms' : grid?.height ? 'valley' : 'route';
  const clouds = Math.round(tp.nebula * rng.range(0.8, 1.6));
  for (let k = 0; k < clouds; k++) {
    let ok = false;
    // The form's own spot first, then routes (and valleys on noise maps).
    const order = k === 0 ? [firstNebula, 'route'] : grid?.height && k % 2 === 0 ? ['valley', 'route'] : ['route', firstNebula];
    for (const g of order) {
      for (let tries = 0; tries < 12 && !ok; tries++) {
        const parts = nebulaGen[g]();
        ok = !!parts && addField(parts, 'nebula', nebulaOk);
      }
      if (ok) break;
    }
    // Last resort: anywhere off the capitals.
    for (let tries = 0; tries < 20 && !ok; tries++) {
      const r = rng.range(0.3, 0.8), a = rng.range(-0.5, 0.5) * sector;
      const [x, y] = pos(r, base + a), t = rng.range(-PI, PI);
      if (!apart(x, y, 50)) continue;
      ok = addField(cloud(x, y, dcos(t), dsin(t), rng.range(36, 60) * scale), 'nebula', nebulaOk);
    }
  }

  // Rifts: damaging ground across the routes, in varied shapes: you wade
  // through or go round. A ring gets a broken arc round its void, a rock
  // river a pool on one of its fords. Never on a nest, never the only way.
  const riftGen: Record<string, () => PolarCapsule[] | null> = {
    route: () => {
      const at = onRoute();
      if (!at || !apart(at[0], at[1], 70)) return null;
      const caps = riftAcross(...at);
      return caps.length >= 2 || (caps.length === 1 && caps[0].r > 15) ? caps.map(polarCap) : null;
    },
    arc: () => {
      if (!ring || ring.kind === 'rift') return null;
      const r = ring.rim + rng.range(0.04, 0.1), a0 = rng.range(-0.5, 0.2) * sector, span = rng.range(0.25, 0.4) * sector;
      const parts = arc(r, a0, a0 + span, rng.range(9, 12) * scale, 4);
      parts.splice(1 + rng.int(2), 1);
      // Clear of the halo's puffs.
      return parts.every((p) => apart(...pos(p.r1, base + p.a1), 24) && apart(...pos(p.r2, base + p.a2), 24)) ? parts : null;
    },
    ford: () => {
      const o = river?.kind === 'wall' ? river.ford[1] : undefined;
      if (!o) return null;
      const [x, y] = pos(o.r, base + o.a);
      return Array.from({ length: 2 + rng.int(2) }, () => {
        const px = x + rng.range(-20, 20) * scale, py = y + rng.range(-20, 20) * scale;
        return polarCap({ x1: px, y1: py, x2: px, y2: py, r: rng.range(16, 22) * scale });
      });
    },
  };
  const firstRift = ring ? 'arc' : river?.kind === 'wall' ? 'ford' : 'route';
  // A rift sea or a rift river is the map's rift already.
  const rifts = (f.form === 'islands' && !cp) || river?.kind === 'rift' ? 0 : Math.round(tp.rifts * rng.range(0.6, 1.3));
  for (let k = 0; k < rifts; k++) {
    let ok = false;
    for (const g of k === 0 ? [firstRift, 'route'] : ['route']) {
      for (let tries = 0; tries < 12 && !ok; tries++) {
        const parts = riftGen[g]();
        ok = !!parts && addField(parts, 'rift', riftOk);
      }
      if (ok) break;
    }
    // Last resort: a bowed strip anywhere off the nests.
    for (let tries = 0; tries < 20 && !ok; tries++) {
      const [x, y] = pos(rng.range(0.32, 0.75), base + rng.range(-0.45, 0.45) * sector), t = rng.range(-PI, PI);
      if (!apart(x, y, 50)) continue;
      const caps = riftAcross(x, y, dcos(t), dsin(t));
      ok = caps.length > 0 && addField(caps.map(polarCap), 'rift', riftOk);
    }
  }

  return spec;
}

/**
 * Rotating a layout around an ellipse stretches it differently in each
 * sector, so a tunnel that runs straight for one start can wind for another.
 * Try a few layouts and keep the one where every start's walk to the center
 * is the most alike (as a detour over the straight line).
 */
function fairestCave(rng: Rng, cp: CaveParams, f: Frame, crystals: CrystalPlace[], crystalR: number, scale: number, grid: FieldGrid | null): CaveSpec {
  const { w, h, P, nests } = f;
  const center = { x: w / 2, y: h / 2 };
  // Noise and warrens rock is grown once (by the caller); the attempts only re-cut the tunnels.
  const field = grid && cp.mode === 'noise' ? fieldCaps(grid, f, (k) => grid.rock[k] === 1) : null;
  let best: CaveSpec | null = null, bestSpread = Infinity;
  for (let attempt = 0; attempt < 16 && bestSpread > 1.05; attempt++) {
    const cave = generateCaves(new Rng(rng.int(0x7fffffff)), cp, f, crystals, crystalR, scale, field, cp.mode === 'ca' ? grid : null);
    const t = new Terrain({ walls: [], fields: [], crystals: [], cave }, w, h);
    let detours = nests.slice(0, P).map((n) => t.pathDist(n.x, n.y, center.x, center.y, 0) / Math.sqrt((n.x - center.x) ** 2 + (n.y - center.y) ** 2));
    // A middle left in rock (a ring's void): compare the walks to the next start instead.
    if (!detours.every(Number.isFinite)) {
      detours = nests.slice(0, P).map((n, k) => {
        const o = nests[(k + 1) % P];
        return t.pathDist(n.x, n.y, o.x, o.y, 0) / Math.sqrt((n.x - o.x) ** 2 + (n.y - o.y) ** 2);
      });
    }
    const spread = Math.max(...detours) / Math.min(...detours);
    if (!best || spread < bestSpread) {
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
function generateCaves(rng: Rng, cp: CaveParams, f: Frame, crystals: CrystalPlace[], crystalR: number, scale: number, field: Capsule[] | null = null, caverns: FieldGrid | null = null): CaveSpec {
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
  // Each start's copy of a crystal may sit off the turned one (#114): stretch its chamber out to it.
  for (const c of crystals) {
    for (let k = 0; k < P; k++) {
      const [x, y] = pos(c.r, base + c.a + k * sector);
      carves.push({ x1: x, y1: y, x2: c.at[k][0], y2: c.at[k][1], r: crystalR + 34 * scale });
    }
  }
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
  // Islands: each island is one open blob, so its nests share the ground.
  if (f.islands) carves.push(...islandCaps(f, FIELD_CELL));
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

/**
 * An empty polar cell grid over player 0's sector, from the middle out to
 * polar radius `r1`, sized by the ellipse's long axis so no cell is wider
 * than `cell` px anywhere (#98).
 */
function polarGrid(f: Pick<Frame, 'sector' | 'pos' | 'w' | 'h'>, r0: number, r1: number, cell: number): FieldGrid {
  const { sector, pos, w, h } = f;
  const [ex, ey] = pos(1, 0), [fx, fy] = pos(1, PI / 2);
  const uMax = Math.max(Math.abs(ex - w / 2), Math.abs(fy - h / 2), Math.abs(ey - h / 2), Math.abs(fx - w / 2));
  const rows = Math.ceil(((r1 - r0) * uMax) / cell);
  const cols = Math.max(8, Math.round((sector * uMax) / cell));
  const cellAt = (r: number, a: number) => {
    const i = Math.floor(((r - r0) / (r1 - r0)) * rows);
    if (i < 0 || i >= rows) return -1;
    let t = a / sector + 0.5;
    t -= Math.floor(t);
    return i * cols + (Math.floor(t * cols) % cols);
  };
  return { rows, cols, rock: new Uint8Array(rows * cols), rAt: (i) => r0 + ((i + 0.5) * (r1 - r0)) / rows, aAt: (j) => ((j + 0.5) / cols - 0.5) * sector, cellAt };
}

/** The islands' ground as capsules in every sector: the cells within their radius (#98). */
function islandCaps(f: Frame, cell: number): Capsule[] {
  const isl = f.islands!;
  const g = polarGrid(f, 0, Math.max(...isl.map((o) => o.r + o.R)) + 0.05, cell);
  return fieldCaps(g, f, (k) => isl.some((o) => islandDist(o, g.rAt(Math.floor(k / g.cols)), g.aAt(k % g.cols), f.sector) < o.R), 0.72, cell);
}

/**
 * The islands form on an open map (#98): a sea of rift round the islands,
 * crossed by clear bridges. The bridges join each sector's islands in a tree
 * (shortest first), plus the shortest one across the border to the next
 * sector, so every island is reachable without wading. The sea is laid on a
 * polar grid out past the map's corners, as rift capsules in every sector.
 */
function seaOfRift(spec: TerrainSpec, f: Frame, scale: number): void {
  const { P, sector, base, pos, nests, w, h } = f;
  const isl = f.islands!;
  // Bridges, as px capsules in every sector.
  const at = (o: Island, shift = 0) => pos(o.r, base + o.a + shift);
  const edges: { i: number; j: number; cross: boolean; d: number }[] = [];
  for (let i = 0; i < isl.length; i++) {
    for (let j = 0; j < isl.length; j++) {
      for (const cross of [false, true]) {
        if ((!cross && j <= i) || (cross && (isl[i].r === 0 || isl[j].r === 0))) continue;
        const [x1, y1] = at(isl[i]), [x2, y2] = at(isl[j], cross ? sector : 0);
        edges.push({ i, j, cross, d: Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2) });
      }
    }
  }
  edges.sort((a, b) => a.d - b.d);
  const root = isl.map((_, k) => k);
  const find = (k: number): number => (root[k] === k ? k : (root[k] = find(root[k])));
  const chosen: typeof edges = [];
  for (const e of edges) {
    if (e.cross || find(e.i) === find(e.j)) continue;
    root[find(e.i)] = find(e.j);
    chosen.push(e);
  }
  const cross = edges.find((e) => e.cross);
  if (cross) chosen.push(cross);
  const half = 22 * scale;
  const bridges: Capsule[] = [];
  for (const e of chosen) {
    for (let k = 0; k < P; k++) {
      const [x1, y1] = at(isl[e.i], k * sector), [x2, y2] = at(isl[e.j], (k + (e.cross ? 1 : 0)) * sector);
      bridges.push({ x1, y1, x2, y2, r: half });
    }
  }
  // The sea: every cell off the islands, the bridges, the nests and the crystals.
  const cell = 30;
  const g = polarGrid(f, 0, 1.8, cell);
  const { rows, cols, rAt, aAt, rock: wet } = g;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const r = rAt(i), a = aAt(j);
      if (isl.some((o) => islandDist(o, r, a, sector) < o.R)) continue;
      const [x, y] = pos(r, base + a);
      if (x < -cell || y < -cell || x > w + cell || y > h + cell) continue;
      // A whole sea capsule off each bridge, so the bridge keeps its width (and never pinches shut).
      if (bridges.some((c) => capsuleDist(c, x, y) < c.r + 0.72 * cell)) continue;
      if (nests.some((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < (NEST_RADIUS[n.type] + 40) ** 2)) continue;
      if (spec.crystals.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 < (o.r + 30) ** 2)) continue;
      wet[i * cols + j] = 1;
    }
  }
  for (const c of fieldCaps(g, f, (k) => wet[k] === 1, 0.72, cell)) spec.fields.push({ ...c, kind: 'rift' });
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
  /** the cell at polar (r, angle from base), or -1 off the grid; the angle wraps */
  cellAt: (r: number, a: number) => number;
  /**
   * How high each cell's ground is, 0 to 1 (#114): the noise itself, or for
   * caverns how much rock is close by. Valleys are low, ridges high.
   */
  height?: Float64Array;
}

/**
 * The cell grid for the 'noise' and 'ca' cave modes (#98): a polar grid over
 * player 0's sector whose angle wraps round (the next sector is the same grid
 * turned), so every sector gets the same rock and the borders join up
 * without a seam. 'noise' thresholds warped fBm or ridged noise, sampled
 * round a circle so it wraps too; 'ca' grows caverns with a cellular automaton.
 */
function fieldGrid(rng: Rng, cp: CaveParams, f: Pick<Frame, 'sector' | 'pos' | 'w' | 'h'>): FieldGrid {
  const { sector } = f;
  // Cells no wider than FIELD_CELL anywhere: the capsules have a fixed
  // radius, and stretched cells would leave seams between them on wide maps.
  const grid = polarGrid(f, 0.12, cp.mode === 'ca' ? 1.22 : 1.1, FIELD_CELL);
  const { rows, cols, rock, rAt, aAt } = grid;
  if (cp.mode === 'noise') {
    const { kind, threshold, scale, warp } = cp.field ?? NOISE_FIELD;
    const seed = rng.int(0x7fffffff);
    const height = (grid.height = new Float64Array(rows * cols));
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
        height[i * cols + j] = v;
      }
    }
    // Fill enclosed pockets: open ground walled off from both the middle and
    // the rim would be unreachable (tunnels are only cut between chambers).
    // A first pass on the grid; fairestCave checks the real ground after.
    const seeds: number[] = [];
    for (let j = 0; j < cols; j++) for (const i of [0, rows - 1]) if (!rock[i * cols + j]) seeds.push(i * cols + j);
    const seen = floodOpen(grid, seeds);
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
    // Height: the share of rock within two cells.
    const height = (grid.height = new Float64Array(rows * cols));
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        let n = 0, m = 0;
        for (let di = -2; di <= 2; di++) {
          for (let dj = -2; dj <= 2; dj++) {
            const ii = i + di;
            m++;
            if (ii >= rows || (ii >= 0 && rock[ii * cols + ((j + dj + cols) % cols)])) n++;
          }
        }
        height[i * cols + j] = n / m;
      }
    }
  }
  return grid;
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
function fieldCaps(g: FieldGrid, f: Frame, pick: (k: number) => boolean, rad = 0.78, cell = FIELD_CELL): Capsule[] {
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
        out.push({ x1, y1, x2, y2, r: rad * cell });
      }
      j = e + 1;
    }
  }
  return out;
}
