import { CELL, TERRAIN } from './constants';

/**
 * Static map terrain: impassable walls plus fields that change how units
 * move or fight. Walls and fields are capsules (a segment with a radius; a
 * circle when both ends coincide), so collision is exact and cheap. Cave rock
 * is the complement of carved capsules, kept as a signed-distance grid.
 *
 * Pathing uses flow fields on a TILE grid: one Dijkstra from each
 * destination tile, cached and shared by every unit going there. A field is
 * a pure function of the terrain and its target, so building or evicting it
 * at any time never changes the simulation (lockstep-safe).
 */
export interface Capsule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
}

export type FieldKind = 'nebula' | 'rift';
export interface FieldSpec extends Capsule {
  kind: FieldKind;
}

export interface CrystalSpec {
  x: number;
  y: number;
  r: number;
  /** energy rate as a multiple of TERRAIN.crystalEnergy (default 1): sparse maps have fewer, richer crystals (#114) */
  value?: number;
}

/**
 * Cave rock: solid wherever the zone is (everywhere when zone is null) and no
 * carve is. Carves are the chambers and tunnels.
 */
export interface CaveSpec {
  carves: Capsule[];
  zone: Capsule[] | null;
  /** rock laid over everything after the carving: open ground mapgen found nobody could reach (#98) */
  fill?: Capsule[];
}

export interface TerrainSpec {
  walls: Capsule[];
  fields: FieldSpec[];
  crystals: CrystalSpec[];
  cave?: CaveSpec | null;
}

export const emptyTerrain = (): TerrainSpec => ({ walls: [], fields: [], crystals: [] });

export const TILE = 16;
/** tile center too close to a wall to path through */
export const T_BLOCK = 1;
export const T_NEBULA = 2;
export const T_RIFT = 4;
/** a tile in the core of a wide rift (`TERRAIN.riftWide`/`riftDeep`): crossing there would burn a unit up */
export const T_DEEP = 8;

/** Rift damage per second at `heat` ticks of heat (#58): a ramp on heat squared. */
export function riftDps(heat: number): number {
  const { minDps, maxDps, heatTicks } = TERRAIN.rift;
  const f = Math.min(1, heat / heatTicks);
  return minDps + (maxDps - minDps) * f * f;
}

/** Squared distance from (x, y) to segment (x1, y1)-(x2, y2). */
export function segDist2(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x1 + dx * t - x, py = y1 + dy * t - y;
  return px * px + py * py;
}

/** Signed distance from a point to a capsule's surface (negative inside). */
export function capsuleDist(c: Capsule, x: number, y: number): number {
  return Math.sqrt(segDist2(x, y, c.x1, c.y1, c.x2, c.y2)) - c.r;
}

/** Squared distance between segments p and q. */
function segSegDist2(
  px1: number, py1: number, px2: number, py2: number,
  qx1: number, qy1: number, qx2: number, qy2: number,
): number {
  // Proper crossing: distance is zero.
  const d1 = (qx2 - qx1) * (py1 - qy1) - (qy2 - qy1) * (px1 - qx1);
  const d2 = (qx2 - qx1) * (py2 - qy1) - (qy2 - qy1) * (px2 - qx1);
  const d3 = (px2 - px1) * (qy1 - py1) - (py2 - py1) * (qx1 - px1);
  const d4 = (px2 - px1) * (qy2 - py1) - (py2 - py1) * (qx2 - px1);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    segDist2(px1, py1, qx1, qy1, qx2, qy2),
    segDist2(px2, py2, qx1, qy1, qx2, qy2),
    segDist2(qx1, qy1, px1, py1, px2, py2),
    segDist2(qx2, qy2, px1, py1, px2, py2),
  );
}

/** World px between samples of the rock distance grid. */
export const ROCK_RES = 8;
/** distances are only exact this far from a rock edge; deeper reads clamp */
const ROCK_PAD = 96;

/** Signed distance to cave rock on a grid (positive in the open). */
export interface RockGrid {
  cols: number;
  rows: number;
  d: Float32Array;
}

const rockCache = new WeakMap<CaveSpec, RockGrid>();
/** A cave's rock-zone distances, kept by the zone itself: caves that only differ in their carves share it. */
const zoneCache = new WeakMap<Capsule[], { cols: number; rows: number; d: Float32Array }>();

