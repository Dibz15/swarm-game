import { CELL, MAX_UNITS } from './constants';
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
  private readonly cursor: Int32Array;
  private readonly cellOf = new Int32Array(MAX_UNITS);

  constructor(width: number, height: number, cs = CELL) {
    this.cs = cs;
    this.cols = Math.ceil(width / cs) + 1;
    this.rows = Math.ceil(height / cs) + 1;
    this.start = new Int32Array(this.cols * this.rows + 1);
    this.cursor = new Int32Array(this.cols * this.rows);
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
    const { start, cursor, cellOf, items, cols } = this;
    start.fill(0);
    const n = w.n;
    for (let i = 0; i < n; i++) {
      if (!w.alive[i]) continue;
      const c = this.cy(w.y[i]) * cols + this.cx(w.x[i]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
    cursor.set(start.subarray(0, cursor.length));
    for (let i = 0; i < n; i++) {
      if (!w.alive[i]) continue;
      items[cursor[cellOf[i]]++] = i;
    }
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
