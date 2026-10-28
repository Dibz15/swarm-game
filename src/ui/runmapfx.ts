/**
 * Run map effects (#73): the Bloom's living edge (shed spores, tendrils, a
 * pulse, a burst where it swallows a node), your swarm's dots orbiting its
 * node and streaming along a link when it moves, and the node icon styles.
 * Everything here is presentation: pools are fixed typed arrays, so a frame
 * allocates nothing for particles.
 */

import { nodeSetup } from '../campaign/battle';
import { MAP_H, type Bloom, type RunNode, type RunState } from '../campaign/run';
import { FACTION_HEX } from '../content/factions';
import { generateMap, type MapSpec } from '../sim/mapgen';

export const BLOOM = '#c04a9a';
export const DIFF_COLOR = ['#b4ff39', '#ffb627', '#ff6b4a', '#ff3cac'] as const;

/** The front's offset at y. Matches `frontShape` on the map, but the bulge stops growing past its edges, so the front can be drawn endlessly. */
export function bloomShape(b: Bloom, y: number): number {
  const e = Math.max(-1, Math.min(1, (y - MAP_H / 2) / (MAP_H / 2)));
  let s = b.bulge * e * e;
  for (const [amp, k, ph] of b.waves) s += amp * Math.sin(y * k + ph);
  return s;
}

/** A small ripple crawling along the front, in map units. */
export const ripple = (y: number, time: number): number => 2.5 * Math.sin(y * 0.045 - time * 1.6) + 1.5 * Math.sin(y * 0.11 + time * 0.9);

// ---- node icons ------------------------------------------------------------------

/**
 * How battle nodes are drawn. Pick one with `?runicons=` to compare:
 * - glyph: the first cut (✕ for Conquest, a ring for Domination) with difficulty pips;
 * - sigil: an emblem per battle type, ringed by difficulty segments and rival colours;
 * - constellation: the battle map's nests as linked stars, rival starts in their colours;
 * - minimap: a tiny top-down thumbnail of the battle map.
 */
export type IconStyle = 'glyph' | 'sigil' | 'constellation' | 'minimap';
export const ICON_STYLES: readonly IconStyle[] = ['glyph', 'sigil', 'constellation', 'minimap'];
export const DEFAULT_ICONS: IconStyle = 'sigil';

export function iconStyle(): IconStyle {
  try {
    const q = new URLSearchParams(location.search).get('runicons');
    if (q && (ICON_STYLES as readonly string[]).includes(q)) return q as IconStyle;
  } catch {
    // no location (tests)
  }
  return DEFAULT_ICONS;
}

/** Node radius in pixel units for a style: map-art styles need a bigger disc to read. */
export function nodeRadius(n: RunNode, style: IconStyle): number {
  if (n.kind === 'finale') return 17;
  if (n.kind === 'start') return 12;
  return style === 'constellation' || style === 'minimap' ? 15 : style === 'sigil' ? 13 : 12;
}

interface NodeArt {
  rivals: number[];
  map: MapSpec | null;
}
/** Per battle seed: rival colours now, the generated map once there's time for it (about 30 ms each). */
const ART = new Map<number, NodeArt>();

function artFor(run: RunState, n: RunNode): NodeArt {
  let a = ART.get(n.seed);
  if (!a) {
    const s = nodeSetup(run, n.id, false);
    a = { rivals: s.players.slice(1).map((p) => p.faction), map: null };
    ART.set(n.seed, a);
  }
  return a;
}

let mapBudget = 0;
/** Generate at most one battle map per frame, so opening the map never stalls. */
export function resetMapBudget(): void {
  mapBudget = 1;
}
function mapFor(run: RunState, n: RunNode): MapSpec | null {
  const a = artFor(run, n);
  if (!a.map && mapBudget > 0) {
    mapBudget--;
    const s = nodeSetup(run, n.id, false);
    a.map = generateMap({ seed: s.seed, size: s.size, players: s.players.length, terrain: s.terrain, caves: s.caves, layout: s.layout });
  }
  return a.map;
}

