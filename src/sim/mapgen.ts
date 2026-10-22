import { NEST_RADIUS, NestType } from './constants';
import { PI, TAU, dcos, dsin } from './mathx';
import { Rng } from './rng';
import { Terrain, capsuleDist, emptyTerrain, type Capsule, type FieldSpec, type TerrainSpec } from './terrain';

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

/** Everything that shapes a generated map. Same params + seed = same map. */
export interface MapParams {
  seed: number;
  size: MapSize;
  players: number;
  /** tall map for portrait screens, player 0 at the bottom */
  portrait?: boolean;
  terrain?: TerrainLevel | TerrainParams;
  /** nests per player sector, including the natural expansion (default by size) */
  nestsPerSector?: number;
  /** relative odds of each nest type, indexed by NestType */
  typeWeights?: readonly number[];
}

export interface NestSpec {
  x: number;
  y: number;
  type: number;
  level: number;
  /** player index (into MatchSetup.players), or -1 for neutral */
  player: number;
  garrison: number;
}

export interface MapSpec {
  width: number;
  height: number;
  nests: NestSpec[];
  terrain: TerrainSpec;
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
 * Rotationally symmetric map: nests and terrain are generated in player 0's
 * sector (in polar coordinates on the map's ellipse) and copied into every
 * other sector, so each start has the same options.
 */
export function generateMap(p: MapParams): MapSpec {
  const rng = new Rng(p.seed ^ 0xa5a5a5);
  const dims = MAP_SIZES[p.size];
  const perSector = p.nestsPerSector ?? dims.perSector;
  const weights = p.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
  const portrait = !!p.portrait;
  const w = portrait ? dims.h : dims.w;
  const h = portrait ? dims.w : dims.h;
  const players = p.players;
  const P = Math.max(2, players);
  const cx = w / 2, cy = h / 2;
  const ax = w * 0.5 * 0.88, ay = h * 0.5 * 0.84;
  const sector = TAU / P;
  const base = portrait ? PI / 2 : PI; // player 0 starts bottom / left
  const pos = (r: number, a: number): [number, number] => [cx + dcos(a) * r * ax, cy + dsin(a) * r * ay];

  const nests: NestSpec[] = [];
  for (let k = 0; k < P; k++) {
    const [x, y] = pos(0.86, base + k * sector);
    nests.push({ x, y, type: NestType.Hive, level: 1, player: k < players ? k : -1, garrison: k < players ? 0 : 8 });
  }
  nests.push({ x: cx, y: cy, type: NestType.Hive, level: 2, player: -1, garrison: 14 + P * 2 });

  const minDist = p.size === 'small' ? 100 : 110;
  const fits = (r: number, da: number) => {
    for (let k = 0; k < P; k++) {
      const [x, y] = pos(r, base + da + k * sector);
      if (x < 60 || x > w - 60 || y < 60 || y > h - 60) return false;
      for (const n of nests) {
        if ((n.x - x) ** 2 + (n.y - y) ** 2 < minDist * minDist) return false;
      }
    }
    return true;
  };
  const place = (r: number, da: number, type: number, level: number, garrison: number) => {
    for (let k = 0; k < P; k++) {
      const [x, y] = pos(r, base + da + k * sector);
      nests.push({ x, y, type, level, player: -1, garrison });
    }
  };

  // Keep the mix varied: at most one Bastion and two of any other type per
  // sector, so a seed can't produce a map that is mostly turrets.
  const typeCount = new Map<number, number>();
  const allowed = (t: number) => (typeCount.get(t) ?? 0) < (t === NestType.Bastion ? 1 : 2);

  // A cheap "natural expansion" right next to each start: Hive, Forge or Spire.
  const naturalType = rng.pick([NestType.Hive, NestType.Forge, NestType.Spire]);
  for (let tries = 0; tries < 40; tries++) {
    const da = (rng.next() < 0.5 ? -1 : 1) * rng.range(0.12, 0.28) * sector;
    const r = rng.range(0.55, 0.68);
    if (fits(r, da)) {
      place(r, da, naturalType, 1, naturalType === NestType.Forge ? 6 : 4);
      typeCount.set(naturalType, 1);
      break;
    }
  }

  let placed = 1;
  for (let tries = 0; tries < 400 && placed < perSector; tries++) {
    const r = rng.range(0.28, 1.0);
    const da = rng.range(-0.46, 0.46) * sector;
    if (!fits(r, da)) continue;
    let type = pickType(rng, weights);
    for (let k = 0; k < 6 && !allowed(type); k++) type = pickType(rng, weights);
    if (!allowed(type)) type = [NestType.Forge, NestType.Spire, NestType.Swift, NestType.Hive].find(allowed) ?? NestType.Hive;
    typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
    const level = rng.next() < 0.15 ? 2 : 1;
    let g = Math.round(4 + (1 - r) * 9 + rng.int(4) + (level - 1) * 6);
    if (type === NestType.Bastion) g = Math.round(g * 0.6);
    if (type === NestType.Forge) g += 2;
    place(r, da, type, level, g);
    placed++;
  }

  // Terrain gets its own stream so tuning it never reshuffles the nests.
  const terrain = generateTerrain(new Rng(p.seed ^ 0x7e4a1c), terrainParams(p.terrain), {
    w, h, P, sector, base, pos, nests, size: p.size,
  });
  return { width: w, height: h, nests, terrain };
}

interface Frame {
  w: number;
  h: number;
  P: number;
  sector: number;
  base: number;
  pos: (r: number, a: number) => [number, number];
  nests: NestSpec[];
  size: MapSize;
}

/** A feature in player 0's sector: capsules in polar (r, angle offset) coordinates. */
interface PolarCapsule {
  r1: number;
  a1: number;
  r2: number;
  a2: number;
  rad: number;
}

function generateTerrain(rng: Rng, tp: TerrainParams, f: Frame): TerrainSpec {
  const spec = emptyTerrain();
  if (tp.walls <= 0 && tp.nebula <= 0 && tp.rifts <= 0 && tp.crystals <= 0) return spec;
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
    k++;
  }
  // ---- walls ----------------------------------------------------------
  // Each candidate feature is added to all sectors at once, then kept only if
  // every nest is still reachable from every other.
  const tryWalls = (parts: PolarCapsule[], gap: number): boolean => {
    const caps = parts.flatMap(rotate);
    if (!caps.every((c) => inMap(c, 30) && clearOfNests(c, gap) && clearOfCrystals(c, 16))) return false;
    const next = [...spec.walls, ...caps];
    if (!new Terrain({ walls: next, fields: [], crystals: [] }, w, h).connected(points)) return false;
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

  if (tp.walls > 0) {
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
    // Outcrops: scattered rocks, some elongated.
    const rocks = Math.round(tp.walls * rng.range(2.5, 4.5));
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
