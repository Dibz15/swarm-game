import { NEST_RADIUS, NestType } from './constants';
import { TAU, dcos, dsin } from './mathx';
import type { MapSize, MapSpec, NestSpec } from './mapgen';
import type { Rng } from './rng';
import { Terrain, capsuleDist, segDist2, type Capsule } from './terrain';

/**
 * A fortress (#100, #67): a generated map with one player walled in. Its
 * capital sits inside walls whose gates face the middle; two more of its nests
 * (a Bastion and a Forge or Spire) hold the inside, and anything else in the
 * way is cleared. Each map rolls its own style, radius, gates and cover, so no
 * two fortresses play alike. Warlords' strongholds (taking the citadel wins)
 * and Hold the line (you, holding out) both use it. Its army starts spread
 * over the three nests, not piled on the capital. PROVISIONAL numbers (#68).
 */
export const FORTIFY = {
  /** wall radius by map size, before the per-map roll (±15%) */
  ringR: { small: 165, medium: 195, large: 225 } as Record<MapSize, number>,
  wallR: 12,
  /** ring segments (before gates are cut) */
  segments: 32,
  /** gate width range, px; widened if someone can't walk in */
  gate: [70, 100] as [number, number],
  /** the citadel's level: a capital already has a turret, and higher levels' faster spawns snowballed the warlord */
  citadelLevel: 1,
  /** the starting army at the capital, and at each inner nest */
  citadelGarrison: 10,
  worksGarrison: 7,
  /** inner works: how many, and how far from the capital */
  works: 2,
  worksR: 0.6,
};

/** How a fortress is built (#67). Each is rolled by the map's seed. */
export type FortressStyle = 'ring' | 'horseshoe' | 'keep' | 'bastioned' | 'broken';
export const FORTRESS_STYLES: readonly FortressStyle[] = ['ring', 'horseshoe', 'keep', 'bastioned', 'broken'];
export const FORTRESS_LABEL: Record<FortressStyle, string> = {
  ring: 'Ring',
  horseshoe: 'Horseshoe',
  keep: 'Keep',
  bastioned: 'Bastioned',
  broken: 'Broken walls',
};

/** What a fortress came out as, for previews. */
export interface FortressInfo {
  style: FortressStyle;
  x: number;
  y: number;
  r: number;
}

/** The inside of a fortress: a Bastion (defense, little production), then a Forge or Spire. */
const WORKS = [NestType.Forge, NestType.Spire];

/** The wall shape's rolled parameters. */
interface Plan {
  style: FortressStyle;
  R: number;
  /** gate centres, radians off the facing direction (0 always among them; 2-3 in all) */
  gates: number[];
  gate: number;
  /** lobes: r(θ) = R (1 + amp sin(k θ + phase)) */
  k: number;
  amp: number;
  phase: number;
  /** broken: which segments are missing */
  gaps: Set<number>;
  /** cover chunks on the approach: angle, radius share, tilt, length */
  cover: [number, number, number, number][];
}

/**
 * Wall `player`'s capital in, in place. `reach` lists points (rival capitals,
 * wave spawns) that must be able to walk to it. Its own seeded stream: the
 * rest of the map is untouched.
 */