const sprites = new Map<string, HTMLCanvasElement>();

/** The map art for a node (constellation or minimap), cached as a sprite `d` pixels across. */
function mapSprite(run: RunState, n: RunNode, style: 'constellation' | 'minimap', d: number, me: string): HTMLCanvasElement | null {
  const key = `${n.seed}:${style}:${d}:${me}`;
  const hit = sprites.get(key);
  if (hit) return hit;
  const m = mapFor(run, n);
  if (!m) return null;
  const rivals = artFor(run, n).rivals;
  const cv = document.createElement('canvas');
  cv.width = cv.height = d;
  const g = cv.getContext('2d')!;
  const s = (d * 0.78) / Math.max(m.width, m.height);
  const ox = d / 2 - (m.width * s) / 2, oy = d / 2 - (m.height * s) / 2;
  const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
  const colorOf = (player: number) => (player === 0 ? me : player > 0 ? FACTION_HEX[rivals[player - 1]] ?? '#e6eaff' : '#e6eaff');
  g.beginPath();
  g.arc(d / 2, d / 2, d / 2 - 1, 0, Math.PI * 2);
  g.clip();
  g.lineCap = 'round';
  if (style === 'minimap') {
    drawBattleMap(g, m, colorOf, ox, oy, s, false);
  } else {
    // Each nest linked to its two nearest: the map's shape as a constellation.
    g.strokeStyle = 'rgba(200, 210, 255, 0.35)';
    g.lineWidth = Math.max(0.8, d * 0.012);
    for (const a of m.nests) {
      const near = m.nests
        .filter((b) => b !== a)
        .sort((p, q) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2 - ((q.x - a.x) ** 2 + (q.y - a.y) ** 2))
        .slice(0, 2);
      for (const b of near) {
        g.beginPath();
        g.moveTo(X(a.x), Y(a.y));
        g.lineTo(X(b.x), Y(b.y));
        g.stroke();
      }
    }
    if (m.terrain.cave) {
      // Caves: broken lines.
      g.setLineDash([d * 0.04, d * 0.05]);
      g.strokeStyle = 'rgba(150, 170, 255, 0.4)';
      for (const w of m.terrain.walls.slice(0, 12)) {
        g.beginPath();
        g.moveTo(X(w.x1), Y(w.y1));
        g.lineTo(X(w.x2), Y(w.y2));
        g.stroke();
      }
      g.setLineDash([]);
    }
    for (const nest of m.nests) {
      const x = X(nest.x), y = Y(nest.y);
      const r = d * (nest.player >= 0 ? 0.075 : 0.025 + 0.012 * nest.level);
      g.fillStyle = colorOf(nest.player);
      g.beginPath();
      if (nest.player >= 0) {
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          const rr = k % 2 ? r * 0.35 : r;
          g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.closePath();
      } else g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  sprites.set(key, cv);
  return cv;
}

/**
 * A top-down picture of a battle map at scale `s` from (ox, oy): cave rock,
 * walls, nebula and rift fields (with `detail`), crystals, and the nests in
 * their owners' colours (your start in yours, rivals' in theirs).
 */
function drawBattleMap(g: CanvasRenderingContext2D, m: MapSpec, colorOf: (player: number) => string, ox: number, oy: number, s: number, detail: boolean): void {
  const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
  const capsule = (c: { x1: number; y1: number; x2: number; y2: number; r: number }, ctx: CanvasRenderingContext2D) => {
    ctx.lineWidth = Math.max(1, c.r * 2 * s);
    ctx.beginPath();
    ctx.moveTo(X(c.x1), Y(c.y1));
    ctx.lineTo(X(c.x2), Y(c.y2));
    ctx.stroke();
  };
  g.lineCap = 'round';
  const cave = m.terrain.cave;
  if (cave) {
    // Rock everywhere in the zone, with the chambers and tunnels carved out.
    const rock = document.createElement('canvas');
    rock.width = g.canvas.width;
    rock.height = g.canvas.height;
    const r = rock.getContext('2d')!;
    r.lineCap = 'round';
    r.fillStyle = r.strokeStyle = 'rgba(70, 85, 150, 0.55)';
    if (cave.zone) for (const z of cave.zone) capsule(z, r);
    else r.fillRect(X(0), Y(0), m.width * s, m.height * s);
    r.globalCompositeOperation = 'destination-out';
    r.strokeStyle = '#000';
    for (const c of cave.carves) capsule(c, r);
    g.drawImage(rock, 0, 0);
  }
  if (detail) {
    for (const f of m.terrain.fields) {
      g.strokeStyle = f.kind === 'rift' ? 'rgba(255, 70, 70, 0.35)' : 'rgba(150, 90, 220, 0.35)';
      capsule(f, g);
    }
    g.fillStyle = 'rgba(120, 230, 255, 0.7)';
    for (const c of m.terrain.crystals) {
      g.beginPath();
      g.arc(X(c.x), Y(c.y), Math.max(1, c.r * s), 0, Math.PI * 2);
      g.fill();
    }
  }
  g.strokeStyle = 'rgba(150, 170, 255, 0.5)';
  for (const w of m.terrain.walls) capsule(w, g);
  const unit = Math.max(m.width, m.height) * s;
  for (const nest of m.nests) {
    g.fillStyle = colorOf(nest.player);
    g.globalAlpha = nest.player < 0 ? 0.65 : 1;
    g.beginPath();
    g.arc(X(nest.x), Y(nest.y), Math.max(1.2, unit * (nest.player < 0 ? 0.012 + 0.003 * nest.level : 0.022)), 0, Math.PI * 2);
    g.fill();
    if (nest.player >= 0 && detail) {
      g.strokeStyle = colorOf(nest.player);
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(X(nest.x), Y(nest.y), unit * 0.04, 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
}

const CARD_MAPS = new Map<string, MapSpec>();

/** A larger picture of a node's battle map for its card, `px` CSS pixels on its long side. */
export function battleMapCanvas(run: RunState, n: RunNode, px: number, me: string): HTMLCanvasElement {
  // The same orientation the battle will use: tall on a portrait screen.
  const portrait = window.innerHeight > window.innerWidth * 1.15;
  const key = `${n.seed}:${portrait}`;
  let m = CARD_MAPS.get(key);
  if (!m) {
    const st = nodeSetup(run, n.id, portrait);
    m = generateMap({ seed: st.seed, size: st.size, players: st.players.length, portrait, terrain: st.terrain, caves: st.caves, layout: st.layout });
    CARD_MAPS.set(key, m);
  }
  const rivals = artFor(run, n).rivals;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const long = Math.max(m.width, m.height);
  const w = Math.round((px * m.width) / long), h = Math.round((px * m.height) / long);
  const cv = document.createElement('canvas');
  cv.className = 'battle-map';
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const g = cv.getContext('2d');
  if (g) {
    g.fillStyle = '#0a0d1c';
    g.fillRect(0, 0, cv.width, cv.height);
    drawBattleMap(g, m, (p) => (p === 0 ? me : p > 0 ? FACTION_HEX[rivals[p - 1]] ?? '#e6eaff' : '#e6eaff'), 0, 0, cv.width / m.width, true);
  }
  return cv;
}

/** Draw a battle node's icon inside its disc, in the chosen style. */
export function drawIcon(
  g: CanvasRenderingContext2D,
  run: RunState,
  n: RunNode,
  style: IconStyle,
  x: number,
  y: number,
  r: number,
  u: number,
  state: { taken: boolean; dead: boolean; here: boolean; me: string },
): void {
  const ink = state.taken || state.here ? '#06070f' : state.dead ? 'rgba(220, 140, 200, 0.4)' : 'rgba(230, 234, 255, 0.9)';
  const live = !state.taken && !state.dead;
  if (style === 'constellation' || style === 'minimap') {
    const d = Math.round(r * 2);
    const sp = mapSprite(run, n, style, d, state.me);
    if (sp) {
      g.globalAlpha = state.dead ? 0.3 : state.taken ? 0.55 : 1;
      g.drawImage(sp, x - d / 2, y - d / 2);
      g.globalAlpha = 1;
    }
    if (live) pips(g, n, x, y, r, u);
    return;
  }
  if (style === 'glyph') {
    glyph(g, n.kind, x, y, r, u, ink);
    if (live) pips(g, n, x, y, r, u);
    return;
  }
  // Sigil: an emblem, ringed by difficulty segments, with the rivals' colours on the ring.
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineWidth = 1.6 * u;
  g.lineCap = 'round';
  const k = r * 0.5;
  g.beginPath();
  if (n.kind === 'conquest') {
    // Crossed blades, each with a guard near its hilt.
    for (const s of [1, -1]) {
      const tx = x - k * s, ty = y - k, hx = x + k * 0.85 * s, hy = y + k * 0.85;
      g.moveTo(tx, ty);
      g.lineTo(hx, hy);
      const dx = (hx - tx) / Math.hypot(hx - tx, hy - ty), dy = (hy - ty) / Math.hypot(hx - tx, hy - ty);
      const gx = hx - dx * k * 0.5, gy = hy - dy * k * 0.5;
      g.moveTo(gx - dy * k * 0.35, gy + dx * k * 0.35);
      g.lineTo(gx + dy * k * 0.35, gy - dx * k * 0.35);
    }
    g.stroke();
  } else if (n.kind === 'domination') {
    // A crowned ring: hold the ground.
    g.arc(x, y + k * 0.15, k * 0.62, 0, Math.PI * 2);
    g.moveTo(x - k * 0.7, y - k * 0.55);
    g.lineTo(x - k * 0.45, y - k);
    g.lineTo(x, y - k * 0.7);
    g.lineTo(x + k * 0.45, y - k);
    g.lineTo(x + k * 0.7, y - k * 0.55);
    g.stroke();
    g.beginPath();
    g.arc(x, y + k * 0.15, k * 0.2, 0, Math.PI * 2);
    g.fill();
  }
  if (!live) return;
  const segs = n.difficulty + 1;
  const rr = r + 3.5 * u;
  g.strokeStyle = DIFF_COLOR[n.difficulty];
  g.lineWidth = 2 * u;
  const gap = 0.35;
  const span = Math.PI * 1.1;
  const start = Math.PI * 0.95;
  for (let i = 0; i < segs; i++) {
    const a0 = start + (span * i) / segs + gap / 2, a1 = start + (span * (i + 1)) / segs - gap / 2;
    g.beginPath();
    g.arc(x, y, rr, a0, a1);
    g.stroke();
  }
  const rivals = artFor(run, n).rivals;
  rivals.forEach((f, i) => {
    const a = Math.PI * 0.5 + (i - (rivals.length - 1) / 2) * 0.42;
    g.fillStyle = FACTION_HEX[f];
    g.beginPath();
    g.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 2.6 * u, 0, Math.PI * 2);
    g.fill();
  });
}

/** The first-cut glyphs: ✕ for Conquest, a ring for Domination, a roof for the camp. */
export function glyph(g: CanvasRenderingContext2D, kind: RunNode['kind'], x: number, y: number, r: number, u: number, ink: string): void {
  g.strokeStyle = ink;
  g.lineWidth = 1.8 * u;
  g.beginPath();
  const k = r * 0.45;
  if (kind === 'conquest') {
    g.moveTo(x - k, y - k);
    g.lineTo(x + k, y + k);
    g.moveTo(x + k, y - k);
    g.lineTo(x - k, y + k);
  } else if (kind === 'domination') {
    g.arc(x, y, k, 0, Math.PI * 2);
    g.moveTo(x + k * 0.3, y);
    g.arc(x, y, k * 0.3, 0, Math.PI * 2);
  } else {
    g.moveTo(x - k, y + k * 0.6);
    g.lineTo(x - k, y - k * 0.1);
    g.lineTo(x, y - k);
    g.lineTo(x + k, y - k * 0.1);
    g.lineTo(x + k, y + k * 0.6);
  }
  g.stroke();
}

function pips(g: CanvasRenderingContext2D, n: RunNode, x: number, y: number, r: number, u: number): void {
  g.fillStyle = DIFF_COLOR[n.difficulty];
  for (let p = 0; p <= n.difficulty; p++) {
    g.beginPath();
    g.arc(x + (p - n.difficulty / 2) * 6 * u, y + r + 6 * u, 2 * u, 0, Math.PI * 2);
    g.fill();
  }
}

// ---- the Bloom's spores --------------------------------------------------------------

const POOL = 220;

/** Spores shed off the front and burst from swallowed nodes: a ring buffer in map units. */
export class Spores {
  private x = new Float32Array(POOL);
  private y = new Float32Array(POOL);
  private vx = new Float32Array(POOL);
  private vy = new Float32Array(POOL);
  private age = new Float32Array(POOL).fill(1);
  private life = new Float32Array(POOL).fill(1);
  private size = new Float32Array(POOL);
  private next = 0;
  private carry = 0;

  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number): void {
    const i = this.next;
    this.next = (i + 1) % POOL;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
  }

  /** Shed from the front between y0 and y1 at `rate` per second. */
  shed(dt: number, rate: number, y0: number, y1: number, edge: (y: number) => number): void {
    this.carry += dt * rate;
    while (this.carry >= 1) {
      this.carry--;
      const y = y0 + Math.random() * (y1 - y0);
      this.spawn(edge(y) - 4, y, 6 + Math.random() * 12, (Math.random() - 0.5) * 6, 2.5 + Math.random() * 3, 1 + Math.random() * 1.6);
    }
  }

  /** A burst where the Bloom swallows a node. */
  burst(x: number, y: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.3;
      const sp = 20 + Math.random() * 45;
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.9 + Math.random() * 1.1, 1.4 + Math.random() * 1.8);
    }
  }

  step(dt: number, time: number): void {
    for (let i = 0; i < POOL; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += (this.vy[i] + Math.sin(time * 1.7 + i) * 4) * dt;
      this.vx[i] *= 1 - dt * 0.4;
      this.vy[i] *= 1 - dt * 0.8;
    }
  }

  draw(g: CanvasRenderingContext2D, X: (x: number) => number, Y: (y: number) => number, u: number): void {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgb(235, 120, 205)';
    for (let i = 0; i < POOL; i++) {
      const t = this.age[i] / this.life[i];
      if (t >= 1) continue;
      g.globalAlpha = 0.55 * Math.min(1, t * 6) * (1 - t);
      g.beginPath();
      g.arc(X(this.x[i]), Y(this.y[i]), this.size[i] * u, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

/** Tendrils feeling ahead of the front, one per band of map height, swaying. */
export function tendrils(g: CanvasRenderingContext2D, y0: number, y1: number, time: number, edge: (y: number) => number, X: (x: number) => number, Y: (y: number) => number, u: number): void {
  const BAND = 38;
  g.strokeStyle = 'rgba(205, 85, 170, 0.55)';
  g.fillStyle = 'rgba(240, 140, 215, 0.8)';
  g.lineWidth = 1.4 * u;
  for (let b = Math.floor(y0 / BAND); b <= Math.ceil(y1 / BAND); b++) {
    const h = Math.abs(Math.sin(b * 12.9898) * 43758.5453) % 1; // hash of the band
    if (h < 0.35) continue;
    const y = b * BAND + h * 20;
    const bx = edge(y);
    const len = 10 + h * 22;
    const sway = Math.sin(time * (0.6 + h * 0.7) + h * 9) * 0.7;
    const ex = bx + len * Math.cos(sway), ey = y + len * Math.sin(sway);
    g.beginPath();
    g.moveTo(X(bx - 2), Y(y));
    g.quadraticCurveTo(X(bx + len * 0.5), Y(y - sway * len * 0.5), X(ex), Y(ey));
    g.stroke();
    g.beginPath();
    g.arc(X(ex), Y(ey), 1.6 * u, 0, Math.PI * 2);
    g.fill();
  }
}

// ---- your swarm ---------------------------------------------------------------------

const MAX_DOTS = 28;

/** Your swarm's dots: they orbit your node loosely, and stream along a link when you move. */
export class SwarmDots {
  readonly n: number;
  private ang = new Float32Array(MAX_DOTS);
  private spd = new Float32Array(MAX_DOTS);
  private rad = new Float32Array(MAX_DOTS);
  private wob = new Float32Array(MAX_DOTS);
  private march: { from: RunNode; to: RunNode; t0: number } | null = null;

  /** One dot per few in the roster, so a battered swarm looks thinner. */
  constructor(run: RunState) {
    const total = run.broods.reduce((s, b) => s + b.size, 0);
    this.n = Math.max(12, Math.min(MAX_DOTS, Math.round(total / 2)));
    for (let i = 0; i < this.n; i++) {
      const h = (k: number) => Math.abs(Math.sin((i + 1) * k) * 43758.5453) % 1;
      this.ang[i] = h(12.99) * Math.PI * 2;
      this.spd[i] = (0.5 + h(78.23) * 0.9) * (h(3.1) < 0.85 ? 1 : -1);
      this.rad[i] = 24 + h(39.42) * 14;
      this.wob[i] = h(94.67) * Math.PI * 2;
    }
  }

  /** Start streaming to another node; returns the seconds until they arrive. */
  go(from: RunNode, to: RunNode, time: number): number {
    this.march = { from, to, t0: time };
    return 1.15;
  }

  stop(): void {
    this.march = null;
  }

  draw(g: CanvasRenderingContext2D, at: RunNode, time: number, X: (x: number) => number, Y: (y: number) => number, u: number, color: string): void {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = color;
    const m = this.march;
    for (let i = 0; i < this.n; i++) {
      const a = this.ang[i] + time * this.spd[i];
      const r = (this.rad[i] + 3 * Math.sin(time * 1.3 + this.wob[i])) * u;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r * 0.85;
      let x = X(at.x) + ox, y = Y(at.y) + oy;
      if (m) {
        // Each dot leaves in turn and eases along the link, bowing out a little.
        const p = Math.max(0, Math.min(1, (time - m.t0 - (i / this.n) * 0.45) / 0.7));
        const e = p * p * (3 - 2 * p);
        const fx = X(m.from.x) + ox, fy = Y(m.from.y) + oy;
        const tx = X(m.to.x) + ox, ty = Y(m.to.y) + oy;
        const dx = tx - fx, dy = ty - fy;
        const len = Math.hypot(dx, dy) || 1;
        const bow = Math.sin(e * Math.PI) * 10 * u * Math.sin(this.wob[i] * 3);
        x = fx + dx * e - (dy / len) * bow;
        y = fy + dy * e + (dx / len) * bow;
      }
      g.globalAlpha = 0.22;
      g.beginPath();
      g.arc(x, y, 4.5 * u, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.95;
      g.beginPath();
      g.arc(x, y, 2 * u, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

/** Per-map effect state, kept by the run map between frames. */
export class MapFx {
  readonly spores = new Spores();
  readonly swarm: SwarmDots;
  readonly style = iconStyle();
  private last = -1;
  /** seconds since the previous frame (capped, so a hidden tab doesn't jump) */
  dt = 0;
  burstDone = false;

  constructor(run: RunState) {
    this.swarm = new SwarmDots(run);
  }

  tick(time: number): void {
    this.dt = this.last < 0 ? 0 : Math.min(0.1, time - this.last);
    this.last = time;
    resetMapBudget();
  }
}
