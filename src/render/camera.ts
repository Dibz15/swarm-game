import { clamp } from '../sim/mathx';

/** 2D camera. Positions are world units; view size is device pixels. */
export class Camera {
  cx = 0;
  cy = 0;
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
  /** showing the fitted view, untouched since: refit when the HUD changes size */
  private fitted = false;
  shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  setView(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.computeFit();
    this.zoom = clamp(this.zoom, this.fitZoom * 0.7, this.fitZoom * 5);
  }

  setMap(w: number, h: number): void {
    this.mapW = w;
    this.mapH = h;
    this.computeFit();
  }

  /** Update the HUD insets (device px). Returns true if they changed. */
  setInsets(top: number, bottom: number, left = 0, right = 0): boolean {
    const i = this.inset;
    if (i.top === top && i.bottom === bottom && i.left === left && i.right === right) return false;
    this.inset = { top, right, bottom, left };
    if (this.fitted) {
      this.fit();
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
    this.fitZoom = Math.min(this.visW / this.mapW, this.visH / this.mapH) * 0.94;
  }

  /** Whole map, centered in the visible area. */
  fit(): void {
    this.computeFit();
    this.zoom = this.fitZoom;
    this.cx = this.mapW / 2;
    this.cy = this.mapH / 2;
    this.clampPos();
    this.fitted = true;
  }

  /** Center on a world point (optionally at a new zoom); leaves the fitted view. */
  focus(x: number, y: number, zoom = this.zoom): void {
    this.fitted = false;
    this.zoom = clamp(zoom, this.fitZoom * 0.7, this.fitZoom * 5);
    this.cx = x;
    this.cy = y;
    this.clampPos();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    this.fitted = false;
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.fitZoom * 0.7, this.fitZoom * 5);
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
    this.clampPos();
  }

  pan(dxPx: number, dyPx: number): void {
    this.fitted = false;
    this.cx -= dxPx / this.zoom;
    this.cy -= dyPx / this.zoom;
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
    this.cx = axis(this.cx, this.mapW, this.viewW, this.inset.left, this.inset.right);
    this.cy = axis(this.cy, this.mapH, this.viewH, this.inset.top, this.inset.bottom);
  }

  update(dt: number, t: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 14;
    this.shakeX = Math.sin(t * 61.3) * s;
    this.shakeY = Math.cos(t * 47.9) * s;
  }

  /** device px -> world */
  toWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.viewW / 2) / this.zoom, this.cy + (sy - this.viewH / 2) / this.zoom];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.cx) * this.zoom + this.viewW / 2, (wy - this.cy) * this.zoom + this.viewH / 2];
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