export function fortify(spec: MapSpec, player: number, size: MapSize, rng: Rng, reach: [number, number][] = []): FortressInfo | null {
  const citadel = spec.nests.find((n) => n.player === player && n.capital !== false);
  if (!citadel) return null;
  const { width: W, height: H } = spec;
  citadel.level = FORTIFY.citadelLevel;
  citadel.garrison = FORTIFY.citadelGarrison;
  // The gates face the middle, where every rival comes from. Angles below are
  // relative to that direction (no atan2: the sim keeps to mathx's trig).
  const dx = W / 2 - citadel.x, dy = H / 2 - citadel.y, dl = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / dl, uy = dy / dl;
  /** the point r from the capital at angle b off the facing direction */
  const at = (b: number, r: number): [number, number] => {
    const c = dcos(b), s = dsin(b);
    return [citadel.x + (ux * c - uy * s) * r, citadel.y + (ux * s + uy * c) * r];
  };

  const plan = rollPlan(rng, FORTIFY.ringR[size]);
  const R = plan.R;

  // Clear the ground: terrain on or inside the walls, and neutral nests in the way.
  const near = (x: number, y: number, pad: number) => (x - citadel.x) ** 2 + (y - citadel.y) ** 2 < (R + pad) ** 2;
  const t = spec.terrain;
  t.walls = t.walls.filter((c) => capsuleDist(c, citadel.x, citadel.y) > R * 1.25 + 30);
  t.fields = t.fields.filter((c) => capsuleDist(c, citadel.x, citadel.y) > R * 1.25 + 30);
  t.crystals = t.crystals.filter((c) => !near(c.x, c.y, c.r + 30));
  // Cave or noise rock too (#98): carve the fortress ground out of it.
  if (t.cave) t.cave = { ...t.cave, carves: [...t.cave.carves, { x1: citadel.x, y1: citadel.y, x2: citadel.x, y2: citadel.y, r: R * 1.25 + 30 }] };
  spec.nests = spec.nests.filter((n) => n === citadel || n.player >= 0 || !near(n.x, n.y, NEST_RADIUS[n.type] + FORTIFY.wallR + 24));

  // The inner works: either side of the capital, toward its gates.
  for (let k = 0; k < FORTIFY.works; k++) {
    const side = k % 2 ? 1 : -1;
    for (let tries = 0; tries < 12; tries++) {
      const [x, y] = at(side * (0.55 + 0.12 * tries + rng.range(-0.15, 0.15)), R * FORTIFY.worksR * rng.range(0.9, 1.1));
      if (x < 50 || x > W - 50 || y < 50 || y > H - 50) continue;
      if (spec.nests.some((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < 80 * 80)) continue;
      const type = k === 0 ? NestType.Bastion : rng.pick(WORKS);
      const works: NestSpec = { x, y, type, level: 1, player, garrison: FORTIFY.worksGarrison, capital: false };
      spec.nests.push(works);
      break;
    }
  }

  // Build it; widen the gates until everyone who must can walk in, then fall
  // back to a plain ring, then to no walls at all.
  const must = [...spec.nests.filter((n) => n !== citadel && n.player >= 0 && n.capital !== false).map((n): [number, number] => [n.x, n.y]), ...reach];
  const tries: Plan[] = [1, 1.35, 1.8].map((k) => ({ ...plan, gate: plan.gate * k }));
  tries.push({ ...plan, style: 'ring', amp: 0, gates: [0, -0.9, 0.9], gate: FORTIFY.gate[1] * 1.4, gaps: new Set(), cover: [] });
  for (const p of tries) {
    const walls = buildWalls(p, at, W, H).filter((c) => clearOf(c, spec.nests));
    const all = [...t.walls, ...walls];
    const terrain = new Terrain({ ...t, walls: all }, W, H);
    if (must.every(([x, y]) => Number.isFinite(terrain.pathDist(x, y, citadel.x, citadel.y, 0)))) {
      t.walls = all;
      return { style: p.style, x: citadel.x, y: citadel.y, r: R };
    }
  }
  return null;
}

/** Roll a fortress: its style, size, gates, lobes, breaks and cover. */
function rollPlan(rng: Rng, baseR: number): Plan {
  const style = rng.pick(FORTRESS_STYLES);
  const R = baseR * rng.range(0.85, 1.15);
  // Gates: one facing the middle, and one or two more round the front (more
  // left the front mostly open).
  const extra = 1 + rng.int(2);
  const gates = [0];
  for (let k = 0; k < extra; k++) gates.push((k % 2 ? 1 : -1) * rng.range(0.8, 1.3));
  const gate = rng.range(FORTIFY.gate[0], FORTIFY.gate[1]) * (style === 'keep' ? 1.25 : 1);
  const gaps = new Set<number>();
  if (style === 'broken') {
    // Three or four missing runs of wall, a couple of segments each.
    for (let k = 3 + rng.int(2); k > 0; k--) {
      const s = rng.int(FORTIFY.segments);
      for (let j = 0, len = 1 + rng.int(3); j < len; j++) gaps.add((s + j) % FORTIFY.segments);
    }
  }
  const cover: Plan['cover'] = [];
  const nCover = style === 'broken' ? 3 + rng.int(3) : rng.int(4);
  for (let k = 0; k < nCover; k++) cover.push([rng.range(-1.3, 1.3), rng.range(1.3, 1.7), rng.range(0, TAU), rng.range(22, 46)]);
  return {
    style,
    R,
    gates,
    gate,
    k: 2 + rng.int(3),
    amp: style === 'ring' || style === 'keep' ? rng.range(0.06, 0.18) : rng.range(0, 0.1),
    phase: rng.range(0, TAU),
    gaps,
    cover,
  };
}

/** The wall capsules for a plan. */
function buildWalls(p: Plan, at: (b: number, r: number) => [number, number], W: number, H: number): Capsule[] {
  const n = FORTIFY.segments;
  const radius = (b: number) => p.R * (1 + p.amp * dsin(p.k * b + p.phase));
  const half = p.gate / 2 / p.R;
  const inGate = (b: number) => p.gates.some((g) => Math.abs(wrap(b - g)) < half + TAU / n / 2);
  const out: Capsule[] = [];
  const seg = (b0: number, r0: number, b1: number, r1: number, r = FORTIFY.wallR) => {
    const [x1, y1] = at(b0, r0);
    const [x2, y2] = at(b1, r1);
    // Off the map edge it's pointless (the edge is a wall already).
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (mx < 0 || mx > W || my < 0 || my > H) return;
    out.push({ x1, y1, x2, y2, r });
  };

  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * TAU, a1 = ((k + 1) / n) * TAU, mid = wrap((a0 + a1) / 2);
    if (p.style === 'horseshoe') {
      // Only the back half: the front is open, behind a line of barricades.
      if (Math.abs(mid) < 1.45) continue;
    } else if (inGate(mid) || p.gaps.has(k)) continue;
    seg(a0, radius(a0), a1, radius(a1));
  }

  if (p.style === 'horseshoe') {
    // Barricades across the open front, with lanes between them.
    const span = 1.35, count = 3;
    for (let k = 0; k < count; k++) {
      const c = -span + ((k + 0.5) / count) * span * 2;
      seg(c - 0.22, p.R * 1.05, c + 0.22, p.R * 1.05);
    }
  } else if (p.style === 'keep') {
    // A second line: a short arc in front of the capital, open in the middle.
    const r = p.R * 0.78;
    for (const side of [-1, 1]) seg(side * 0.2, r, side * 0.62, r);
  } else if (p.style === 'bastioned') {
    // Spurs out from each gate: you fight down a funnel into it.
    for (const g of p.gates) {
      for (const side of [-1, 1]) {
        const b = g + side * (half + 0.04);
        seg(b, radius(b), b + side * 0.12, radius(b) + 70);
      }
    }
  }
  // Cover on the approach.
  for (const [b, rr, tilt, len] of p.cover) {
    const [cx, cy] = at(b, p.R * rr);
    if (cx < 0 || cx > W || cy < 0 || cy > H) continue;
    const ex = (dcos(tilt) * len) / 2, ey = (dsin(tilt) * len) / 2;
    out.push({ x1: cx - ex, y1: cy - ey, x2: cx + ex, y2: cy + ey, r: 14 });
  }
  return out;
}

/** A wall piece that doesn't crowd any nest. */
function clearOf(c: Capsule, nests: NestSpec[]): boolean {
  for (const n of nests) {
    const pad = NEST_RADIUS[n.type] + c.r + 14;
    if (segDist2(n.x, n.y, c.x1, c.y1, c.x2, c.y2) < pad * pad) return false;
  }
  return true;
}

/** An angle into -π..π. */
function wrap(a: number): number {
  return a - TAU * Math.round(a / TAU);
}
