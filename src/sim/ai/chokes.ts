import type { Terrain } from '../terrain';
import type { World } from '../world';

/**
 * Where a nest's chamber narrows into a tunnel or rock gap, on a path other
 * nests walk in by (#25). Bots hold these and stage attacks outside them.
 */
export interface Mouth {
  /** center of the gap */
  x: number;
  y: number;
  /** guard post just inside the chamber, so defenders form an arc instead of a plug */
  gx: number;
  gy: number;
  /** staging point out along the approach */
  sx: number;
  sy: number;
  /** gap width, px */
  width: number;
  /** nests whose walk here runs through this mouth */
  from: number[];
}

export const CHOKE = {
  /** a gap narrower than this counts as a choke */
  width: 100,
  /** look for the mouth this far along the path from the nest (beyond its radius) */
  minPath: 15,
  maxPath: 260,
  /** guard post: px back from the gap toward the nest */
  guard: 22,
  /** staging point: px of walking out from the gap */
  stage: 130,
  /** mouths closer than this merge */
  merge: 70,
};

const cache = new WeakMap<Terrain, Mouth[][]>();

/** Distance to the nearest wall walking from (x, y) along (dx, dy), up to max. */
function cast(t: Terrain, x: number, y: number, dx: number, dy: number, max: number): number {
  for (let s = 0; s < max; ) {
    const c = t.clearance(x + dx * s, y + dy * s);
    if (c <= 0) return s;
    s += Math.max(2, c);
  }
  return max;
}

/** The mouth on one path out of a nest (pts start at the nest), or null if it stays open. */
function mouthOn(t: Terrain, pts: number[], nestR: number): Omit<Mouth, 'from'> | null {
  let len = 0;
  for (let k = 2; k < pts.length; k += 2) {
    const x = pts[k], y = pts[k + 1];
    let dx = x - pts[k - 2], dy = y - pts[k - 1];
    const step = Math.sqrt(dx * dx + dy * dy);
    len += step;
    if (len < nestR + CHOKE.minPath) continue;
    if (len > nestR + CHOKE.maxPath) return null;
    // Only near a wall can a point be in a gap.
    if (step < 1e-6 || t.clearance(x, y) > CHOKE.width / 2) continue;
    dx /= step;
    dy /= step;
    // Measure across the path: walls on both sides closer than the choke width.
    const half = CHOKE.width;
    const a = cast(t, x, y, -dy, dx, half), b = cast(t, x, y, dy, -dx, half);
    if (a + b >= CHOKE.width) continue;
    const cx = x + (-dy * (a - b)) / 2, cy = y + (dx * (a - b)) / 2;
    const [gx, gy] = t.freePoint(cx - dx * CHOKE.guard, cy - dy * CHOKE.guard, 8);
    // Staging point: further out along the same path.
    let sx = pts[pts.length - 2], sy = pts[pts.length - 1];
    for (let j = k + 2, s = 0; j < pts.length; j += 2) {
      s += Math.sqrt((pts[j] - pts[j - 2]) ** 2 + (pts[j + 1] - pts[j - 1]) ** 2);
      if (s >= CHOKE.stage) {
        sx = pts[j];
        sy = pts[j + 1];
        break;
      }
    }
    return { x: cx, y: cy, gx, gy, sx, sy, width: a + b };
  }
  return null;
}

/**
 * Mouths of every nest, by nest id. A pure function of the terrain and the
 * (fixed) nest positions, built once and shared by every bot, so it is
 * lockstep-safe. Open maps have none.
 */
export function nestMouths(w: World): Mouth[][] {
  const t = w.terrain;
  const hit = cache.get(t);
  if (hit) return hit;
  const out: Mouth[][] = w.nests.map(() => []);
  if (t.hasWalls) {
    for (const n of w.nests) {
      for (const m of w.nests) {
        if (m === n) continue;
        const pts = t.trace(n.x, n.y, m.x, m.y, w.tick, n.r + CHOKE.maxPath + CHOKE.stage + 40);
        const found = mouthOn(t, pts, n.r);
        if (!found) continue;
        const same = out[n.id].find((o) => (o.x - found.x) ** 2 + (o.y - found.y) ** 2 < CHOKE.merge ** 2);
        if (same) same.from.push(m.id);
        else out[n.id].push({ ...found, from: [m.id] });
      }
    }
  }
  cache.set(t, out);
  return out;
}
