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

  private computeFit(): void {
    this.fitZoom = Math.min(this.viewW / this.mapW, this.viewH / this.mapH) * 0.94;
  }

  fit(): void {
    this.computeFit();
    this.zoom = this.fitZoom;
    this.cx = this.mapW / 2;
    this.cy = this.mapH / 2;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.fitZoom * 0.7, this.fitZoom * 5);
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
    this.clampPos();
  }

  pan(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.zoom;
    this.cy -= dyPx / this.zoom;
    this.clampPos();
  }

  clampPos(): void {
    const mx = Math.max(0, this.mapW / 2 - this.viewW / this.zoom / 2 + 120);
    const my = Math.max(0, this.mapH / 2 - this.viewH / this.zoom / 2 + 120);
    this.cx = clamp(this.cx, this.mapW / 2 - mx, this.mapW / 2 + mx);
    this.cy = clamp(this.cy, this.mapH / 2 - my, this.mapH / 2 + my);
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
