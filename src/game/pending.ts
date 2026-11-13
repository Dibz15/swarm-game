/**
 * Orders on their way (#161). Networked, an order runs 100–500 ms after you
 * give it; until then GameView shows it here: a marching line to where units
 * were sent, a ghost rally line, a held reticle, a pulse on the nest, and the
 * HUD marks the power pending with its cost taken off your energy. All
 * cosmetic: nothing here touches the sim.
 */

import type { Renderer } from '../render/renderer';
import { POWER } from '../sim/constants';
import type { Command } from '../sim/commands';
import type { World } from '../sim/world';

export interface PendingOrder {
  /** the id `Session.issue` gave it */
  id: number;
  cmd: Command;
  /** when it was given, in the game view's clock (s) */
  at: number;
  /** energy it will spend: the HUD shows it as already gone */
  cost: number;
}

/** A lost order (the host never put it in a turn) mustn't leave a marker forever. */
const MAX_AGE = 8;

export class PendingOrders {
  private map = new Map<number, PendingOrder>();

  add(o: PendingOrder): void {
    this.map.set(o.id, o);
  }

  /** the order ran, or was refused: it's no longer pending */
  take(id: number): PendingOrder | undefined {
    const o = this.map.get(id);
    this.map.delete(id);
    return o;
  }

  /** is an order of this kind on its way (a power button shows it pending) */
  has(t: Command['t']): boolean {
    for (const o of this.map.values()) if (o.cmd.t === t) return true;
    return false;
  }

  /** energy the pending orders will spend */
  cost(): number {
    let c = 0;
    for (const o of this.map.values()) c += o.cost;
    return c;
  }

  get size(): number {
    return this.map.size;
  }

  values(): IterableIterator<PendingOrder> {
    return this.map.values();
  }

  expire(now: number): void {
    for (const [id, o] of this.map) if (now - o.at > MAX_AGE) this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }
}

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [255, 255, 255];

/** The interpolated middle of the units still alive, or null. */
function centroid(w: World, uids: readonly number[], alpha: number): [number, number] | null {
  let x = 0, y = 0, n = 0;
  for (const u of uids) {
    const s = w.uidToSlot.get(u);
    if (s === undefined || !w.alive[s]) continue;
    x += w.px[s] + (w.x[s] - w.px[s]) * alpha;
    y += w.py[s] + (w.y[s] - w.py[s]) * alpha;
    n++;
  }
  return n ? [x / n, y / n] : null;
}

/** Dashes marching from (x0, y0) to (x1, y1): an order on its way. */
function marching(r: Renderer, x0: number, y0: number, x1: number, y1: number, c: Rgb, a: number, time: number, zoom: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return;
  const dash = 9 / zoom, gap = 7 / zoom, step = dash + gap;
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
  for (let d = ((time * 40) / zoom) % step; d < len; d += step) {
    const e = Math.min(len, d + dash);
    r.beam(x0 + ux * d, y0 + uy * d, x0 + ux * e, y0 + uy * e, c[0], c[1], c[2], a, 1.8);
  }
}

/**
 * Draw every pending order. `zoom` is world-to-screen pixels (dashes stay a
 * constant size on screen); `now` is the game view's clock.
 */
export function drawPending(r: Renderer, w: World, list: Iterable<PendingOrder>, o: { alpha: number; color: Rgb; time: number; now: number; zoom: number }): void {
  const { color: c, time, zoom } = o;
  const pulse = 0.65 + 0.35 * Math.sin(time * 9);
  for (const p of list) {
    // fade in over a frame or two, so a local order that lands next tick doesn't flash
    const fade = Math.min(1, (o.now - p.at) / 0.05);
    const A = (v: number) => Math.round(v * fade);
    const cmd = p.cmd;
    switch (cmd.t) {
      case 'move': {
        const n = w.nests[cmd.nest];
        const tx = n ? n.x : cmd.x, ty = n ? n.y : cmd.y;
        const from = centroid(w, cmd.units, o.alpha);
        if (from) marching(r, from[0], from[1], tx, ty, c, A(200), time, zoom);
        r.shape(true, tx, ty, (n ? n.r * 1.25 : 9 / zoom) + 3 / zoom, 0, 1, 0, 0.18, c, A(200 * pulse));
        break;
      }
      case 'rally': {
        for (const id of cmd.nests) {
          const n = w.nests[id];
          if (n) marching(r, n.x, n.y, cmd.x, cmd.y, c, A(110), time, zoom);
        }
        r.shape(true, cmd.x, cmd.y, 6, 0, 1, time, 0.25, c, A(170 * pulse));
        break;
      }
      case 'surge':
      case 'nova':
      case 'fortify': {
        const at = centroid(w, cmd.units, o.alpha);
        if (at) r.shape(true, at[0], at[1], 26 + 6 * pulse, 0, 1, 0, 0.06, cmd.t === 'fortify' ? WHITE : c, A(150));
        break;
      }
      case 'barrage': {
        const R = POWER.barrageRadius;
        r.shape(true, cmd.x, cmd.y, R, 0, 1, 0, 0.03, c, A(190 * pulse));
        r.shape(true, cmd.x, cmd.y, R, 7, 1, 0, 0, c, A(30));
        break;
      }
      case 'blink': {
        const from = centroid(w, cmd.units, o.alpha);
        if (from) marching(r, from[0], from[1], cmd.x, cmd.y, c, A(130), time, zoom);
        r.shape(true, cmd.x, cmd.y, 16, 0, 1, 0, 0.14, WHITE, A(220 * pulse));
        break;
      }
      case 'lockdown':
      case 'upgrade': {
        const n = w.nests[cmd.nest];
        if (n) r.shape(true, n.x, n.y, n.r * (1.45 + 0.1 * pulse), 0, 1, 0, 0.05, cmd.t === 'lockdown' ? WHITE : c, A(190));
        break;
      }
      default:
        break;
    }
  }
}
