/**
 * Procedural campaign screens (#62): the hub (active and past runs), the run
 * map (move, preview, watch the Bloom advance) and the after-battle debrief.
 */

import type { AudioEngine } from '../audio/engine';
import { bloomLabel, nodeSetup } from '../campaign/battle';
import { MAP_H, MAP_W, frontShape, moves, needsBattle, revealed, type RunNode, type RunState } from '../campaign/run';
import type { PastRun } from '../campaign/store';
import { FACTION_HEX } from '../content/factions';
import { DIFFICULTY_NAMES } from '../sim/ai/bot';

function el(html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLDivElement;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' } as const;
const CAVE_LABEL = { off: 'Open', belt: 'Cave belt', full: 'Caves' } as const;
const TERRAIN_LABEL = { none: 'No terrain', light: 'Light terrain', standard: 'Terrain', heavy: 'Heavy terrain' } as const;
const BLOOM = '#c04a9a';

export const KIND_LABEL: Record<RunNode['kind'], string> = {
  start: 'Your camp',
  conquest: 'Conquest',
  domination: 'Domination',
  finale: "The Bloom's heart",
};
const KIND_TEXT: Record<RunNode['kind'], string> = {
  start: 'Where the run began.',
  conquest: 'Wipe out every rival.',
  domination: 'Hold half the nests for 30 seconds, or wipe out every rival.',
  finale: 'The final battle: a large map against three Hard rivals. Win it to end the run.',
};

function lives(run: RunState): string {
  return `<span class="lives" title="Swarm strength: a lost battle costs one">${'●'.repeat(run.lives)}${'○'.repeat(Math.max(0, 3 - run.lives))}</span>`;
}

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ---- drawing ----------------------------------------------------------------

interface View {
  s: number;
  ox: number;
  oy: number;
}

/** Where the map is looked at from: a point in map space and a zoom over "whole map fits". */
export interface Cam {
  cx: number;
  cy: number;
  zoom: number;
}

const ZOOM_MAX = 4;
/** the default zoom shows about this much of the map's width */
const VIEW_SPAN = 520;

function fitScale(cw: number, ch: number): number {
  const pad = 40;
  return Math.min(cw / (MAP_W + pad * 2), ch / (MAP_H + pad * 2));
}

/** The view for a camera, clamping it so the map can't be dragged away. */
function camView(cw: number, ch: number, cam: Cam): View {
  cam.zoom = Math.max(1, Math.min(ZOOM_MAX, cam.zoom));
  const s = fitScale(cw, ch) * cam.zoom;
  const clamp = (c: number, size: number, span: number) => {
    const half = span / s / 2;
    return half * 2 >= size + 80 ? size / 2 : Math.max(half - 40, Math.min(size + 40 - half, c));
  };
  cam.cx = clamp(cam.cx, MAP_W, cw);
  cam.cy = clamp(cam.cy, MAP_H, ch);
  return { s, ox: cw / 2 - cam.cx * s, oy: ch / 2 - cam.cy * s };
}

/** Start zoomed in on the swarm, looking a little ahead toward the heart. */
function homeCam(run: RunState, cw: number, ch: number): Cam {
  const n = run.nodes[run.at];
  return { cx: n.x + 90, cy: n.y, zoom: cw / VIEW_SPAN / fitScale(cw, ch) };
}

/** Nebula over the parts of the map you haven't reached, cut away around what you know. */
let fogCanvas: HTMLCanvasElement | null = null;
function drawFog(g: CanvasRenderingContext2D, run: RunState, known: Set<number>, v: View, cw: number, ch: number, time: number, u: number): void {
  const f = (fogCanvas ??= document.createElement('canvas'));
  if (f.width !== cw || f.height !== ch) {
    f.width = cw;
    f.height = ch;
  }
  const fg = f.getContext('2d')!;
  fg.globalCompositeOperation = 'source-over';
  fg.clearRect(0, 0, cw, ch);
  fg.fillStyle = 'rgba(9, 10, 24, 0.94)';
  fg.fillRect(0, 0, cw, ch);
  // Slow-drifting clouds of colour in the nebula.
  for (let k = 0; k < 18; k++) {
    const x = ((k * 7907 + run.seed) % 1100) - 50 + Math.sin(time * 0.05 + k) * 30;
    const y = ((k * 3571 + run.seed * 7) % 720) - 50 + Math.cos(time * 0.04 + k * 2) * 20;
    const r = (140 + (k % 5) * 40) * v.s;
    const px = v.ox + x * v.s, py = v.oy + y * v.s;
    const grad = fg.createRadialGradient(px, py, 0, px, py, r);
    const hue = k % 3 === 0 ? '90, 60, 170' : k % 3 === 1 ? '40, 90, 150' : '120, 40, 120';
    grad.addColorStop(0, `rgba(${hue}, 0.22)`);
    grad.addColorStop(1, `rgba(${hue}, 0)`);
    fg.fillStyle = grad;
    fg.fillRect(px - r, py - r, r * 2, r * 2);
  }
  // Clear windows around every known node.
  fg.globalCompositeOperation = 'destination-out';
  for (const id of known) {
    const n = run.nodes[id];
    const px = v.ox + n.x * v.s, py = v.oy + n.y * v.s;
    const r = Math.max(110 * v.s, 40 * u);
    const grad = fg.createRadialGradient(px, py, r * 0.35, px, py, r);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    fg.fillStyle = grad;
    fg.fillRect(px - r, py - r, r * 2, r * 2);
  }
  g.drawImage(f, 0, 0);
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

/** The map: Bloom, links, nodes. `front` may lag the run's while it animates. */
function drawMap(
  c: HTMLCanvasElement,
  run: RunState,
  opts: { front: number; selected: number | null; hover: number | null; time: number; fresh: Set<number>; freshT: number; thumb?: boolean; cam?: Cam },
): View {
  const dpr = window.devicePixelRatio || 1;
  const cw = c.clientWidth * dpr, ch = c.clientHeight * dpr;
  if (c.width !== cw || c.height !== ch) {
    c.width = cw;
    c.height = ch;
  }
  const g = c.getContext('2d')!;
  const v = camView(cw, ch, opts.cam ?? { cx: MAP_W / 2, cy: MAP_H / 2, zoom: 1 });
  const X = (x: number) => v.ox + x * v.s, Y = (y: number) => v.oy + y * v.s;
  const u = opts.thumb ? dpr * 0.35 : dpr; // pixel unit
  const known = revealed(run);
  g.clearRect(0, 0, cw, ch);
  if (!opts.thumb) drawFog(g, run, known, v, cw, ch, opts.time, u);

  // The Bloom: everything left of the front.
  const b = run.bloom;
  g.beginPath();
  g.moveTo(X(-60), Y(-60));
  for (let y = -60; y <= MAP_H + 60; y += 8) g.lineTo(X(Math.min(MAP_W + 80, opts.front + frontShape(b, y))), Y(y));
  g.lineTo(X(-60), Y(MAP_H + 60));
  g.closePath();
  const grad = g.createLinearGradient(X(opts.front - 200), 0, X(opts.front + 60), 0);
  grad.addColorStop(0, 'rgba(70, 14, 60, 0.85)');
  grad.addColorStop(1, 'rgba(150, 40, 120, 0.55)');
  g.fillStyle = grad;
  g.fill();
  if (!opts.thumb) {
    g.save();
    g.clip();
    // Spores drifting inside the Bloom.
    for (let k = 0; k < 140; k++) {
      const sx = ((k * 7919 + run.seed) % 1000) * 1.0;
      const sy = ((k * 104729 + run.seed * 3) % 620) * 1.0;
      const wob = Math.sin(opts.time * 0.6 + k) * 4;
      g.fillStyle = `rgba(230, 120, 200, ${0.15 + 0.15 * Math.sin(opts.time * 1.3 + k * 1.7)})`;
      g.beginPath();
      g.arc(X(sx + wob), Y(sy), (1.5 + (k % 3)) * u, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    // The glowing front.
    g.beginPath();
    for (let y = -60; y <= MAP_H + 60; y += 8) g.lineTo(X(Math.min(MAP_W + 80, opts.front + frontShape(b, y))), Y(y));
    g.strokeStyle = BLOOM;
    g.lineWidth = 2.5 * u;
    g.shadowColor = BLOOM;
    g.shadowBlur = 14 * u;
    g.stroke();
    g.shadowBlur = 0;
  }

  const me = FACTION_HEX[run.color];
  const open = new Set(moves(run));
  const isSwallowed = (id: number) => run.swallowed.includes(id) && (!opts.fresh.has(id) || opts.freshT >= 1);

  // Links.
  for (const n of run.nodes) {
    if (!known.has(n.id)) continue;
    for (const l of n.links) {
      if (l < n.id || !known.has(l)) continue;
      const fromHere = (n.id === run.at && open.has(l)) || (l === run.at && open.has(n.id));
      const dead = isSwallowed(n.id) || isSwallowed(l);
      g.strokeStyle = fromHere ? me : dead ? 'rgba(160, 70, 140, 0.25)' : 'rgba(150, 170, 255, 0.28)';
      g.lineWidth = (fromHere ? 2.5 : 1.5) * u;
      g.setLineDash(fromHere && !opts.thumb ? [6 * u, 5 * u] : []);
      g.lineDashOffset = -opts.time * 18 * u;
      g.beginPath();
      g.moveTo(X(n.x), Y(n.y));
      g.lineTo(X(run.nodes[l].x), Y(run.nodes[l].y));
      g.stroke();
    }
  }
  g.setLineDash([]);

  // Nodes you know about. The heart shows through the fog as a beacon.
  for (const n of run.nodes) {
    if (!known.has(n.id) && n.id !== run.heart) continue;
    const x = X(n.x), y = Y(n.y);
    const r = (n.kind === 'finale' ? 17 : 12) * u;
    const taken = run.visited.includes(n.id);
    const dead = isSwallowed(n.id);
    const here = n.id === run.at;
    const canGo = open.has(n.id);
    const pulse = 0.5 + 0.5 * Math.sin(opts.time * 4);

    if (opts.fresh.has(n.id) && opts.freshT < 1 && opts.freshT > 0) {
      // Being swallowed: a ring collapsing in.
      g.strokeStyle = BLOOM;
      g.lineWidth = 3 * u;
      g.beginPath();
      g.arc(x, y, r * (2.6 - 1.6 * opts.freshT), 0, Math.PI * 2);
      g.stroke();
    }
    if (n.kind === 'finale' && !opts.thumb) {
      // The heart pulses through the fog: the goal is always in sight.
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 3.2);
      glow.addColorStop(0, `rgba(192, 74, 154, ${0.35 + 0.2 * pulse})`);
      glow.addColorStop(1, 'rgba(192, 74, 154, 0)');
      g.fillStyle = glow;
      g.fillRect(x - r * 3.2, y - r * 3.2, r * 6.4, r * 6.4);
    }
    if (here || canGo || n.id === opts.selected) {
      g.fillStyle = here ? me : '#ffffff';
      g.globalAlpha = here ? 0.25 + 0.15 * pulse : canGo ? 0.1 + 0.12 * pulse : 0.15;
      g.beginPath();
      g.arc(x, y, r * 1.9, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }

    g.beginPath();
    if (n.kind === 'finale') star(g, x, y, r);
    else g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = dead ? '#3a1434' : taken ? me : n.kind === 'finale' ? '#5a1650' : '#141a33';
    g.globalAlpha = taken && !here ? 0.55 : 1;
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = (here || canGo || n.id === opts.selected || n.id === opts.hover ? 2.5 : 1.5) * u;
    g.strokeStyle = here ? '#ffffff' : canGo ? me : n.kind === 'finale' ? BLOOM : dead ? 'rgba(192, 74, 154, 0.5)' : 'rgba(150, 170, 255, 0.5)';
    g.stroke();

    // Glyph: crossed blades for conquest, a ring for domination, a roof for camp.
    if (opts.thumb || n.kind === 'finale') continue;
    g.strokeStyle = taken || here ? '#06070f' : dead ? 'rgba(220, 140, 200, 0.4)' : 'rgba(230, 234, 255, 0.85)';
    g.lineWidth = 1.8 * u;
    g.beginPath();
    const k = r * 0.45;
    if (n.kind === 'conquest') {
      g.moveTo(x - k, y - k);
      g.lineTo(x + k, y + k);
      g.moveTo(x + k, y - k);
      g.lineTo(x - k, y + k);
    } else if (n.kind === 'domination') {
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
    // Difficulty pips under untaken battles.
    if (!taken && !dead && n.kind !== 'start') {
      g.fillStyle = ['#b4ff39', '#ffb627', '#ff6b4a', '#ff3cac'][n.difficulty];
      for (let p = 0; p <= n.difficulty; p++) {
        g.beginPath();
        g.arc(x + (p - n.difficulty / 2) * 6 * u, y + r + 6 * u, 2 * u, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  return v;
}

/** A small static picture of a run, for the hub. */
function thumbnail(run: RunState): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'run-thumb';
  requestAnimationFrame(() => drawMap(c, run, { front: run.bloom.front, selected: null, hover: null, time: 0, fresh: new Set(), freshT: 1, thumb: true }));
  return c;
}

// ---- hub --------------------------------------------------------------------

export function runHub(
  runs: RunState[],
  history: PastRun[],
  suggestion: string,
  sfx: AudioEngine,
  h: { resume: (run: RunState) => void; start: (seed: string) => void; remove: (run: RunState) => void; back: () => void },
): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card hub">
        <h2>Procedural campaign</h2>
        <p class="hint">Cross a living map toward the Bloom's heart. The Bloom swallows territory behind you every turn, so pick your route. Phase 1 preview: battles, the Bloom and saves; broods and rewards come next.</p>
        <h3>Runs in progress</h3>
        <div class="runs"></div>
        <h3>New run</h3>
        <div class="row new-run">
          <input data-a="seed" type="text" spellcheck="false" placeholder="${esc(suggestion)}" aria-label="Run seed">
          <button class="primary" data-a="new">Start run</button>
        </div>
        <p class="hint">Leave the seed blank for a random run, or type one to replay a map.</p>
        <div class="past-wrap"></div>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  const list = m.querySelector('.runs')!;
  if (!runs.length) list.appendChild(el(`<p class="hint">None yet.</p>`));
  for (const run of runs) {
    const row = el(`
      <div class="run-row">
        <div class="thumb-slot"></div>
        <div class="run-info">
          <b>${esc(run.seedText)}</b>
          <span>Turn ${run.turn} · ${lives(run)} · ${run.biomass} biomass</span>
          <span class="hint">${ago(run.updated)}</span>
        </div>
        <div class="run-actions">
          <button class="primary small" data-a="resume">Continue</button>
          <button class="small" data-a="delete">Delete</button>
        </div>
      </div>`);
    row.querySelector('.thumb-slot')!.appendChild(thumbnail(run));
    row.querySelector('[data-a=resume]')!.addEventListener('click', () => h.resume(run));
    // Confirm in place: browser dialogs are silently blocked in some webviews.
    const del = row.querySelector('[data-a=delete]') as HTMLButtonElement;
    let armed = 0;
    del.addEventListener('click', () => {
      if (armed) {
        clearTimeout(armed);
        sfx.runDelete();
        h.remove(run);
        return;
      }
      del.textContent = 'Confirm delete';
      del.classList.add('danger');
      armed = window.setTimeout(() => {
        armed = 0;
        del.textContent = 'Delete';
        del.classList.remove('danger');
      }, 3000);
    });
    list.appendChild(row);
  }
  if (history.length) {
    const past = el(`<div><h3>Past runs</h3><div class="past"></div></div>`);
    for (const p of history) {
      const row = el(`
        <div class="past-row">
          <span class="${p.status}">${p.status === 'won' ? 'Won' : 'Lost'}</span>
          <b>${esc(p.seedText)}</b>
          <span class="hint">${p.turns} turns · ${p.biomass} biomass</span>
          <button class="small" data-a="replay">Replay seed</button>
        </div>`);
      row.querySelector('[data-a=replay]')!.addEventListener('click', () => h.start(p.seedText));
      past.querySelector('.past')!.appendChild(row);
    }
    m.querySelector('.past-wrap')!.appendChild(past);
  }
  const seed = m.querySelector('[data-a=seed]') as HTMLInputElement;
  const start = () => h.start(seed.value.trim() || suggestion);
  m.querySelector('[data-a=new]')!.addEventListener('click', start);
  seed.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

// ---- run map ----------------------------------------------------------------

export interface MapIntro {
  /** where the front stood before this turn, to animate it moving */
  from: number;
  /** nodes it swallowed this turn */
  fresh: number[];
}

export function runMap(
  run: RunState,
  sfx: AudioEngine,
  h: { go: (id: number) => void; leave: () => void },
  intro: MapIntro | null = null,
): HTMLDivElement {
  const m = el(`
    <div class="screen modal runmap">
      <div class="runmap-frame">
        <header>
          <div class="run-title"><b>${esc(run.seedText)}</b><span>Turn ${run.turn}</span></div>
          <div class="run-stats">${lives(run)}<span class="biomass">${run.biomass} biomass</span></div>
          <button class="small" data-a="leave">← All runs</button>
        </header>
        <div class="map-wrap">
          <canvas></canvas>
          <p class="map-hint">Tap a highlighted territory next to your swarm. Each move is a battle, then the Bloom advances. Drag to look around.</p>
          <div class="node-veil" hidden><div class="card node-card" role="dialog"></div></div>
        </div>
      </div>
    </div>`);
  const c = m.querySelector('canvas') as HTMLCanvasElement;
  const veil = m.querySelector('.node-veil') as HTMLElement;
  const panel = m.querySelector('.node-card') as HTMLElement;
  // Tapping off the card closes it.
  veil.addEventListener('pointerdown', (e) => {
    if (e.target === veil) close();
  });
  const close = () => {
    selected = null;
    veil.hidden = true;
  };
  m.querySelector('[data-a=leave]')!.addEventListener('click', h.leave);

  const open = moves(run);
  let selected: number | null = null;
  let hover: number | null = null;
  let view: View = { s: 1, ox: 0, oy: 0 };
  const fresh = new Set(intro?.fresh ?? []);
  const t0 = performance.now();
  let swallowSounded = false;

  const preview = () => {
    veil.hidden = selected === null || run.status !== 'active';
    if (veil.hidden || selected === null) return;
    const n = run.nodes[selected];
    const canGo = open.includes(n.id);
    const taken = run.visited.includes(n.id);
    const dead = run.swallowed.includes(n.id);
    const rows: string[] = [];
    if (n.kind !== 'start' && !taken && !dead) {
      const s = nodeSetup(run, n.id, false);
      const dots = s.players.slice(1).map((p) => `<i style="background:${FACTION_HEX[p.faction]}"></i>`).join('');
      rows.push(`<dt>Enemies</dt><dd>${dots} ${n.rivals} rival${n.rivals > 1 ? 's' : ''} · ${DIFFICULTY_NAMES[n.difficulty]}</dd>`);
      rows.push(`<dt>Map</dt><dd>${SIZE_LABEL[n.size]} · ${CAVE_LABEL[n.caves]} · ${TERRAIN_LABEL[n.terrain]}</dd>`);
      rows.push(`<dt>Bloom</dt><dd>${bloomLabel(run, n.id)}</dd>`);
      if (n.reward) rows.push(`<dt>Reward</dt><dd>+${n.reward} biomass</dd>`);
    }
    const status = n.id === run.at ? 'Your swarm is here.' : dead ? 'Lost to the Bloom.' : taken ? 'Taken: march through without a battle.' : canGo ? '' : 'Not next to your swarm.';
    const verb = !canGo ? null : needsBattle(run, n.id) ? 'Fight' : 'March';
    panel.innerHTML = `
      <button class="icon close" data-a="close" aria-label="Close">✕</button>
      <h3>${KIND_LABEL[n.kind]}</h3>
      <p>${KIND_TEXT[n.kind]}</p>
      ${rows.length ? `<dl>${rows.join('')}</dl>` : ''}
      ${status ? `<p class="hint">${status}</p>` : ''}
      ${verb ? `<button class="primary" data-a="go">${verb}</button>` : ''}`;
    panel.querySelector('[data-a=close]')!.addEventListener('click', close);
    panel.querySelector('[data-a=go]')?.addEventListener('click', () => {
      sfx.march();
      h.go(n.id);
    });
  };
  preview();

  const dpr = () => window.devicePixelRatio || 1;
  const local = (e: { clientX: number; clientY: number }) => {
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr(), y: (e.clientY - r.top) * dpr() };
  };
  const known = revealed(run);
  const pick = (e: PointerEvent): number | null => {
    const p = local(e);
    let best: number | null = null, bestD = (30 * dpr()) ** 2;
    for (const n of run.nodes) {
      if (!known.has(n.id)) continue;
      const d = (view.ox + n.x * view.s - p.x) ** 2 + (view.oy + n.y * view.s - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };

  // Camera: one finger or the mouse drags the map, a tap selects, the wheel
  // or a pinch zooms. Starts zoomed in on the swarm.
  let cam: Cam | null = null;
  const zoomAt = (px: number, py: number, factor: number) => {
    if (!cam) return;
    // Keep the map point under (px, py) where it is.
    const mx = (px - view.ox) / view.s, my = (py - view.oy) / view.s;
    cam.zoom *= factor;
    const v = camView(c.width, c.height, cam);
    cam.cx += mx - (px - v.ox) / v.s;
    cam.cy += my - (py - v.oy) / v.s;
  };
  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = false;
  let downAt = { x: 0, y: 0 };
  let pinch = 0;
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      dragged = false;
      downAt = local(e);
    } else {
      dragged = true;
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  c.addEventListener('pointermove', (e) => {
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType !== 'mouse') return;
      const n = pick(e);
      if (n !== hover && n !== null) sfx.mapHover();
      hover = n;
      c.style.cursor = n !== null ? 'pointer' : 'grab';
      return;
    }
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
      pinch = d;
      return;
    }
    if (!dragged && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 8 * dpr()) return;
    dragged = true;
    c.style.cursor = 'grabbing';
    if (cam) {
      cam.cx -= (p.x - prev.x) / view.s;
      cam.cy -= (p.y - prev.y) / view.s;
    }
  });
  const up = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size > 0) return;
    c.style.cursor = '';
    pinch = 0;
    if (dragged) return;
    const n = pick(e);
    if (n === null || n === selected) return;
    selected = n;
    sfx.mapSelect();
    preview();
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinch = 0;
  });
  c.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // The Bloom's advance plays when the map opens after a turn.
  const ANIM = 1.4;
  if (intro && intro.from !== run.bloom.front) sfx.bloomAdvance();
  const frame = () => {
    if (!m.isConnected) {
      if (performance.now() - t0 > 3000) return; // never attached
      requestAnimationFrame(frame);
      return;
    }
    const time = (performance.now() - t0) / 1000;
    const k = intro ? Math.min(1, time / ANIM) : 1;
    const ease = k * k * (3 - 2 * k);
    const front = intro ? intro.from + (run.bloom.front - intro.from) * ease : run.bloom.front;
    const freshT = intro ? Math.max(0, Math.min(1, (time - ANIM * 0.5) / ANIM)) : 1;
    if (!swallowSounded && freshT > 0 && fresh.size) {
      swallowSounded = true;
      [...fresh].forEach((_, i) => sfx.swallow(i));
    }
    if (!cam && c.clientWidth > 0) cam = homeCam(run, c.clientWidth * dpr(), c.clientHeight * dpr());
    view = drawMap(c, run, { front, selected, hover, time, fresh, freshT, cam: cam ?? undefined });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return m;
}

// ---- after a battle ---------------------------------------------------------

export function runDebrief(run: RunState, node: RunNode, won: boolean, h: { next: () => void; hub: () => void }): HTMLDivElement {
  const over = run.status !== 'active';
  const title =
    run.status === 'won' ? 'Run complete' : run.status === 'lost' ? 'Run lost' : won ? 'Territory taken' : 'Driven back';
  const text =
    run.status === 'won'
      ? `The Bloom's heart is destroyed. ${run.turn} turns, ${run.biomass} biomass gathered.`
      : run.status === 'lost'
        ? run.lostTo === 'bloom'
          ? 'The Bloom closed every route. Your swarm is consumed.'
          : 'Your swarm has no strength left to fight on.'
        : won
          ? `${KIND_LABEL[node.kind]} won. +${node.reward} biomass.`
          : `Your swarm falls back and loses strength. ${run.lives} of 3 left. The Bloom advances anyway.`;
  const m = el(`
    <div class="screen modal dim">
      <div class="card brief run-debrief ${run.status === 'won' || (won && !over) ? 'win' : 'lose'}">
        <div class="eyebrow">${esc(run.seedText)} · turn ${run.turn}</div>
        <h2>${title}</h2>
        <p>${text}</p>
        <p>${lives(run)} <span class="hint">${run.biomass} biomass</span></p>
        <div class="row end">
          ${over ? '<button class="primary" data-a="hub">Campaign</button>' : '<button class="primary" data-a="next">Continue</button>'}
        </div>
      </div>
    </div>`);
  m.querySelector('[data-a=next]')?.addEventListener('click', h.next);
  m.querySelector('[data-a=hub]')?.addEventListener('click', h.hub);
  return m;
}
