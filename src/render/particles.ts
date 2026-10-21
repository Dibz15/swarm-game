import type { RGB } from '../content/factions';
import type { Renderer } from './renderer';

const CAP = 8000;

/** Client-only cosmetic particles (death pops, captures). Not part of the sim. */
export class Particles {
  private x = new Float32Array(CAP);
  private y = new Float32Array(CAP);
  private vx = new Float32Array(CAP);
  private vy = new Float32Array(CAP);
  private life = new Float32Array(CAP);
  private max = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private col = new Uint8Array(CAP * 3);
  private n = 0;

  burst(x: number, y: number, c: RGB, count: number, speed: number, size = 2.2, life = 0.6): void {
    for (let k = 0; k < count; k++) {
      if (this.n >= CAP) return;
      const i = this.n++;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = Math.cos(a) * s;
      this.vy[i] = Math.sin(a) * s;
      this.max[i] = this.life[i] = life * (0.6 + Math.random() * 0.6);
      this.size[i] = size * (0.6 + Math.random() * 0.6);
      this.col[i * 3] = c[0];
      this.col[i * 3 + 1] = c[1];
      this.col[i * 3 + 2] = c[2];
    }
  }

  update(dt: number): void {
    const damp = Math.exp(-dt * 4);
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        const last = --this.n;
        this.x[i] = this.x[last];
        this.y[i] = this.y[last];
        this.vx[i] = this.vx[last];
        this.vy[i] = this.vy[last];
        this.life[i] = this.life[last];
        this.max[i] = this.max[last];
        this.size[i] = this.size[last];
        this.col[i * 3] = this.col[last * 3];
        this.col[i * 3 + 1] = this.col[last * 3 + 1];
        this.col[i * 3 + 2] = this.col[last * 3 + 2];
        continue;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.vx[i] *= damp;
      this.vy[i] *= damp;
      i++;
    }
  }

  draw(r: Renderer): void {
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.max[i];
      r.unit(this.x[i], this.y[i], this.size[i] * (0.4 + 0.6 * t), this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2], Math.round(255 * t));
    }
  }

  clear(): void {
    this.n = 0;
  }
}

export interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  t: number;
  dur: number;
  c: RGB;
  thick: number;
  /** filled flash instead of ring */
  disc?: boolean;
  alpha?: number;
}

export class Rings {
  list: Ring[] = [];

  add(ring: Omit<Ring, 't'>): void {
    this.list.push({ ...ring, t: 0 });
  }

  update(dt: number): void {
    for (const r of this.list) r.t += dt;
    this.list = this.list.filter((r) => r.t < r.dur);
  }

  draw(rd: Renderer): void {
    for (const r of this.list) {
      const k = r.t / r.dur;
      const e = 1 - (1 - k) * (1 - k);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      const a = Math.round(255 * (1 - k) * (r.alpha ?? 1));
      if (r.disc) rd.shape(true, r.x, r.y, rad, 7, 1, 0, 0, r.c, Math.round(a * 0.35));
      else rd.shape(true, r.x, r.y, rad, 0, 1, 0, r.thick / Math.max(rad, 1), r.c, a);
    }
  }
}