/** Min signed capsule distance per grid point, within ROCK_PAD of each capsule. */
function unionDist(caps: Capsule[], cols: number, rows: number): Float32Array {
  const g = new Float32Array(cols * rows).fill(ROCK_PAD);
  for (const c of caps) {
    const R = c.r + ROCK_PAD;
    const x0 = Math.max(0, Math.floor((Math.min(c.x1, c.x2) - R) / ROCK_RES));
    const x1 = Math.min(cols - 1, Math.ceil((Math.max(c.x1, c.x2) + R) / ROCK_RES));
    const y0 = Math.max(0, Math.floor((Math.min(c.y1, c.y2) - R) / ROCK_RES));
    const y1 = Math.min(rows - 1, Math.ceil((Math.max(c.y1, c.y2) + R) / ROCK_RES));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * cols + x;
        const d = capsuleDist(c, x * ROCK_RES, y * ROCK_RES);
        if (d < g[k]) g[k] = d;
      }
    }
  }
  return g;
}

/** The rock distance grid for a cave, built once per spec and shared (sim, mapgen, renderer). */
export function rockGrid(cave: CaveSpec, width: number, height: number): RockGrid {
  const hit = rockCache.get(cave);
  if (hit) return hit;
  const cols = Math.ceil(width / ROCK_RES) + 1, rows = Math.ceil(height / ROCK_RES) + 1;
  const open = unionDist(cave.carves, cols, rows);
  let zone: Float32Array | null = null;
  if (cave.zone) {
    const z = zoneCache.get(cave.zone);
    zone = z && z.cols === cols && z.rows === rows ? z.d : unionDist(cave.zone, cols, rows);
    zoneCache.set(cave.zone, { cols, rows, d: zone });
  }
  // Rock = zone minus carves. Its signed distance (negative inside rock) is
  // the max of the zone's and the carves' inverted one: positive in the open.
  const d = new Float32Array(cols * rows);
  for (let k = 0; k < d.length; k++) d[k] = Math.max(zone ? zone[k] : -ROCK_PAD, -open[k]);
  if (cave.fill?.length) {
    const fill = unionDist(cave.fill, cols, rows);
    for (let k = 0; k < d.length; k++) if (fill[k] < d[k]) d[k] = fill[k];
  }
  const g = { cols, rows, d };
  rockCache.set(cave, g);
  return g;
}

/** Bilinear sample of a rock grid at a world point. */
export function sampleRock(g: RockGrid, x: number, y: number): number {
  let fx = x / ROCK_RES, fy = y / ROCK_RES;
  fx = fx < 0 ? 0 : fx > g.cols - 1.001 ? g.cols - 1.001 : fx;
  fy = fy < 0 ? 0 : fy > g.rows - 1.001 ? g.rows - 1.001 : fy;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const ax = fx - x0, ay = fy - y0;
  const k = y0 * g.cols + x0;
  const d = g.d;
  const top = d[k] + (d[k + 1] - d[k]) * ax;
  const bot = d[k + g.cols] + (d[k + g.cols + 1] - d[k + g.cols]) * ax;
  return top + (bot - top) * ay;
}

// Neighbor offsets: 4 orthogonal, then 4 diagonal.
const NX = [1, -1, 0, 0, 1, -1, 1, -1];
const NY = [0, 0, 1, -1, 1, 1, -1, -1];
/** neighbor index pointing the opposite way */
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const INV_SQRT2 = 0.7071067811865476;
const DIR_X = NX.map((v, k) => (k < 4 ? v : v * INV_SQRT2));
const DIR_Y = NY.map((v, k) => (k < 4 ? v : v * INV_SQRT2));
/** dir code: head straight at the target */
const STRAIGHT = 8;
const NONE = 255;
const UNREACHED = 0x7fffffff;

export interface FlowField {
  target: number;
  /** path cost to the target, in tenths of a tile (UNREACHED if none) */
  dist: Int32Array;
  /** next step per tile: neighbor index 0..7, STRAIGHT, or NONE */
  dir: Uint8Array;
  used: number;
}

