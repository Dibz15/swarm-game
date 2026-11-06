/**
 * The Bloom in battle (#94): one organism with the run map's creeping field.
 * Its palette, its shared breath, its overgrown nests (tendrils, a pulsing
 * core, veins to the heart that wither when a nest falls) and the heart's own
 * body. Visual only: drawn from world state and client-side growth, never
 * touching the sim. No allocations per frame; everything goes through the
 * renderer's shape, beam and unit batches.
 */

import { mixRgb, WHITE, type RGB } from '../content/factions';
import { NEUTRAL } from '../sim/index';
import type { World } from '../sim/world';
import type { Renderer } from './renderer';

/** The Bloom's body: crimson-magenta, from the run map's edge, kept off the Magenta faction's pink. */
export const BLOOM_RGB: RGB = [214, 66, 116];
/** its dark flesh: veins, the heart's lobes */
export const BLOOM_DEEP: RGB = [116, 24, 60];
/** its glow: rims, spores, the light running along veins */
export const BLOOM_GLOW: RGB = [246, 138, 196];

const TAU = Math.PI * 2;

/** The heart's beat, 0..1 and sharp; faster each phase. */
export function heartBeat(w: World, time: number): number {
  const s = 0.5 + 0.5 * Math.sin(time * (2.4 + 1.2 * (w.heart?.phase ?? 0)));
  return s * s * s;
}

/** The Bloom's shared breath, 0..1: the heart's beat while it lives, else a slow swell. */
export function bloomBreath(w: World, time: number): number {
  return w.heart && !w.heart.slain ? heartBeat(w, time) : 0.5 + 0.5 * Math.sin(time * 1.6);
}

/** Nests the Bloom holds in this battle: the heart's and a siege's field nests. 1 = Bloom's. */
export function bloomNestMask(w: World): Uint8Array {
  const m = new Uint8Array(w.nests.length);
  for (const id of w.heart?.nests ?? []) m[id] = 1;
  for (const id of w.siege?.bloomNests ?? []) m[id] = 1;
  return m;
}

/** Where the growth on a Bloom nest is heading: full while the Bloom holds it (and the heart, if any, lives). */
export function growthTarget(w: World, id: number, mask: Uint8Array): number {
  if (!mask[id] || w.nests[id].owner !== NEUTRAL) return 0;
  return w.heart && w.heart.slain && !w.siege?.bloomNests.includes(id) ? 0 : 1;
}

export interface BloomView {
  /** 0..1 per nest: how overgrown it is (eases in and out client-side) */
  growth: Float32Array;
  /** time (s) a wave last swelled out of each nest, or -1 */
  swell: Float32Array;
}

/**
 * Overgrown Bloom nests and the veins that bind them to the heart. Drawn
 * under the units, over the nests.
 */
export function drawBloomNests(r: Renderer, w: World, v: BloomView, time: number): void {
  const breath = bloomBreath(w, time);
  const h = w.heart && !w.heart.slain ? w.heart : null;
  for (let id = 0; id < v.growth.length; id++) {
    const g = v.growth[id];
    if (g < 0.02) continue;
    const n = w.nests[id];
    const sw = v.swell[id] >= 0 ? Math.max(0, 1 - (time - v.swell[id]) / 0.9) : 0;
    // A pulsing core and a glowing rim; a wave born here swells and flashes it.
    r.shape(false, n.x, n.y, n.r * (0.95 + 0.15 * breath + 0.6 * sw) * (0.5 + 0.5 * g), 7, 1, 0, 0, BLOOM_RGB, Math.round((55 + 30 * breath + 90 * sw) * g));
    r.shape(false, n.x, n.y, n.r * (1.25 + 0.3 * sw), 0, 1, 0, 0.05, sw > 0 ? mixRgb(BLOOM_GLOW, WHITE, 0.5 * sw) : BLOOM_GLOW, Math.round((90 + 70 * breath + 120 * sw) * g));
    // Tendrils feeling out from the rim, swaying; they shrink back as the growth withers.
    const T = 8;
    for (let k = 0; k < T; k++) {
      const a = (k / T) * TAU + id * 1.3;
      const len = n.r * (0.75 + 0.4 * breath + 0.25 * Math.sin(k * 3.1 + id)) * g * (1 + 0.5 * sw);
      let px = n.x + Math.cos(a) * n.r * 1.15, py = n.y + Math.sin(a) * n.r * 1.15;
      const nx = -Math.sin(a), ny = Math.cos(a);
      for (let s = 1; s <= 3; s++) {
        const d = n.r * 1.15 + (len * s) / 3;
        const sway = Math.sin(time * 1.3 + k * 1.7 + s * 0.9 + id) * 3 * s;
        const qx = n.x + Math.cos(a) * d + nx * sway, qy = n.y + Math.sin(a) * d + ny * sway;
        r.beam(px, py, qx, qy, BLOOM_RGB[0], BLOOM_RGB[1], BLOOM_RGB[2], Math.round((230 - 45 * s) * g), 3.4 - 0.8 * s);
        px = qx;
        py = qy;
      }
    }
    // Veins to the heart: they carry the ward, and wither from the nest's end.
    if (h && w.heart!.nests.includes(id)) drawVein(r, n.x, n.y, h.x, h.y, g, time, id);
  }
}

