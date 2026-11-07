import { clamp } from '../sim/mathx';

/** Quarter turns: cos and sin of 0°, 90°, 180°, 270°. */
const COS = [1, 0, -1, 0], SIN = [0, 1, 0, -1];

/**
 * 2D camera. Positions are world units; view size is device pixels. The view
 * can be turned in quarter turns (#98): a map's shape comes from its seed, so
 * the camera lays its long side along the screen's and puts your start at the
 * bottom (upright screens) or the left (wide ones).
 */
export class Camera {
  cx = 0;
  cy = 0;
  /** quarter turns clockwise on screen, 0..3 */
  turn = 0;
  /** your start (world), which the turn puts bottom or left; null: no preference */
  private home: [number, number] | null = null;
  /** device pixels per world unit */
  zoom = 1;
  viewW = 1;
  viewH = 1;
  mapW = 1;
  mapH = 1;
  fitZoom = 1;
  /** device px of the view covered by HUD along each edge; fit and panning work in what's left */
  inset = { top: 0, right: 0, bottom: 0, left: 0 };
  /** device px of empty space allowed beyond a map edge, at least */
  edgePad = 40;
  /**
   * A view set by the game (the fitted map, the opening view on your home),
   * kept as a point and a zoom relative to the fit: re-applied when the HUD
   * changes size, until the player moves the camera.
   */
  private anchor: { x: number; y: number; k: number } | null = null;
  shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  setView(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.chooseTurn();
    this.computeFit();
    this.zoom = clamp(this.zoom, this.fitZoom * 0.7, this.fitZoom * 5);
    // Rotating a phone keeps a held view (fitted map, opening view) aimed.
    if (this.anchor) this.place(this.anchor.x, this.anchor.y, this.fitZoom * this.anchor.k);
  }

  setMap(w: number, h: number, home: [number, number] | null = null): void {
    this.mapW = w;
    this.mapH = h;
    this.home = home;
    this.chooseTurn();
    this.computeFit();
  }

  /**
   * Lay the map's long side along the screen's (a near-square map may take
   * any turn), then of those turns pick the one that puts home toward the
   * bottom of an upright screen or the left of a wide one.
   */
  private chooseTurn(): void {
    const upright = this.visH > this.visW;
    const ratio = Math.max(this.mapW, this.mapH) / Math.min(this.mapW, this.mapH);
    const wide = this.mapW >= this.mapH;
    // Even turns keep the map's long side where it is; odd turns swap it.
    const turns = ratio < 1.15 ? [0, 1, 2, 3] : wide !== upright ? [0, 2] : [1, 3];
    const want: [number, number] = upright ? [0, 1] : [-1, 0];
    let best = turns[0], score = -Infinity;
    for (const t of turns) {
      let sc = 0;
      if (this.home) {
        const dx = this.home[0] - this.mapW / 2, dy = this.home[1] - this.mapH / 2;
        sc = (COS[t] * dx - SIN[t] * dy) * want[0] + (SIN[t] * dx + COS[t] * dy) * want[1];
      } else sc = -t; // no home: the fewest turns
      if (sc > score + 1e-6) {
        score = sc;
        best = t;
      }
    }
    this.turn = best;
  }

  /** The map's extent along the screen's x and y (swapped on an odd turn). */
  private get spanX(): number {
    return this.turn % 2 ? this.mapH : this.mapW;
  }

  private get spanY(): number {
    return this.turn % 2 ? this.mapW : this.mapH;
  }

  /** Update the HUD insets (device px). Returns true if they changed. */
  setInsets(top: number, bottom: number, left = 0, right = 0): boolean {
    const i = this.inset;
    if (i.top === top && i.bottom === bottom && i.left === left && i.right === right) return false;
    this.inset = { top, right, bottom, left };
    const a = this.anchor;
    if (a) {
      this.computeFit();
      this.place(a.x, a.y, this.fitZoom * a.k);
      return true;
    }
    this.computeFit();
    this.zoom = clamp(this.zoom, this.fitZoom * 0.7, this.fitZoom * 5);
    this.clampPos();
    return true;
  }

  /** Size of the part of the view the HUD doesn't cover. */
  private get visW(): number {
    return Math.max(1, this.viewW - this.inset.left - this.inset.right);
  }

  private get visH(): number {
    return Math.max(1, this.viewH - this.inset.top - this.inset.bottom);
  }

  private computeFit(): void {
    this.fitZoom = Math.min(this.visW / this.spanX, this.visH / this.spanY) * 0.94;
  }