export class Terrain {
  readonly spec: TerrainSpec;
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  readonly flags: Uint8Array;
  readonly hasWalls: boolean;
  /** walls, nebula or rifts: units need flow fields */
  readonly hasPaths: boolean;
  readonly hasFields: boolean;
  /** cave rock distance grid, or null on open maps */
  readonly rock: RockGrid | null;

  // Walls bucketed per spatial CELL (CSR), for collision and line of sight.
  private readonly ccols: number;
  private readonly crows: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  private readonly cache = new Map<number, FlowField>();
  private readonly heapK: Int32Array;
  private readonly heapV: Int32Array;

  /** outputs of collide() and steer() */
  ox = 0;
  oy = 0;

  constructor(spec: TerrainSpec, width: number, height: number) {
    this.spec = spec;
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / TILE);
    this.rows = Math.ceil(height / TILE);
    this.flags = new Uint8Array(this.cols * this.rows);
    this.rock = spec.cave ? rockGrid(spec.cave, width, height) : null;
    this.hasWalls = spec.walls.length > 0 || !!this.rock;
    this.hasFields = spec.fields.length > 0;
    this.hasPaths = this.hasWalls || this.hasFields;

    for (const c of spec.walls) this.raster(c, TERRAIN.wallMargin, T_BLOCK);
    if (this.rock) {
      for (let ty = 0; ty < this.rows; ty++) {
        for (let tx = 0; tx < this.cols; tx++) {
          if (sampleRock(this.rock, (tx + 0.5) * TILE, (ty + 0.5) * TILE) < TERRAIN.wallMargin) this.flags[ty * this.cols + tx] |= T_BLOCK;
        }
      }
    }
    for (const f of spec.fields) {
      this.raster(f, 0, f.kind === 'nebula' ? T_NEBULA : T_RIFT);
      if (f.kind === 'rift' && f.r > TERRAIN.riftWide) this.raster(f, -TERRAIN.riftDeep, T_DEEP);
    }