/** A wavy vein from a nest to the heart, with light running along it toward the heart. */
let vx = 0, vy = 0;
function veinAt(x0: number, y0: number, dx: number, dy: number, nx: number, ny: number, t: number, time: number, id: number): void {
  const wob = Math.sin(t * Math.PI) * (10 + 4 * Math.sin(time * 0.7 + id)) * Math.sin(t * 9 + id + time * 0.4);
  vx = x0 + dx * t + nx * wob;
  vy = y0 + dy * t + ny * wob;
}
function drawVein(r: Renderer, x0: number, y0: number, x1: number, y1: number, g: number, time: number, id: number): void {
  const dx = x1 - x0, dy = y1 - y0;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const S = 10;
  const from = 1 - g;
  veinAt(x0, y0, dx, dy, nx, ny, from, time, id);
  let px = vx, py = vy;
  for (let s = 1; s <= S; s++) {
    veinAt(x0, y0, dx, dy, nx, ny, from + (g * s) / S, time, id);
    r.beam(px, py, vx, vy, BLOOM_RGB[0], BLOOM_RGB[1], BLOOM_RGB[2], Math.round(90 * g), 2.6);
    px = vx;
    py = vy;
  }
  const p = (time * 0.35 + id * 0.37) % 1;
  if (p >= from) {
    veinAt(x0, y0, dx, dy, nx, ny, p, time, id);
    r.shape(false, vx, vy, 7, 7, 1, 0, 0, BLOOM_GLOW, Math.round(150 * g));
  }
}

/**
 * The heart's body (#94), in place of a Colossus glyph: fleshy lobes around a
 * beating core, ringed by swaying tendrils. Phase 1 parts the lobes; phase 2
 * darkens it.
 */
export function drawHeartBody(r: Renderer, w: World, x: number, y: number, size: number, time: number): void {
  const h = w.heart;
  const phase = h?.phase ?? 0;
  const beat = heartBeat(w, time);
  const flesh = mixRgb(BLOOM_DEEP, BLOOM_RGB, phase >= 2 ? 0.25 : 0.55);
  // Tendrils first, so the lobes sit over their roots.
  const T = 12;
  for (let k = 0; k < T; k++) {
    const a = (k / T) * TAU + time * 0.05;
    const len = size * (0.9 + 0.3 * Math.sin(k * 2.3) + 0.2 * beat);
    let px = x + Math.cos(a) * size, py = y + Math.sin(a) * size;
    const nx = -Math.sin(a), ny = Math.cos(a);
    for (let s = 1; s <= 3; s++) {
      const d = size + (len * s) / 3;
      const sway = Math.sin(time * 1.1 + k * 1.9 + s) * 4 * s;
      const qx = x + Math.cos(a) * d + nx * sway, qy = y + Math.sin(a) * d + ny * sway;
      r.beam(px, py, qx, qy, flesh[0], flesh[1], flesh[2], 240 - 40 * s, 5.5 - 1.3 * s);
      px = qx;
      py = qy;
    }
  }
  // Six lobes, bobbing on the beat; a phase-1 split parts them in two.
  const split = phase >= 1 ? 0.22 : 0;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + time * 0.12;
    const side = Math.cos(a) >= 0 ? 1 : -1;
    const d = size * (0.5 + 0.06 * beat) + size * split * Math.abs(Math.cos(a));
    const lx = x + Math.cos(a) * d + side * size * split * 0.4, ly = y + Math.sin(a) * d;
    const lr = size * (0.62 + 0.06 * Math.sin(time * 2 + k * 1.3) + 0.08 * beat);
    r.unit(lx, ly, lr, flesh[0], flesh[1], flesh[2], 255, 5, time * 0.3 + k);
  }
  // The beating core.
  const core = mixRgb(BLOOM_GLOW, WHITE, 0.35 * beat);
  r.unit(x, y, size * (0.55 + 0.12 * beat), core[0], core[1], core[2], 255, 5, time * 0.5);
}
