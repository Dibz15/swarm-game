import { CELL, MAX_UNITS, NUM_FACTIONS } from './constants';
import type { World } from './world';

/**
 * Uniform grid rebuilt every tick with a counting sort: O(n), no allocation.
 * Units in cell c are items[start[c] .. start[c+1]).
 */
export class Grid {
  readonly cs: number;
  readonly cols: number;
  readonly rows: number;
  readonly start: Int32Array;
  readonly items = new Int32Array(MAX_UNITS);
  /**
   * Bit f set when a unit of faction f is in the cell, so a scan for enemies
   * can skip cells holding only allies. A superset: units that died since
   * the build stay counted, and a slot reused mid-tick adds its new owner
   * (see `touch`).
   */
  readonly factions: Uint8Array;
  /**
   * The same units again, listed by cell and then faction: faction f of cell
   * c is byFaction[fstart[c * NUM_FACTIONS + f] .. fstart[c * NUM_FACTIONS + f + 1]).
   * Each list keeps the slot order of `items`, so walking one faction's list
   * meets that faction's units in the order a walk of the whole cell would.
   */
  readonly fstart: Int32Array;
  readonly byFaction = new Int32Array(MAX_UNITS);
  /** cells where a slot changed owner since the build: their faction lists are out of date */
  readonly stale: Uint8Array;
  private readonly cursor: Int32Array;
  private readonly fcursor: Int32Array;
  private readonly cellOf = new Int32Array(MAX_UNITS);
  /** units below this slot were placed by the last build (others aren't in the grid) */
  private builtN = 0;

  constructor(width: number, height: number, cs = CELL) {
    this.cs = cs;
    this.cols = Math.ceil(width / cs) + 1;
    this.rows = Math.ceil(height / cs) + 1;
    this.start = new Int32Array(this.cols * this.rows + 1);
    this.cursor = new Int32Array(this.cols * this.rows);
    this.factions = new Uint8Array(this.cols * this.rows);
    this.stale = new Uint8Array(this.cols * this.rows);
    this.fstart = new Int32Array(this.cols * this.rows * NUM_FACTIONS + 1);
    this.fcursor = new Int32Array(this.cols * this.rows * NUM_FACTIONS);
  }

  cx(x: number): number {
    const c = Math.floor(x / this.cs);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  cy(y: number): number {
    const c = Math.floor(y / this.cs);
    return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
  }

  build(w: World): void {
    const { start, cursor, cellOf, items, cols, factions, fstart, fcursor, byFaction } = this;
    start.fill(0);
    fstart.fill(0);
    factions.fill(0);
    this.stale.fill(0);
    const n = w.n;
    this.builtN = n;
    for (let i = 0; i < n; i++) {
      if (!w.alive[i]) {
        cellOf[i] = -1;
        continue;
      }
      const c = this.cy(w.y[i]) * cols + this.cx(w.x[i]);
      cellOf[i] = c;
      start[c + 1]++;
      fstart[c * NUM_FACTIONS + w.owner[i] + 1]++;
      factions[c] |= 1 << w.owner[i];
    }
    for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
    for (let c = 1; c < fstart.length; c++) fstart[c] += fstart[c - 1];
    cursor.set(start.subarray(0, cursor.length));
    fcursor.set(fstart.subarray(0, fcursor.length));
    for (let i = 0; i < n; i++) {
      if (!w.alive[i]) continue;
      items[cursor[cellOf[i]]++] = i;
      byFaction[fcursor[cellOf[i] * NUM_FACTIONS + w.owner[i]]++] = i;
    }
  }

  /**
   * Slot i was just given to a new unit of faction `owner`. If the slot is
   * still listed in a cell (its old unit died this tick), that cell may now
   * hold this faction too, and its faction lists no longer match.
   */
  touch(i: number, owner: number): void {
    if (i >= this.builtN || this.cellOf[i] < 0) return;
    this.factions[this.cellOf[i]] |= 1 << owner;
    this.stale[this.cellOf[i]] = 1;
  }
}

/** Push every alive unit within r of (x, y) into out. Returns out.length. */
export function queryRadius(w: World, x: number, y: number, r: number, out: number[]): number {
  out.length = 0;
  const g = w.grid;
  const r2 = r * r;
  const x0 = g.cx(x - r), x1 = g.cx(x + r);
  const y0 = g.cy(y - r), y1 = g.cy(y + r);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const c = cy * g.cols + cx;
      for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) {
        const j = g.items[k];
        if (!w.alive[j]) continue;
        const dx = w.x[j] - x, dy = w.y[j] - y;
        if (dx * dx + dy * dy <= r2) out.push(j);
      }
    }
  }
  return out.length;
}
