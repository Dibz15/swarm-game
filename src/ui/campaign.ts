/**
 * Procedural campaign screens (#62): the hub (active and past runs), the run
 * map (move, preview, watch the Bloom advance) and the after-battle debrief.
 */

import type { AudioEngine } from '../audio/engine';
import { bloomLabel, nodeSetup } from '../campaign/battle';
import { MAP_H, MAP_W, frontShape, moves, needsBattle, type RunNode, type RunState } from '../campaign/run';
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

function fit(cw: number, ch: number): View {
  const pad = 40;
  const s = Math.min(cw / (MAP_W + pad * 2), ch / (MAP_H + pad * 2));
  return { s, ox: (cw - MAP_W * s) / 2, oy: (ch - MAP_H * s) / 2 };
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
  opts: { front: number; selected: number | null; hover: number | null; time: number; fresh: Set<number>; freshT: number; thumb?: boolean },
): View {
  const dpr = window.devicePixelRatio || 1;
  const cw = c.clientWidth * dpr, ch = c.clientHeight * dpr;
  if (c.width !== cw || c.height !== ch) {
    c.width = cw;
    c.height = ch;
  }
  const g = c.getContext('2d')!;
  const v = fit(cw, ch);
  const X = (x: number) => v.ox + x * v.s, Y = (y: number) => v.oy + y * v.s;
  const u = opts.thumb ? dpr * 0.35 : dpr; // pixel unit
  g.clearRect(0, 0, cw, ch);

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
    for (const l of n.links) {
      if (l < n.id) continue;
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

  // Nodes.
  for (const n of run.nodes) {
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
    row.querySelector('[data-a=delete]')!.addEventListener('click', () => {
      if (confirm(`Delete the run "${run.seedText}"? This can't be undone.`)) {
        sfx.runDelete();
        h.remove(run);
      }
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
          <button class="small" data-a="leave">Campaign</button>
        </header>
        <div class="map-wrap"><canvas></canvas></div>
        <aside class="preview"></aside>
      </div>
    </div>`);
  const c = m.querySelector('canvas') as HTMLCanvasElement;
  const panel = m.querySelector('.preview') as HTMLElement;
  m.querySelector('[data-a=leave]')!.addEventListener('click', h.leave);

  const open = moves(run);
  let selected: number | null = open.length === 1 ? open[0] : null;
  let hover: number | null = null;
  let view: View = { s: 1, ox: 0, oy: 0 };
  const fresh = new Set(intro?.fresh ?? []);
  const t0 = performance.now();
  let swallowSounded = false;

  const preview = () => {
    if (run.status !== 'active') {
      panel.innerHTML = '';
      return;
    }
    if (selected === null) {
      panel.innerHTML = `<p class="hint">Pick a highlighted territory next to your swarm. Each move is a battle, and then the Bloom advances.</p>`;
      return;
    }
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
      <h3>${KIND_LABEL[n.kind]}</h3>
      <p>${KIND_TEXT[n.kind]}</p>
      ${rows.length ? `<dl>${rows.join('')}</dl>` : ''}
      ${status ? `<p class="hint">${status}</p>` : ''}
      ${verb ? `<button class="primary" data-a="go">${verb}</button>` : ''}`;
    panel.querySelector('[data-a=go]')?.addEventListener('click', () => {
      sfx.march();
      h.go(n.id);
    });
  };
  preview();

  const pick = (e: PointerEvent): number | null => {
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    let best: number | null = null, bestD = (30 * dpr) ** 2;
    for (const n of run.nodes) {
      const d = (view.ox + n.x * view.s - px) ** 2 + (view.oy + n.y * view.s - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };
  c.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const n = pick(e);
    if (n !== hover && n !== null) sfx.mapHover();
    hover = n;
    c.style.cursor = n !== null ? 'pointer' : '';
  });
  c.addEventListener('pointerdown', (e) => {
    const n = pick(e);
    if (n === null || n === selected) return;
    selected = n;
    sfx.mapSelect();
    preview();
  });

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
    view = drawMap(c, run, { front, selected, hover, time, fresh, freshT });
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
