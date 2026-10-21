import { FACTION_RGB, WHITE, mixRgb, type RGB } from '../content/factions';
import { BASTION, NEUTRAL, NestType, UNIT_FEEDING, UNIT_STATS, UPGRADE_COST } from '../sim/index';
import type { World } from '../sim/world';
import type { Renderer } from './renderer';

export interface SceneOpts {
  alpha: number;
  time: number;
  frame: number;
  /** slot mask of selected units, or null */
  selected: Uint8Array | null;
  selectedNests: ReadonlySet<number>;
  hoverNest: number;
  human: number;
}

const NEST_SHAPE = [1, 2, 3, 4, 5];
const NEST_SPIN = [0.22, 0.1, -0.28, 0.7, 0.12];
const UNOWNED: RGB = [70, 76, 96];
const SELECT_MIX = 0.5;

export function drawWorld(r: Renderer, w: World, o: SceneOpts): void {
  drawNests(r, w, o);
  drawBeams(r, w, o);
  drawUnits(r, w, o);
}

function nestColor(owner: number): RGB {
  return owner < 0 ? UNOWNED : FACTION_RGB[owner];
}

function drawNests(r: Renderer, w: World, o: SceneOpts): void {
  const pulseT = Math.sin(o.time * 5) * 0.5 + 0.5;
  for (const n of w.nests) {
    const c = nestColor(n.owner);
    const own = n.owner === o.human;
    const selected = o.selectedNests.has(n.id);
    const hover = o.hoverNest === n.id;

    let progress: number;
    let ringC: RGB;
    if (n.owner >= 0) {
      progress = n.control;
      ringC = c;
    } else {
      progress = n.control;
      ringC = n.controller >= 0 ? FACTION_RGB[n.controller] : UNOWNED;
    }
    let ringA = n.contested ? Math.round(120 + 135 * pulseT) : 235;
    if (n.owner === NEUTRAL && !n.contested) ringA = 110;

    const spawnPulse = Math.max(0, 1 - (w.tick - n.lastSpawn) / 8) * 0.6;
    const bodyA = n.owner < 0 ? 170 : n.owner === NEUTRAL ? 200 : 255;
    r.shape(false, n.x, n.y, n.r, NEST_SHAPE[n.type], progress, o.time * NEST_SPIN[n.type], spawnPulse, c, bodyA, ringC, ringA);

    // Level pips under the nest.
    for (let l = 0; l < n.level; l++) {
      const px = n.x + (l - (n.level - 1) / 2) * 7;
      r.unit(px, n.y + n.r * 1.32, 3.2, c[0], c[1], c[2], n.owner < 0 ? 140 : 255);
    }

    // Upgrade progress arc.
    if (n.feedProgress > 0 || n.feedIncoming > 0) {
      const cost = UPGRADE_COST[n.level] || 1;
      r.shape(true, n.x, n.y, n.r * 1.22, 0, n.feedProgress / cost, 0, 0.05, WHITE, 220);
      r.shape(true, n.x, n.y, n.r * 1.22, 0, 1, 0, 0.03, WHITE, 40);
    }

    if (n.type === NestType.Bastion && n.owner >= 0) {
      const range = BASTION.range + BASTION.rangePerLevel * (n.level - 1);
      const a = selected || hover ? 90 : n.owner === NEUTRAL ? 28 : 18;
      r.shape(false, n.x, n.y, range, 0, 1, 0, 1.2 / range, c, a);
    }

    if (own && (n.rallyX !== n.x || n.rallyY !== n.y)) {
      const a = selected ? 150 : 45;
      r.beam(n.x, n.y, n.rallyX, n.rallyY, c[0], c[1], c[2], a);
      r.shape(true, n.rallyX, n.rallyY, 6, 0, 1, o.time, 0.25, c, selected ? 200 : 70);
    }

    if (selected) {
      r.shape(true, n.x, n.y, n.r * 1.5, 0, 1, 0, 0.04, WHITE, Math.round(140 + 80 * pulseT));
    } else if (hover) {
      r.shape(true, n.x, n.y, n.r * 1.5, 0, 1, 0, 0.03, WHITE, 70);
    }
  }
}

function hash01(k: number, frame: number): number {
  let h = Math.imul(k ^ (frame * 0x27d4eb2d), 0x9e3779b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function drawBeams(r: Renderer, w: World, o: SceneOpts): void {
  const a = o.alpha;
  const flick = o.frame >> 1;
  for (let k = 0; k < w.beamCount; k++) {
    const s = w.beams[k * 2];
    const t = w.beams[k * 2 + 1];
    let x1: number, y1: number, owner: number;
    if (s < 0) {
      const n = w.nests[-s - 1];
      x1 = n.x;
      y1 = n.y;
      owner = n.owner;
    } else {
      x1 = w.px[s] + (w.x[s] - w.px[s]) * a;
      y1 = w.py[s] + (w.y[s] - w.py[s]) * a;
      owner = w.owner[s];
    }
    const x2 = w.px[t] + (w.x[t] - w.px[t]) * a;
    const y2 = w.py[t] + (w.y[t] - w.py[t]) * a;
    const c = FACTION_RGB[owner] ?? UNOWNED;
    const alpha = s < 0 ? 230 : Math.round(50 + 170 * hash01(k, flick));
    r.beam(x1, y1, x2, y2, c[0], c[1], c[2], alpha);
  }
}

function drawUnits(r: Renderer, w: World, o: SceneOpts): void {
  const a = o.alpha;
  const sel = o.selected;
  const surgeGlow = 0.5 + 0.5 * Math.sin(o.time * 18);
  const lit: RGB[] = FACTION_RGB.map((c) => mixRgb(c, WHITE, SELECT_MIX));
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i]) continue;
    const x = w.px[i] + (w.x[i] - w.px[i]) * a;
    const y = w.py[i] + (w.y[i] - w.py[i]) * a;
    const owner = w.owner[i];
    let c = sel && sel[i] ? lit[owner] : FACTION_RGB[owner];
    let size = UNIT_STATS[w.kind[i]].size;
    let alpha = owner === NEUTRAL ? 200 : 255;
    if (w.surge[i] > w.tick) {
      c = mixRgb(c, WHITE, 0.25 * surgeGlow);
      size *= 1.15;
    }
    if (w.state[i] === UNIT_FEEDING) alpha = 190;
    r.unit(x, y, size, c[0], c[1], c[2], alpha);
  }
}