    this.ccols = Math.ceil(width / CELL) + 1;
    this.crows = Math.ceil(height / CELL) + 1;
    const nc = this.ccols * this.crows;
    const lists: number[][] = Array.from({ length: nc }, () => []);
    const pad = TERRAIN.maxUnitRadius;
    spec.walls.forEach((c, k) => {
      const x0 = this.ccx(Math.min(c.x1, c.x2) - c.r - pad), x1 = this.ccx(Math.max(c.x1, c.x2) + c.r + pad);
      const y0 = this.ccy(Math.min(c.y1, c.y2) - c.r - pad), y1 = this.ccy(Math.max(c.y1, c.y2) + c.r + pad);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) lists[cy * this.ccols + cx].push(k);
    });
    this.cellStart = new Int32Array(nc + 1);
    for (let c = 0; c < nc; c++) this.cellStart[c + 1] = this.cellStart[c] + lists[c].length;
    this.cellItems = new Int32Array(this.cellStart[nc]);
    for (let c = 0; c < nc; c++) this.cellItems.set(lists[c], this.cellStart[c]);

    const n = this.cols * this.rows;
    this.heapK = new Int32Array(n * 8 + 16);
    this.heapV = new Int32Array(n * 8 + 16);
  }

  /** Flag every tile whose center lies within the capsule (grown by margin). */
  private raster(c: Capsule, margin: number, bit: number): void {
    const R = c.r + margin;
    const tx0 = Math.max(0, Math.floor((Math.min(c.x1, c.x2) - R) / TILE));
    const tx1 = Math.min(this.cols - 1, Math.floor((Math.max(c.x1, c.x2) + R) / TILE));
    const ty0 = Math.max(0, Math.floor((Math.min(c.y1, c.y2) - R) / TILE));
    const ty1 = Math.min(this.rows - 1, Math.floor((Math.max(c.y1, c.y2) + R) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const d2 = segDist2((tx + 0.5) * TILE, (ty + 0.5) * TILE, c.x1, c.y1, c.x2, c.y2);
        if (d2 < R * R) this.flags[ty * this.cols + tx] |= bit;
      }
    }
  }

  private ccx(x: number): number {
    const c = Math.floor(x / CELL);
    return c < 0 ? 0 : c >= this.ccols ? this.ccols - 1 : c;
  }

  private ccy(y: number): number {
    const c = Math.floor(y / CELL);
    return c < 0 ? 0 : c >= this.crows ? this.crows - 1 : c;
  }

  tileOf(x: number, y: number): number {
    let tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    tx = tx < 0 ? 0 : tx >= this.cols ? this.cols - 1 : tx;
    ty = ty < 0 ? 0 : ty >= this.rows ? this.rows - 1 : ty;
    return ty * this.cols + tx;
  }

  flagsAt(x: number, y: number): number {
    return this.flags[this.tileOf(x, y)];
  }

  /**
   * Push a disc of radius rad out of any wall it overlaps. Returns true if it
   * moved; the corrected position is in (ox, oy).
   */
  collide(x: number, y: number, rad: number): boolean {
    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      const c = this.ccy(y) * this.ccols + this.ccx(x);
      let hit = false;
      for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
        const w = this.spec.walls[this.cellItems[k]];
        const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - w.x1) * dx + (y - w.y1) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = w.x1 + dx * t, qy = w.y1 + dy * t;
        const ex = x - qx, ey = y - qy;
        const R = w.r + rad;
        const d2 = ex * ex + ey * ey;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-9) {
          x = qx + (ex / d) * R;
          y = qy + (ey / d) * R;
        } else {
          // Dead center on the spine: push out sideways from the segment.
          const l = Math.sqrt(l2) || 1;
          x = qx - (dy / l) * R;
          y = qy + (dx / l) * R;
          if (l2 === 0) x = qx + R;
        }
        hit = moved = true;
      }
      const g = this.rock;
      if (g) {
        // Cave rock: push out along the distance gradient.
        const d = sampleRock(g, x, y);
        if (d < rad) {
          const h = ROCK_RES * 0.5;
          const gx = sampleRock(g, x + h, y) - sampleRock(g, x - h, y);
          const gy = sampleRock(g, x, y + h) - sampleRock(g, x, y - h);
          const l = Math.sqrt(gx * gx + gy * gy);
          if (l > 1e-9) {
            x += (gx / l) * (rad - d);
            y += (gy / l) * (rad - d);
            hit = moved = true;
          }
        }
      }
      if (!hit) break;
    }
    this.ox = x;
    this.oy = y;
    return moved;
  }

  /** Signed distance to cave rock at a point (Infinity on open maps). */
  rockDist(x: number, y: number): number {
    return this.rock ? sampleRock(this.rock, x, y) : Infinity;
  }

  /** Distance from a point to the nearest wall or rock edge (negative inside). For mapgen. */
  clearance(x: number, y: number): number {
    let d = this.rockDist(x, y);
    for (const c of this.spec.walls) d = Math.min(d, capsuleDist(c, x, y));
    return d;
  }

  /** Nearest point at least `clear` from every wall (for order points, blinks). */
  freePoint(x: number, y: number, clear = 8): [number, number] {
    if (!this.hasWalls) return [x, y];
    if (this.rock && sampleRock(this.rock, x, y) < 0) {
      // Inside cave rock (maybe deeper than the distance grid reaches): start
      // from the nearest open tile instead.
      const t = this.nearestFree(this.tileOf(x, y));
      x = ((t % this.cols) + 0.5) * TILE;
      y = (((t / this.cols) | 0) + 0.5) * TILE;
    }
    this.collide(x, y, clear);
    return [this.ox, this.oy];
  }

  /** True if no wall blocks the segment between the two points. */
  los(x1: number, y1: number, x2: number, y2: number): boolean {
    const cx0 = this.ccx(Math.min(x1, x2)), cx1 = this.ccx(Math.max(x1, x2));
    const cy0 = this.ccy(Math.min(y1, y2)), cy1 = this.ccy(Math.max(y1, y2));
    const shrink = TERRAIN.losGrace;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.ccols + cx;
        for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
          const w = this.spec.walls[this.cellItems[k]];
          const R = w.r - shrink;
          if (R <= 0) continue;
          if (segSegDist2(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2) < R * R) return false;
        }
      }
    }
    const g = this.rock;
    if (g) {
      // March the segment, stepping by the distance to the nearest rock.
      const dx = x2 - x1, dy = y2 - y1;
      const L = Math.sqrt(dx * dx + dy * dy);
      for (let t = 0; ; ) {
        const f = L > 0 ? t / L : 0;
        const d = sampleRock(g, x1 + dx * f, y1 + dy * f);
        if (d < -shrink) return false;
        if (t >= L) break;
        t = Math.min(L, t + Math.max(2, (d + shrink) * 0.7));
      }
    }
    return true;
  }

  /** Any wall stored near this point? Cheap pre-check for los(). */
  wallsNear(x1: number, y1: number, x2: number, y2: number): boolean {
    if (this.rock) return true;
    const cx0 = this.ccx(Math.min(x1, x2)), cx1 = this.ccx(Math.max(x1, x2));
    const cy0 = this.ccy(Math.min(y1, y2)), cy1 = this.ccy(Math.max(y1, y2));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.ccols + cx;
        if (this.cellStart[c + 1] > this.cellStart[c]) return true;
      }
    }
    return false;
  }

  /** Nearest pathable tile to t (t itself if free), by ring search. */
  private nearestFree(t: number): number {
    if (!(this.flags[t] & T_BLOCK)) return t;
    const tx = t % this.cols, ty = (t / this.cols) | 0;
    for (let r = 1; r < Math.max(this.cols, this.rows); r++) {
      let best = -1, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
          const k = y * this.cols + x;
          if (this.flags[k] & T_BLOCK) continue;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = k;
          }
        }
      }
      if (best >= 0) return best;
    }
    return t;
  }

  /** Movement cost multiplier (x10) for entering a tile. */
  private cost(t: number, diag: boolean): number {
    const f = this.flags[t];
    const m = f & T_DEEP ? TERRAIN.riftDeepCost : f & T_RIFT ? TERRAIN.riftCost : f & T_NEBULA ? TERRAIN.nebulaCost : 1;
    return Math.round((diag ? 14 : 10) * m);
  }

  /** The flow field toward tile `target`, built on first use. */
  field(target: number, tick: number): FlowField {
    let f = this.cache.get(target);
    if (f) {
      f.used = tick;
      return f;
    }
    if (this.cache.size >= TERRAIN.maxFields) this.evict();
    f = this.build(target);
    f.used = tick;
    this.cache.set(target, f);
    return f;
  }

  private evict(): void {
    // Drop the least recently used quarter. Fields are pure functions of the
    // terrain, so which ones get dropped never affects the simulation.
    const all = [...this.cache.values()].sort((a, b) => a.used - b.used);
    for (let k = 0; k < all.length / 4; k++) this.cache.delete(all[k].target);
  }

  private build(target: number): FlowField {
    const { cols, rows, flags } = this;
    const n = cols * rows;
    const dist = new Int32Array(n).fill(UNREACHED);
    const dir = new Uint8Array(n).fill(NONE);
    const seed = this.nearestFree(target);
    const hk = this.heapK, hv = this.heapV;
    let size = 0;
    const push = (k: number, v: number) => {
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] < k || (hk[p] === k && hv[p] <= v)) break;
        hk[i] = hk[p];
        hv[i] = hv[p];
        i = p;
      }
      hk[i] = k;
      hv[i] = v;
    };
    const pop = (): number => {
      const v = hv[0];
      const k = hk[--size], kv = hv[size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && (hk[c + 1] < hk[c] || (hk[c + 1] === hk[c] && hv[c + 1] < hv[c]))) c++;
        if (hk[c] > k || (hk[c] === k && hv[c] >= kv)) break;
        hk[i] = hk[c];
        hv[i] = hv[c];
        i = c;
      }
      hk[i] = k;
      hv[i] = kv;
      return v;
    };

    dist[seed] = 0;
    dir[seed] = STRAIGHT;
    push(0, seed);
    while (size > 0) {
      const d0 = hk[0];
      const u = pop();
      if (d0 > dist[u]) continue;
      const ux = u % cols, uy = (u / cols) | 0;
      for (let k = 0; k < 8; k++) {
        const x = ux + NX[k], y = uy + NY[k];
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const v = y * cols + x;
        if (flags[v] & T_BLOCK) continue;
        // No corner cutting past walls.
        if (k >= 4 && (flags[uy * cols + x] & T_BLOCK || flags[y * cols + ux] & T_BLOCK)) continue;
        const nd = d0 + this.cost(v, k >= 4);
        if (nd < dist[v]) {
          dist[v] = nd;
          // v steps back toward u: the opposite of offset k.
          dir[v] = OPP[k];
          push(nd, v);
        }
      }
    }

    // Where the cheapest path is as cheap as open ground, nothing is in the
    // way: head straight for the target instead of zig-zagging on tiles. On
    // eight-way tiles a way round a field often costs no more than the line
    // itself, so with fields the line must also clear them (#58): a tile's
    // line is clear if it is off every field and the tiles the line passes
    // between next (straight on, and diagonally) are clear. Tiles are decided
    // ring by ring out from the target, so those are known.
    const sx = seed % cols, sy = (seed / cols) | 0;
    const FIELD = T_NEBULA | T_RIFT;
    let clear: Uint8Array | null = null;
    if (this.hasFields) {
      clear = new Uint8Array(n);
      const ring = (t: number) => Math.max(Math.abs((t % cols) - sx), Math.abs(((t / cols) | 0) - sy));
      const start = new Int32Array(Math.max(cols, rows) + 2);
      for (let t = 0; t < n; t++) start[ring(t) + 1]++;
      for (let r = 1; r < start.length; r++) start[r] += start[r - 1];
      const order = new Int32Array(n);
      for (let t = 0; t < n; t++) order[start[ring(t)]++] = t;
      clear[seed] = 1;
      for (let k = 0; k < n; k++) {
        const t = order[k];
        if (t === seed || flags[t] & FIELD) continue;
        const tx = t % cols, ty = (t / cols) | 0;
        const ax = Math.abs(sx - tx), ay = Math.abs(sy - ty), gx = Math.sign(sx - tx), gy = Math.sign(sy - ty);
        const diag = t + gy * cols + gx, on = ax > ay ? t + gx : ay > ax ? t + gy * cols : diag;
        if (clear[on] && (ax === 0 || ay === 0 || clear[diag])) clear[t] = 1;
      }
    }
    for (let t = 0; t < n; t++) {
      if (dist[t] === UNREACHED || t === seed || (clear && !clear[t])) continue;
      const dx = Math.abs((t % cols) - sx), dy = Math.abs(((t / cols) | 0) - sy);
      const open = 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
      if (dist[t] <= open) dir[t] = STRAIGHT;
    }
    return { target, dist, dir, used: 0 };
  }

  /**
   * Direction to walk from (x, y) toward (tx, ty), blended over the four
   * nearest tiles for smooth turns. Returns false to mean "go straight";
   * otherwise the unit vector is in (ox, oy).
   */
  steer(x: number, y: number, tx: number, ty: number, tick: number): boolean {
    const f = this.field(this.tileOf(tx, ty), tick);
    const fx = x / TILE - 0.5, fy = y / TILE - 0.5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    let sx = 0, sy = 0, straight = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const cx = x0 + (k & 1), cy = y0 + (k >> 1);
      if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) continue;
      const d = f.dir[cy * this.cols + cx];
      if (d === NONE) continue;
      const wt = (k & 1 ? ax : 1 - ax) * (k >> 1 ? ay : 1 - ay);
      if (wt <= 0) continue;
      wsum += wt;
      if (d === STRAIGHT) straight += wt;
      else {
        sx += DIR_X[d] * wt;
        sy += DIR_Y[d] * wt;
      }
    }
    if (wsum <= 0) {
      // Squeezed against a wall: step to the best open neighbor tile.
      const t = this.tileOf(x, y);
      const ux = t % this.cols, uy = (t / this.cols) | 0;
      let best = -1, bd = UNREACHED;
      for (let k = 0; k < 8; k++) {
        const nx = ux + NX[k], ny = uy + NY[k];
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const v = ny * this.cols + nx;
        if (f.dist[v] < bd) {
          bd = f.dist[v];
          best = v;
        }
      }
      if (best < 0) return false;
      const bx = ((best % this.cols) + 0.5) * TILE - x, by = (((best / this.cols) | 0) + 0.5) * TILE - y;
      const l = Math.sqrt(bx * bx + by * by) || 1;
      this.ox = bx / l;
      this.oy = by / l;
      return true;
    }
    if (straight >= wsum * 0.999) return false;
    if (straight > 0) {
      const dx = tx - x, dy = ty - y;
      const l = Math.sqrt(dx * dx + dy * dy) || 1;
      sx += (dx / l) * straight;
      sy += (dy / l) * straight;
    }
    const l = Math.sqrt(sx * sx + sy * sy);
    if (l < 1e-6) return false;
    this.ox = sx / l;
    this.oy = sy / l;
    return true;
  }

  /** Walking distance in px between two points (Infinity if cut off). */
  pathDist(fx: number, fy: number, tx: number, ty: number, tick: number): number {
    if (!this.hasPaths) return Math.sqrt((fx - tx) ** 2 + (fy - ty) ** 2);
    const f = this.field(this.tileOf(tx, ty), tick);
    const d = f.dist[this.nearestFreeIn(f, this.tileOf(fx, fy))];
    return d === UNREACHED ? Infinity : (d / 10) * TILE;
  }

  /**
   * The walking path from (fx, fy) toward (tx, ty), as flat x, y pairs about
   * a tile apart, stopping once it is maxPx long. For bots reading the map.
   */
  trace(fx: number, fy: number, tx: number, ty: number, tick: number, maxPx = Infinity): number[] {
    const out: number[] = [];
    const line = (x: number, y: number, len: number) => {
      const dx = tx - x, dy = ty - y;
      const L = Math.sqrt(dx * dx + dy * dy);
      for (let s = TILE; s < L && len + s <= maxPx; s += TILE) out.push(x + (dx * s) / L, y + (dy * s) / L);
      if (len + L <= maxPx) out.push(tx, ty);
    };
    if (!this.hasPaths) {
      out.push(fx, fy);
      line(fx, fy, 0);
      return out;
    }
    const f = this.field(this.tileOf(tx, ty), tick);
    let t = this.nearestFreeIn(f, this.tileOf(fx, fy));
    let len = 0;
    for (;;) {
      const x = ((t % this.cols) + 0.5) * TILE, y = (((t / this.cols) | 0) + 0.5) * TILE;
      out.push(x, y);
      const d = f.dir[t];
      if (d === STRAIGHT) {
        line(x, y, len);
        return out;
      }
      if (d === NONE || len >= maxPx) return out;
      t += NY[d] * this.cols + NX[d];
      len += d >= 4 ? TILE * 1.4142135623730951 : TILE;
    }
  }

  private nearestFreeIn(f: FlowField, t: number): number {
    return f.dist[t] !== UNREACHED ? t : this.nearestFree(t);
  }

  /** Tiles a walker can reach from (x, y), 4-connected. */
  private reach(x: number, y: number): Uint8Array {
    const n = this.cols * this.rows;
    const seen = new Uint8Array(n);
    const start = this.nearestFree(this.tileOf(x, y));
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const u = queue[head++];
      const ux = u % this.cols, uy = (u / this.cols) | 0;
      for (let k = 0; k < 4; k++) {
        const x = ux + NX[k], y = uy + NY[k];
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
        const v = y * this.cols + x;
        if (seen[v] || this.flags[v] & T_BLOCK) continue;
        seen[v] = 1;
        queue[tail++] = v;
      }
    }
    return seen;
  }

  /** Is every listed point reachable from the first? (mapgen validation) */
  connected(points: readonly [number, number][]): boolean {
    if (points.length < 2) return true;
    const seen = this.reach(points[0][0], points[0][1]);
    for (const [x, y] of points) {
      const t = this.tileOf(x, y);
      if (this.flags[t] & T_BLOCK || !seen[t]) return false;
    }
    return true;
  }

  /**
   * Open ground nobody can walk to from (x, y), as runs of tiles along each
   * row: [x1, x2, y] tile centers, px. For mapgen to fill in (#98).
   */
  cutOff(x: number, y: number): [number, number, number][] {
    const seen = this.reach(x, y);
    const out: [number, number, number][] = [];
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; ) {
        const k = ty * this.cols + tx;
        if (seen[k] || this.flags[k] & T_BLOCK) {
          tx++;
          continue;
        }
        let e = tx;
        while (e + 1 < this.cols && !seen[k + e + 1 - tx] && !(this.flags[k + e + 1 - tx] & T_BLOCK)) e++;
        out.push([(tx + 0.5) * TILE, (e + 0.5) * TILE, (ty + 0.5) * TILE]);
        tx = e + 1;
      }
    }
    return out;
  }
}
