import { MAX_LEVEL, NEST_RADIUS, NestType } from './constants';
import { TAU, dcos, dsin } from './mathx';
import type { MapSize, MapSpec, NestSpec } from './mapgen';
import type { Rng } from './rng';
import { Terrain, capsuleDist, type Capsule } from './terrain';

/**
 * Stronghold battles (#100): a generated map turned into a warlord's
 * fortress. Its capital becomes a max-level citadel inside a ring of walls
 * with a few gates facing the middle, two more of its nests guard the inside,
 * and anything else in the way is cleared. Taking the citadel wins.
 * PROVISIONAL numbers (#68).
 */
export const FORTIFY = {
  /** wall ring radius by map size */
  ringR: { small: 165, medium: 195, large: 225 } as Record<MapSize, number>,
  wallR: 12,
  /** ring segments (before gates are cut) */
  segments: 28,
  /** gate width, px; widened if a capital can't walk in */
  gate: 84,
  /** gates either side of the one facing the middle, this far round (radians) */
  gateSpread: 0.9,
  citadelGarrison: 22,
  worksGarrison: 8,
  /** inner works: how many, and how far from the citadel */
  works: 2,
  worksR: 0.6,
};

/** Nest types the inside of a fortress is built from. */
const WORKS = [NestType.Bastion, NestType.Forge, NestType.Spire];

/** Fortify `player`'s capital on a generated map, in place. Its own seeded stream: the rest of the map is untouched. */
export function fortify(spec: MapSpec, player: number, size: MapSize, rng: Rng): void {
  const citadel = spec.nests.find((n) => n.player === player && n.capital !== false);
  if (!citadel) return;
  const { width: W, height: H } = spec;
  const R = FORTIFY.ringR[size];
  citadel.level = MAX_LEVEL;
  citadel.garrison = FORTIFY.citadelGarrison;
  // The gates face the middle, where every rival comes from. Angles below are
  // relative to that direction (no atan2: the sim keeps to mathx's trig).
  const dx = W / 2 - citadel.x, dy = H / 2 - citadel.y, dl = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / dl, uy = dy / dl;
  /** the point r from the citadel at angle b off the facing direction */
  const at = (b: number, r: number): [number, number] => {
    const c = dcos(b), s = dsin(b);
    return [citadel.x + (ux * c - uy * s) * r, citadel.y + (ux * s + uy * c) * r];
  };

  // Clear the ground: terrain on or inside the ring, and neutral nests in the way.
  const near = (x: number, y: number, pad: number) => (x - citadel.x) ** 2 + (y - citadel.y) ** 2 < (R + pad) ** 2;
  const t = spec.terrain;
  t.walls = t.walls.filter((c) => capsuleDist(c, citadel.x, citadel.y) > R + 30);
  t.fields = t.fields.filter((c) => capsuleDist(c, citadel.x, citadel.y) > R + 30);
  t.crystals = t.crystals.filter((c) => !near(c.x, c.y, c.r + 30));
  spec.nests = spec.nests.filter((n) => n === citadel || n.player >= 0 || !near(n.x, n.y, NEST_RADIUS[n.type] + FORTIFY.wallR + 24));

  // The inner works: between the citadel and its gates.
  for (let k = 0; k < FORTIFY.works; k++) {
    const side = k % 2 ? 1 : -1;
    for (let tries = 0; tries < 12; tries++) {
      const [x, y] = at(side * (0.55 + 0.12 * tries + rng.range(-0.1, 0.1)), R * FORTIFY.worksR);
      if (x < 50 || x > W - 50 || y < 50 || y > H - 50) continue;
      if (spec.nests.some((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < 80 * 80)) continue;
      const works: NestSpec = { x, y, type: rng.pick(WORKS), level: 2, player, garrison: FORTIFY.worksGarrison, capital: false };
      spec.nests.push(works);
      break;
    }
  }

  // The wall, with gates; widened until every other capital can walk in.
  const capitals = spec.nests.filter((n) => n !== citadel && n.player >= 0 && n.capital !== false);
  for (let widen = 1; widen < 3; widen *= 1.35) {
    const ring = wallRing(at, R, FORTIFY.gate * widen, W, H);
    const walls = [...t.walls, ...ring];
    const terrain = new Terrain({ ...t, walls }, W, H);
    if (capitals.every((c) => Number.isFinite(terrain.pathDist(c.x, c.y, citadel.x, citadel.y, 0)))) {
      t.walls = walls;
      return;
    }
  }
}

/** The ring of wall capsules (radius R), with gates facing the middle and either side of it. */
function wallRing(at: (b: number, r: number) => [number, number], R: number, gate: number, W: number, H: number): Capsule[] {
  const gates = [0, -FORTIFY.gateSpread, FORTIFY.gateSpread];
  const half = gate / 2 / R;
  const n = FORTIFY.segments;
  const out: Capsule[] = [];
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * TAU, a1 = ((k + 1) / n) * TAU;
    const mid = (a0 + a1) / 2;
    if (gates.some((g) => Math.abs(wrap(mid - g)) < half + TAU / n / 2)) continue;
    const [x1, y1] = at(a0, R);
    const [x2, y2] = at(a1, R);
    // Off the map edge it's pointless (the edge is a wall already).
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (mx < 0 || mx > W || my < 0 || my > H) continue;
    out.push({ x1, y1, x2, y2, r: FORTIFY.wallR });
  }
  return out;
}

/** An angle into -π..π. */
function wrap(a: number): number {
  return a - TAU * Math.round(a / TAU);
}