  /** Whole map, centered in the visible area. */
  fit(): void {
    this.computeFit();
    this.place(this.mapW / 2, this.mapH / 2, this.fitZoom);
    this.anchor = { x: this.mapW / 2, y: this.mapH / 2, k: 1 };
  }

  /**
   * Opening view of a match: centered on (x, y), zoomed so dots read at a
   * comfortable size (`cssPerUnit` CSS px per world unit, so phones zoom in
   * more), within kMin..kMax of the fit. Held until the player pans or zooms.
   */
  open(x: number, y: number, dpr: number, cssPerUnit = 0.75, kMin = 1.3, kMax = 1.8): void {
    this.computeFit();
    const k = clamp((dpr * cssPerUnit) / this.fitZoom, kMin, kMax);
    this.place(x, y, this.fitZoom * k);
    this.anchor = { x, y, k };
  }

  private place(x: number, y: number, zoom: number): void {
    this.zoom = clamp(zoom, this.fitZoom * 0.7, this.fitZoom * 5);
    this.cx = x;
    this.cy = y;
    this.clampPos();
  }

  /** Center on a world point (optionally at a new zoom); leaves the fitted view. */
  focus(x: number, y: number, zoom = this.zoom): void {
    this.anchor = null;
    this.place(x, y, zoom);
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    this.anchor = null;
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.fitZoom * 0.7, this.fitZoom * 5);
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
    this.clampPos();
  }

  pan(dxPx: number, dyPx: number): void {
    this.anchor = null;
    const c = COS[this.turn], s = SIN[this.turn];
    this.cx -= (c * dxPx + s * dyPx) / this.zoom;
    this.cy -= (-s * dxPx + c * dyPx) / this.zoom;
    this.clampPos();
  }

  /**
   * Keep the map in view, but let every edge be panned fully clear of the HUD
   * with some empty space beyond it (#36). A map smaller than the visible
   * area stays centered in it.
   */
  clampPos(): void {
    const pad = Math.max(120 * this.zoom, this.edgePad);
    const axis = (c: number, map: number, view: number, lo: number, hi: number) => {
      // Map start at screen (lo + pad), or map end at screen (view - hi - pad).
      const min = (view / 2 - lo - pad) / this.zoom;
      const max = map - (view / 2 - hi - pad) / this.zoom;
      return min > max ? (min + max) / 2 : clamp(c, min, max);
    };
    // Clamp along the screen's axes: the center's offset from the map's
    // middle, turned onto the screen, then back.
    const co = COS[this.turn], si = SIN[this.turn];
    const dx = this.cx - this.mapW / 2, dy = this.cy - this.mapH / 2;
    const ux = axis(co * dx - si * dy + this.spanX / 2, this.spanX, this.viewW, this.inset.left, this.inset.right) - this.spanX / 2;
    const uy = axis(si * dx + co * dy + this.spanY / 2, this.spanY, this.viewH, this.inset.top, this.inset.bottom) - this.spanY / 2;
    this.cx = this.mapW / 2 + co * ux + si * uy;
    this.cy = this.mapH / 2 - si * ux + co * uy;
  }

  update(dt: number, t: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 14;
    this.shakeX = Math.sin(t * 61.3) * s;
    this.shakeY = Math.cos(t * 47.9) * s;
  }

  /** device px -> world */
  toWorld(sx: number, sy: number): [number, number] {
    const c = COS[this.turn], s = SIN[this.turn];
    const dx = (sx - this.viewW / 2) / this.zoom, dy = (sy - this.viewH / 2) / this.zoom;
    return [this.cx + c * dx + s * dy, this.cy - s * dx + c * dy];
  }

  toScreen(wx: number, wy: number): [number, number] {
    const c = COS[this.turn], s = SIN[this.turn];
    const dx = wx - this.cx, dy = wy - this.cy;
    return [(c * dx - s * dy) * this.zoom + this.viewW / 2, (s * dx + c * dy) * this.zoom + this.viewH / 2];
  }

  /** The turn's angle (radians, clockwise on screen). */
  get angle(): number {
    return (this.turn * Math.PI) / 2;
  }

  /** u_rot uniform: cos and sin of the turn */
  rot(out: Float32Array): Float32Array {
    out[0] = COS[this.turn];
    out[1] = SIN[this.turn];
    return out;
  }

  /** u_cam uniform: (cx, cy, sx, sy) with shake */
  uniform(out: Float32Array): Float32Array {
    out[0] = this.cx + this.shakeX / this.zoom;
    out[1] = this.cy + this.shakeY / this.zoom;
    out[2] = (2 * this.zoom) / this.viewW;
    out[3] = (-2 * this.zoom) / this.viewH;
    return out;
  }
}
