/**
 * Run map effects (#73): the Bloom's living edge (shed spores, tendrils, a
 * pulse, a burst where it swallows a node), your swarm's dots orbiting its
 * node and streaming along a link when it moves, and the node icon styles.
 * Everything here is presentation: pools are fixed typed arrays, so a frame
 * allocates nothing for particles.
 */

import { nodeSetup } from '../campaign/battle';
import { MAP_H, bloomGapWith, type Bloom, type RunNode, type RunState } from '../campaign/run';
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

/** A node's sigil on its disc, as a small canvas for cards (`px` CSS pixels, ring included). */
export function sigilCanvas(run: RunState, n: RunNode, px: number, me: string): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = document.createElement('canvas');
  cv.className = 'sigil';
  cv.width = cv.height = Math.round(px * dpr);
  cv.style.width = cv.style.height = `${px}px`;
  const g = cv.getContext('2d');
  if (!g) return cv;
  // Scale so the disc plus its difficulty ring and rival dots fill the canvas.
  const r0 = nodeRadius(n, 'sigil');
  const u = cv.width / 2 / (r0 + 6.5);
  const c = cv.width / 2, r = r0 * u;
  g.beginPath();
  if (n.kind === 'finale') {
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 ? r * 0.45 : r;
      g.lineTo(c + Math.cos(a) * rr, c + Math.sin(a) * rr);
    }
    g.closePath();
  } else g.arc(c, c, r, 0, Math.PI * 2);
  g.fillStyle = n.kind === 'finale' ? '#5a1650' : '#141a33';
  g.fill();
  g.lineWidth = 1.5 * u;
  g.strokeStyle = n.kind === 'finale' ? BLOOM : 'rgba(150, 170, 255, 0.5)';
  g.stroke();
  if (n.kind === 'start') glyph(g, n.kind, c, c, r, u, 'rgba(230, 234, 255, 0.85)');
  else if (n.kind !== 'finale') drawIcon(g, run, n, 'sigil', c, c, r, u, { taken: false, dead: false, here: false, me });
  return cv;
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

  /** Shed off the edge (segments with outward normals, see `BloomField`) at `rate` per second. */
  shed(dt: number, rate: number, f: BloomField): void {
    this.carry += dt * rate;
    while (this.carry >= 1) {
      this.carry--;
      if (!f.nseg) continue;
      const i = Math.floor(Math.random() * f.nseg) * SEG;
      const x = (f.seg[i] + f.seg[i + 2]) / 2, y = (f.seg[i + 1] + f.seg[i + 3]) / 2;
      const nx = f.seg[i + 4], ny = f.seg[i + 5];
      const sp = 6 + Math.random() * 12;
      this.spawn(x - nx * 3, y - ny * 3, nx * sp + (Math.random() - 0.5) * 4, ny * sp + (Math.random() - 0.5) * 4, 2.5 + Math.random() * 3, 1 + Math.random() * 1.6);
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

/**
 * Tendrils rooted at fixed spots in the map (a hashed lattice), not on the
 * traced edge, so they never blink as the edge redraws. A spot near the edge
 * sends one out from the nearest point of the edge; it grows in as the edge
 * nears and withdraws as the edge passes, so tendrils ride the moving wall.
 * `gap` is the drawn Bloom (negative inside); the lattice coarsens as you zoom out.
 */
export function tendrils(
  g: CanvasRenderingContext2D,
  gap: (x: number, y: number) => number,
  view: { x0: number; y0: number; x1: number; y1: number },
  time: number,
  X: (x: number) => number,
  Y: (y: number) => number,
  u: number,
): void {
  const span = Math.max(view.x1 - view.x0, view.y1 - view.y0);
  const step = 24 * 2 ** Math.max(0, Math.ceil(Math.log2(span / (24 * 45))));
  const band = step * 1.2;
  g.lineWidth = 1.4 * u;
  for (let cx = Math.floor(view.x0 / step); cx <= Math.ceil(view.x1 / step); cx++) {
    for (let cy = Math.floor(view.y0 / step); cy <= Math.ceil(view.y1 / step); cy++) {
      const h = Math.abs(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1;
      if (h > 0.32) continue;
      // The spot itself, jittered inside its cell.
      const px = (cx + ((h * 7.13) % 1) - 0.5) * step, py = (cy + ((h * 3.71) % 1) - 0.5) * step;
      const d = gap(px, py);
      if (Math.abs(d) > band) continue;
      // Root it on the edge: step back along the gradient by the gap.
      const e = 2;
      let nx = gap(px + e, py) - gap(px - e, py), ny = gap(px, py + e) - gap(px, py - e);
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      const x = px - nx * d, y = py - ny * d;
      // Full grown when the edge sits on the spot, gone a band away.
      const grow = 1 - Math.abs(d) / band;
      const k = h / 0.32;
      const len = (10 + k * 22) * grow * grow * (3 - 2 * grow);
      if (len < 1) continue;
      const a = Math.atan2(ny, nx) + Math.sin(time * (0.6 + k * 0.7) + k * 9) * 0.7;
      const ex = x + len * Math.cos(a), ey = y + len * Math.sin(a);
      g.globalAlpha = Math.min(1, grow * 1.5);
      g.strokeStyle = 'rgba(205, 85, 170, 0.55)';
      g.beginPath();
      g.moveTo(X(x - nx * 2), Y(y - ny * 2));
      g.quadraticCurveTo(X(x + nx * len * 0.5), Y(y + ny * len * 0.5), X(ex), Y(ey));
      g.stroke();
      g.fillStyle = 'rgba(240, 140, 215, 0.8)';
      g.beginPath();
      g.arc(X(ex), Y(ey), 1.6 * u, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

// ---- the Bloom's shape ------------------------------------------------------------

/** floats per edge segment: x1, y1, x2, y2 and the outward normal */
const SEG = 6;

/**
 * The Bloom sampled on a grid over the view (in map units, cells snapped to
 * powers of two so they hold still while you pan), with its edge traced by
 * marching squares. The shape can be anything: a band, circles, their union.
 */
export class BloomField {
  cell = 8;
  gx0 = 0;
  gy0 = 0;
  nx = 0;
  ny = 0;
  vals = new Float32Array(0);
  seg = new Float32Array(SEG * 512);
  nseg = 0;
  private img: HTMLCanvasElement | null = null;
  private data: ImageData | null = null;

  /** Sample `gap` (negative inside) over the map rectangle, at about `px` pixels a cell. */
  sample(x0: number, y0: number, x1: number, y1: number, cellMap: number, gap: (x: number, y: number) => number): void {
    this.cell = Math.max(4, 2 ** Math.round(Math.log2(cellMap)));
    const c = this.cell;
    this.gx0 = Math.floor(x0 / c) - 1;
    this.gy0 = Math.floor(y0 / c) - 1;
    this.nx = Math.ceil(x1 / c) + 1 - this.gx0;
    this.ny = Math.ceil(y1 / c) + 1 - this.gy0;
    const n = (this.nx + 1) * (this.ny + 1);
    if (this.vals.length < n) this.vals = new Float32Array(n * 1.5);
    for (let j = 0; j <= this.ny; j++) for (let i = 0; i <= this.nx; i++) this.vals[j * (this.nx + 1) + i] = gap((this.gx0 + i) * c, (this.gy0 + j) * c);
  }

  /** Trace the zero contour into `seg`. */
  trace(): void {
    this.nseg = 0;
    const W = this.nx + 1, c = this.cell, v = this.vals;
    const push = (ax: number, ay: number, bx: number, by: number, gx: number, gy: number) => {
      if ((this.nseg + 1) * SEG > this.seg.length) {
        const grown = new Float32Array(this.seg.length * 2);
        grown.set(this.seg);
        this.seg = grown;
      }
      const l = Math.hypot(gx, gy) || 1;
      this.seg.set([ax, ay, bx, by, gx / l, gy / l], this.nseg * SEG);
      this.nseg++;
    };
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const a = v[j * W + i], b = v[j * W + i + 1], d = v[(j + 1) * W + i], e = v[(j + 1) * W + i + 1];
        const k = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (e < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
        if (k === 0 || k === 15) continue;
        const x = (this.gx0 + i) * c, y = (this.gy0 + j) * c;
        const t = (p: number, q: number) => p / (p - q);
        // Edge crossings: top (a-b), right (b-e), bottom (d-e), left (a-d).
        const top = [x + c * t(a, b), y], right = [x + c, y + c * t(b, e)], bottom = [x + c * t(d, e), y + c], left = [x, y + c * t(a, d)];
        const gx = (b + e - a - d) / 2, gy = (d + e - a - b) / 2;
        const lines: number[][][] =
          k === 1 || k === 14 ? [[left, top]] :
          k === 2 || k === 13 ? [[top, right]] :
          k === 3 || k === 12 ? [[left, right]] :
          k === 4 || k === 11 ? [[right, bottom]] :
          k === 6 || k === 9 ? [[top, bottom]] :
          k === 7 || k === 8 ? [[left, bottom]] :
          k === 5 ? [[left, top], [right, bottom]] : [[top, right], [left, bottom]];
        for (const [p, q] of lines) push(p[0], p[1], q[0], q[1], gx, gy);
      }
    }
  }

  /** Paint the inside, darker the deeper, softened over a cell at the edge, then scale it onto the view. */
  fill(g: CanvasRenderingContext2D, X: (x: number) => number, Y: (y: number) => number, scale: number): void {
    const W = this.nx + 1, H = this.ny + 1;
    const img = (this.img ??= document.createElement('canvas'));
    if (img.width !== W || img.height !== H || !this.data) {
      img.width = W;
      img.height = H;
      this.data = new ImageData(W, H);
    }
    const px = this.data.data, c = this.cell;
    for (let k = 0; k < W * H; k++) {
      const f = this.vals[k];
      const edge = Math.max(0, Math.min(1, (c * 0.5 - f) / c));
      const d = Math.max(0, Math.min(1, -f / 240));
      px[k * 4] = 150 - 80 * d;
      px[k * 4 + 1] = 40 - 26 * d;
      px[k * 4 + 2] = 120 - 60 * d;
      px[k * 4 + 3] = 255 * edge * (0.55 + 0.3 * d);
    }
    img.getContext('2d')!.putImageData(this.data, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(img, X(this.gx0 * c) - (c * scale) / 2, Y(this.gy0 * c) - (c * scale) / 2, W * c * scale, H * c * scale);
  }

  /** Stroke the traced edge (all segments, or only those `keep` accepts). */
  stroke(g: CanvasRenderingContext2D, X: (x: number) => number, Y: (y: number) => number, keep?: (x: number, y: number) => boolean): void {
    g.beginPath();
    for (let i = 0; i < this.nseg * SEG; i += SEG) {
      if (keep && !keep(this.seg[i], this.seg[i + 1])) continue;
      g.moveTo(X(this.seg[i]), Y(this.seg[i + 1]));
      g.lineTo(X(this.seg[i + 2]), Y(this.seg[i + 3]));
    }
    g.stroke();
  }
}

/** The Bloom's gap for drawing: the band (its bulge capped past the map, so it looks endless) and the seeds' circles. */
export const bloomGapView = (b: Bloom, x: number, y: number, t: number): number => bloomGapWith(b, x, y, t, (yy) => bloomShape(b, yy));

/** A slow organic wobble on the drawn edge, in map units. */
export const wobble = (x: number, y: number, time: number): number =>
  6 * Math.sin(x * 0.037 + y * 0.021 + time * 0.5) + 4 * Math.sin(x * 0.013 - y * 0.041 - time * 0.8);

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

  /** `zoom` is the map's zoom against the default view: the orbit scales with it, but never shrinks inside the node's disc. */
  draw(g: CanvasRenderingContext2D, at: RunNode, time: number, X: (x: number) => number, Y: (y: number) => number, u: number, color: string, zoom = 1): void {
    const ru = u * zoom;
    const inner = (nodeRadius(at, DEFAULT_ICONS) + 4) * u;
    const dot = u * Math.max(0.55, Math.min(1.6, Math.sqrt(zoom)));
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = color;
    const m = this.march;
    for (let i = 0; i < this.n; i++) {
      const a = this.ang[i] + time * this.spd[i];
      const r = Math.max(inner + (this.rad[i] - 24) * u * 0.4, (this.rad[i] + 3 * Math.sin(time * 1.3 + this.wob[i])) * ru);
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
        const bow = Math.sin(e * Math.PI) * 10 * ru * Math.sin(this.wob[i] * 3);
        x = fx + dx * e - (dy / len) * bow;
        y = fy + dy * e + (dx / len) * bow;
      }
      g.globalAlpha = 0.22;
      g.beginPath();
      g.arc(x, y, 4.5 * dot, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.95;
      g.beginPath();
      g.arc(x, y, 2 * dot, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

/** Per-map effect state, kept by the run map between frames. */
export class MapFx {
  readonly spores = new Spores();
  readonly field = new BloomField();
  readonly ghost = new BloomField();
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
