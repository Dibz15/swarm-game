/**
 * Procedural campaign screens (#62): the hub (active and past runs), the run
 * map (move, preview, watch the Bloom advance) and the after-battle debrief.
 */

import type { AudioEngine } from '../audio/engine';
import { mountCreatures } from '../art/creature';
import { BLOOM, BloomField, MapFx, battleMapCanvas, cardMap, bloomGapView, sigilCanvas, drawIcon, glyph, nodeRadius, tendrils, wobble } from './runmapfx';
import { bloomLabel, rivals, siegeFor, warlordOf, type Rival } from '../campaign/battle';
import { FORTRESS_LABEL } from '../sim/fortify';
import { STRONGHOLD_WEIGHT, TRAITS, trophyOf } from '../campaign/warlords';
import { broodCreature, broodTemper } from '../campaign/character';
import {
  MAP_H,
  MAP_W,
  frontShape,
  grow,
  heal,
  maxFielded,
  moves,
  needsBattle,
  rerollCost,
  rerollOffer,
  revealed,
  warlordAt,
  warlordFighting,
  DIFFICULTIES,
  RUN_DIFFICULTY,
  difficultyOf,
  type RunDifficulty,
  skipReward,
  takeReward,
  unlock,
  unlockCost,
  unlocked,
  type RunNode,
  type RunState,
  type TurnResult,
} from '../campaign/run';
import { FAMILY_LABEL, POWER_LABEL, REWARD, STRAIN_SLOTS, type Reward } from '../campaign/rewards';
import { COST, KIND_NAME, MAX_ROSTER, PACKS, UNLOCKS, fit, veteran, type Brood, type BroodEvent, type PackId, type Unlock } from '../campaign/broods';
import { Kind, NestType } from '../sim/constants';
import type { PastRun } from '../campaign/store';
import { FACTION_HEX } from '../content/factions';
import { DIFFICULTY_NAMES, type Personality } from '../sim/ai/bot';

function el(html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLDivElement;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' } as const;
const CAVE_LABEL = { off: 'Open', belt: 'Cave belt', full: 'Caves' } as const;
const TERRAIN_LABEL = { none: 'No terrain', light: 'Light terrain', standard: 'Terrain', heavy: 'Heavy terrain' } as const;

export const KIND_LABEL: Record<RunNode['kind'], string> = {
  start: 'Your camp',
  conquest: 'Conquest',
  domination: 'Domination',
  hold: 'Hold the line',
  finale: "The Bloom's heart",
};
const KIND_TEXT: Record<RunNode['kind'], string> = {
  start: 'Where the run began.',
  conquest: 'Wipe out every rival, or hold 80% of the nests for 30 seconds.',
  domination: 'Hold half the nests for 30 seconds, or wipe out every rival.',
  hold: "Dug in behind your own walls: keep your capital until the clock runs out, against the Bloom's waves. Its nests in the field feed them; sally out to take them. Every other wave, pick a boon. Lose the capital and you have 20 seconds to take it back.",
  finale: 'The final battle: a large map against three Hard rivals. Win it to end the run.',
};

/** A shape per unit kind, matching the in-battle silhouettes as closely as text allows. */
const KIND_GLYPH: Record<number, string> = { [Kind.Dot]: '●', [Kind.Tank]: '■', [Kind.Lancer]: '▲', [Kind.Swift]: '◆' };

const TEMPER_LABEL: Record<Personality, string> = { rusher: 'Rusher', turtler: 'Turtler', expander: 'Expander', opportunist: 'Opportunist' };
const TEMPER_HINT: Record<Personality, string> = {
  rusher: 'attacks early and often',
  turtler: 'digs in and defends',
  expander: 'grabs nests fast',
  opportunist: 'preys on the weakest',
};

/** Rival portraits (#72) as slots for `mountCreatures`; `names` adds each one's name and temper. */
function rivalStrip(list: Rival[], names: boolean, cls = ''): string {
  const one = (r: Rival, i: number) =>
    `<span class="rival" style="--c:${FACTION_HEX[r.faction]}" title="${r.creature.name}: ${TEMPER_LABEL[r.personality]}, ${TEMPER_HINT[r.personality]}">
      <span class="portrait" data-creature="${i}"></span>${names ? `<span class="who"><b>${r.warlord ? `♛ ${esc(r.warlord.name)}` : r.creature.name}</b><small>${r.warlord ? TRAITS[r.warlord.trait].name : TEMPER_LABEL[r.personality]}</small></span>` : ''}
    </span>`;
  return `<div class="rival-strip ${cls}">${list.map(one).join('')}</div>`;
}

function broodChip(b: Brood): string {
  const tags = `${veteran(b) ? '★' : ''}${b.strains.length ? '✦'.repeat(b.strains.length) : ''}${b.wounded ? ' ✚' : ''}`;
  return `<span class="brood-chip${b.wounded ? ' hurt' : ''}" title="${esc(b.name)}: ${KIND_NAME[b.kind]} ${b.size}/${b.cap}${strainText(b, ', ')}${b.wounded ? ', wounded' : ''}">${KIND_GLYPH[b.kind]} ${b.size}${tags}</span>`;
}

/** A brood's strains as text ("" if none), after `sep`. */
function strainText(b: Brood, sep: string): string {
  return b.strains.length ? sep + b.strains.map((s) => REWARD[s]?.name ?? s).join(' + ') : '';
}

function broods(run: RunState): string {
  return `<span class="broods">${run.broods.map(broodChip).join('')}</span>`;
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
  // Clouds of colour in three layers: the far ones drift slower and follow the camera less.
  for (let k = 0; k < 18; k++) {
    const layer = k % 3;
    const par = 0.55 + 0.2 * layer;
    const x = (((k * 7907 + run.seed) % 1100) + time * (2 + 2.5 * layer)) % 1200 - 100 + Math.sin(time * 0.05 + k) * 30;
    const y = ((k * 3571 + run.seed * 7) % 720) - 50 + Math.cos(time * 0.04 + k * 2) * 20;
    const r = (140 + (k % 5) * 40) * v.s;
    const px = cw / 2 + (v.ox - cw / 2) * par + x * v.s, py = ch / 2 + (v.oy - ch / 2) * par + y * v.s;
    const grad = fg.createRadialGradient(px, py, 0, px, py, r);
    const hue = k % 3 === 0 ? '90, 60, 170' : k % 3 === 1 ? '40, 90, 150' : '120, 40, 120';
    grad.addColorStop(0, `rgba(${hue}, 0.22)`);
    grad.addColorStop(1, `rgba(${hue}, 0)`);
    fg.fillStyle = grad;
    fg.fillRect(px - r, py - r, r * 2, r * 2);
  }
  // Faint stars, twinkling: fixed in the sky around the map, just behind it (the far cloud layer's depth).
  fg.fillStyle = '#dfe4ff';
  const par = 0.85;
  for (let k = 0; k < 90; k++) {
    const h = (m: number) => Math.abs(Math.sin((k + 1) * m + run.seed) * 43758.5453) % 1;
    const sx = cw / 2 + (v.ox - cw / 2) * par + (h(12.9) * 1600 - 300) * v.s;
    const sy = ch / 2 + (v.oy - ch / 2) * par + (h(78.2) * 1100 - 240) * v.s;
    if (sx < 0 || sy < 0 || sx > cw || sy > ch) continue;
    const tw = Math.max(0, Math.sin(time * (0.4 + h(3.7)) + h(9.1) * 20));
    fg.globalAlpha = 0.12 + 0.5 * tw * tw * tw;
    fg.fillRect(sx, sy, (0.8 + h(5.3)) * u, (0.8 + h(5.3)) * u);
  }
  fg.globalAlpha = 1;
  // A soft wave of brightness sweeping across.
  const wx = ((time * 0.04) % 1.6 - 0.3) * cw;
  const wave = fg.createLinearGradient(wx - cw * 0.3, 0, wx + cw * 0.3, ch * 0.4);
  wave.addColorStop(0, 'rgba(120, 110, 220, 0)');
  wave.addColorStop(0.5, 'rgba(120, 110, 220, 0.06)');
  wave.addColorStop(1, 'rgba(120, 110, 220, 0)');
  fg.fillStyle = wave;
  fg.fillRect(0, 0, cw, ch);
  // Clear windows around every known node, breathing softly as the fog moves.
  fg.globalCompositeOperation = 'destination-out';
  for (const id of known) {
    const n = run.nodes[id];
    const px = v.ox + n.x * v.s, py = v.oy + n.y * v.s;
    const r = Math.max(110 * v.s, 40 * u) * (1 + 0.06 * Math.sin(time * 0.45 + id * 1.3));
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
  opts: { bloomT: number; selected: number | null; hover: number | null; time: number; fresh: Set<number>; freshT: number; thumb?: boolean; cam?: Cam; fx?: MapFx; ghost?: boolean },
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

  // The Bloom (#88): its band off the left edge and the circles growing from
  // where you've been, sampled over whatever is in view so it looks endless.
  const b = run.bloom;
  const fx = opts.fx;
  const mx0 = -v.ox / v.s, mx1 = (cw - v.ox) / v.s, my0 = -v.oy / v.s, my1 = (ch - v.oy) / v.s;
  const field = fx?.field ?? THUMB_FIELD;
  const wob = (x: number, y: number) => (fx ? wobble(x, y, opts.time) : 0);
  field.sample(mx0, my0, mx1, my1, (opts.thumb ? 6 : 9) * u / v.s, (x, y) => bloomGapView(b, x, y, opts.bloomT) + wob(x, y));
  field.fill(g, X, Y, v.s);
  if (!opts.thumb && fx) {
    field.trace();
    // Spores drifting inside the Bloom, tiled over the view.
    for (let tx = Math.floor(mx0 / 1000); tx <= Math.floor(mx1 / 1000); tx++)
      for (let ty = Math.floor(my0 / 620); ty <= Math.floor(my1 / 620); ty++)
        for (let k = 0; k < 140; k++) {
          const sx = ((k * 7919 + run.seed) % 1000) + tx * 1000;
          const sy = ((k * 104729 + run.seed * 3) % 620) + ty * 620;
          if (bloomGapView(b, sx, sy, opts.bloomT) > -8) continue;
          const sw = Math.sin(opts.time * 0.6 + k) * 4;
          g.fillStyle = `rgba(230, 120, 200, ${0.15 + 0.15 * Math.sin(opts.time * 1.3 + k * 1.7)})`;
          g.beginPath();
          g.arc(X(sx + sw), Y(sy), (1.5 + (k % 3)) * u, 0, Math.PI * 2);
          g.fill();
        }
    // The edge is alive: tendrils feel out, spores shed off and drift.
    tendrils(g, (x, y) => bloomGapView(b, x, y, opts.bloomT) + wob(x, y), field, { x0: mx0, y0: my0, x1: mx1, y1: my1 }, opts.time, X, Y, u);
    fx.spores.shed(fx.dt, Math.min(60, field.nseg * 0.25), field);
    fx.spores.step(fx.dt, opts.time);
    fx.spores.draw(g, X, Y, u);
    // The glowing edge, with pulses of light running along it.
    g.strokeStyle = BLOOM;
    g.lineWidth = 2.5 * u;
    g.lineCap = 'round';
    g.shadowColor = BLOOM;
    g.shadowBlur = 14 * u;
    field.stroke(g, X, Y);
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255, 190, 240, 0.75)';
    g.lineWidth = 2 * u;
    field.stroke(g, X, Y, (x, y) => Math.sin(opts.time * 2.2 - x * 0.012 - y * 0.008) > 0.85);
    // Where it will reach next turn, if you don't outpace it.
    if (opts.ghost && run.status === 'active') {
      const ghost = fx.ghost;
      ghost.sample(mx0, my0, mx1, my1, (12 * u) / v.s, (x, y) => bloomGapView(b, x, y, b.time + 1));
      ghost.trace();
      g.strokeStyle = 'rgba(230, 120, 200, 0.45)';
      g.lineWidth = 1.5 * u;
      g.setLineDash([5 * u, 6 * u]);
      ghost.stroke(g, X, Y);
      g.setLineDash([]);
    }
  }

  const me = FACTION_HEX[run.color];
  const open = new Set(moves(run));
  const isSwallowed = (id: number) => run.swallowed.includes(id) && (!opts.fresh.has(id) || opts.freshT >= 1);

  // Warlord domains (#66): a soft wash in the warlord's colour over its nodes
  // and the links between them; grey once broken, the Bloom's once eaten.
  for (const w of run.warlords ?? []) {
    if (!w.nodes.some((id) => known.has(id))) continue;
    const eaten = run.swallowed.includes(w.stronghold);
    g.fillStyle = g.strokeStyle = w.broken ? '#8a90a8' : eaten ? BLOOM : FACTION_HEX[w.faction];
    g.globalAlpha = w.broken || eaten ? 0.08 : 0.16;
    g.lineCap = 'round';
    g.lineWidth = 34 * u;
    for (const a of w.nodes)
      for (const l of run.nodes[a].links) {
        if (l < a || !w.nodes.includes(l) || !known.has(a) || !known.has(l)) continue;
        g.beginPath();
        g.moveTo(X(run.nodes[a].x), Y(run.nodes[a].y));
        g.lineTo(X(run.nodes[l].x), Y(run.nodes[l].y));
        g.stroke();
      }
    for (const id of w.nodes) {
      if (!known.has(id)) continue;
      g.beginPath();
      g.arc(X(run.nodes[id].x), Y(run.nodes[id].y), (id === w.stronghold ? 30 : 24) * u, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

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
    const r = nodeRadius(n, fx?.style ?? 'glyph') * u;
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

    // The icon: the camp's roof, or the battle in the chosen style (?runicons=).
    if (opts.thumb || n.kind === 'finale') continue;
    const ink = taken || here ? '#06070f' : dead ? 'rgba(220, 140, 200, 0.4)' : 'rgba(230, 234, 255, 0.85)';
    if (n.kind === 'start') glyph(g, n.kind, x, y, r, u, ink);
    else drawIcon(g, run, n, fx?.style ?? 'glyph', x, y, r, u, { taken, dead, here, me });
    // A flag on the checkpoint, while it can still save you.
    if (n.checkpoint && !dead && !run.checkpointUsed) {
      const fx = x + r * 0.7, fy = y - r * 0.7;
      g.strokeStyle = '#e6eaff';
      g.lineWidth = 1.5 * u;
      g.beginPath();
      g.moveTo(fx, fy);
      g.lineTo(fx, fy - 14 * u);
      g.stroke();
      g.fillStyle = run.checkpointSave ? me : '#2de2e6';
      g.beginPath();
      g.moveTo(fx, fy - 14 * u);
      g.lineTo(fx + 10 * u, fy - 10.5 * u);
      g.lineTo(fx, fy - 7 * u);
      g.closePath();
      g.fill();
    }
    // A living warlord's ground (#66): its domain ringed in its colour; its
    // stronghold walled, crowned and named, so you can read it at a glance.
    const lord = n.domain === undefined ? undefined : run.warlords?.[n.domain];
    if (lord && !lord.broken && !dead && !run.swallowed.includes(lord.stronghold)) {
      const col = FACTION_HEX[lord.faction];
      if (lord.stronghold === n.id) {
        walls(g, x, y, r * 1.6, u, col);
        crown(g, x, y - r * 1.6 - 6 * u, u * 1.5, col);
        g.font = `600 ${11 * u}px sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.lineWidth = 3 * u;
        g.strokeStyle = 'rgba(6, 7, 15, 0.85)';
        const label = `${lord.name.split(' ')[0]}'s stronghold`;
        g.strokeText(label, x, y + r * 1.6 + 8 * u);
        g.fillStyle = col;
        g.fillText(label, x, y + r * 1.6 + 8 * u);
      } else {
        g.strokeStyle = col;
        g.globalAlpha = 0.8;
        g.lineWidth = 2 * u;
        g.setLineDash([4 * u, 3 * u]);
        g.beginPath();
        g.arc(x, y, r * 1.45, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
        crown(g, x, y - r * 1.45 - 3 * u, u * 0.8, col);
      }
    }
    // A small brood badge where one waits to be rescued.
    // The camp beside your swarm: tap it (or your node) to open the camp.
    if (here && !opts.thumb) campSymbol(g, x + r * CAMP_AT, y - r * CAMP_AT, u, me, pulse);
    if (n.rescue !== undefined && !taken && !dead) {
      const bx = x - r * 0.85, by = y - r * 0.85;
      g.fillStyle = '#06070f';
      g.beginPath();
      g.arc(bx, by, 6.5 * u, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#b4ff39';
      g.lineWidth = 1.5 * u;
      g.stroke();
      g.fillStyle = '#b4ff39';
      g.font = `${9 * u}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(KIND_GLYPH[n.rescue], bx, by + 0.5 * u);
    }
  }
  // Your swarm: its dots orbit your node, over the nodes' glow.
  // Unlike the node icons, the swarm lives in the map: it shrinks as you zoom out (1 at the default zoom).
  if (fx && run.status === 'active') fx.swarm.draw(g, run.nodes[run.at], opts.time, X, Y, u, me, (v.s * VIEW_SPAN) / cw);
  return v;
}

/** A stronghold's wall: a crenellated ring in the warlord's colour. */
function walls(g: CanvasRenderingContext2D, x: number, y: number, R: number, u: number, color: string): void {
  const n = 12, h = 4 * u;
  g.beginPath();
  for (let k = 0; k < n * 2; k++) {
    // Each merlon and gap is half a step: out, across, in, across.
    const a0 = (k / (n * 2)) * Math.PI * 2, a1 = ((k + 1) / (n * 2)) * Math.PI * 2;
    const rr = k % 2 ? R : R + h;
    if (k === 0) g.moveTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr);
    else g.lineTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr);
    g.lineTo(x + Math.cos(a1) * rr, y + Math.sin(a1) * rr);
  }
  g.closePath();
  g.strokeStyle = color;
  g.lineWidth = 2.5 * u;
  g.stroke();
}

/** A warlord's crown: three points over a band. */
function crown(g: CanvasRenderingContext2D, x: number, y: number, u: number, color: string): void {
  const w = 9 * u, h = 7 * u;
  g.beginPath();
  g.moveTo(x - w, y + h * 0.5);
  g.lineTo(x - w, y - h * 0.5);
  g.lineTo(x - w * 0.45, y);
  g.lineTo(x, y - h * 0.8);
  g.lineTo(x + w * 0.45, y);
  g.lineTo(x + w, y - h * 0.5);
  g.lineTo(x + w, y + h * 0.5);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.strokeStyle = '#06070f';
  g.lineWidth = 1.2 * u;
  g.stroke();
}

/** The field for hub thumbnails, which have no effects state. */
const THUMB_FIELD = new BloomField();

/** Where the camp symbol sits from the current node, in node radii (both axes). */
const CAMP_AT = 1.75;

/** A small campfire badge: a dark disc, a ring in your colour and a flickering flame. */
function campSymbol(g: CanvasRenderingContext2D, x: number, y: number, u: number, me: string, pulse: number): void {
  const r = 10 * u;
  g.fillStyle = '#06070f';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = me;
  g.lineWidth = 1.5 * u;
  g.stroke();
  const f = r * (0.55 + 0.08 * pulse);
  g.fillStyle = '#ffb627';
  g.beginPath();
  g.moveTo(x, y - f);
  g.quadraticCurveTo(x + f * 0.7, y, x, y + f * 0.55);
  g.quadraticCurveTo(x - f * 0.7, y, x, y - f);
  g.fill();
  g.strokeStyle = '#e6eaff';
  g.lineWidth = 1.2 * u;
  g.beginPath();
  g.moveTo(x - r * 0.5, y + r * 0.55);
  g.lineTo(x + r * 0.5, y + r * 0.35);
  g.moveTo(x + r * 0.5, y + r * 0.55);
  g.lineTo(x - r * 0.5, y + r * 0.35);
  g.stroke();
}

// ---- the camp (#76) ----------------------------------------------------------

const UNLOCK_CARD: Record<string, { name: string; gives: string; power: string }> = {
  [NestType.Forge]: { name: 'Forge', gives: 'Spawns Shields', power: 'Fortify' },
  [NestType.Spire]: { name: 'Spire', gives: 'Spawns Spears', power: 'Barrage' },
  [NestType.Swift]: { name: 'Den', gives: 'Spawns Raiders', power: 'Blink' },
  [NestType.Bastion]: { name: 'Bastion', gives: 'A turret nest', power: 'Lockdown' },
  nova: { name: 'Nova', gives: 'A power, not a nest', power: 'Nova shockwave' },
};

/** Inline symbols for the unlock cards: nest shapes, and a burst for Nova. */
function unlockIcon(u: Unlock): string {
  const path =
    u === NestType.Forge
      ? '<rect x="7" y="7" width="18" height="18" rx="2"/>'
      : u === NestType.Spire
        ? '<path d="M16 5 L27 26 L5 26 Z"/>'
        : u === NestType.Swift
          ? '<path d="M16 4 L28 16 L16 28 L4 16 Z"/>'
          : u === NestType.Bastion
            ? '<path d="M16 4 L27 10 L27 22 L16 28 L5 22 L5 10 Z"/><path d="M16 11 L16 21 M11 16 L21 16"/>'
            : '<circle cx="16" cy="16" r="4"/><path d="M16 3 V8 M16 24 V29 M3 16 H8 M24 16 H29 M7 7 L10.5 10.5 M21.5 21.5 L25 25 M25 7 L21.5 10.5 M10.5 21.5 L7 25"/>';
  return `<svg viewBox="0 0 32 32" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${path}</svg>`;
}

type CampTab = 'broods' | 'unlocks' | 'rewards';
const CAMP_TABS: { id: CampTab; label: string; icon: string }[] = [
  { id: 'broods', label: 'Broods', icon: '●' },
  { id: 'unlocks', label: 'Unlocks', icon: '⬡' },
  { id: 'rewards', label: 'Rewards', icon: '✦' },
];

/**
 * The camp: a tabbed modal of brood character cards (portraits from #72),
 * unlock cards and the run's rewards. Buying goes through run.ts and saves.
 */
function campModal(run: RunState, sfx: AudioEngine, h: { save: () => void; close: () => void; changed: () => void }): HTMLDivElement {
  let tab: CampTab = 'broods';
  const m = el(`
    <div class="camp" role="dialog" aria-label="Camp">
      <div class="card camp-card">
        <header>
          <h3>Camp</h3>
          <span class="camp-biomass"><b>${run.biomass}</b> biomass</span>
          <button class="icon close" data-a="close" aria-label="Close">✕</button>
        </header>
        <nav class="camp-tabs" role="tablist"></nav>
        <div class="camp-body"></div>
      </div>
    </div>`);
  const nav = m.querySelector('.camp-tabs') as HTMLElement;
  const body = m.querySelector('.camp-body') as HTMLElement;
  const shown = m.querySelector('.camp-biomass b') as HTMLElement;
  m.querySelector('[data-a=close]')!.addEventListener('click', h.close);
  // Tapping off the card closes it.
  m.addEventListener('pointerdown', (e) => {
    if (e.target === m) h.close();
  });

  let tween = 0;
  const spent = (from: number) => {
    const to = run.biomass;
    const float = el(`<span class="spent">−${from - to}</span>`);
    shown.parentElement!.append(float);
    float.addEventListener('animationend', () => float.remove());
    const t0 = performance.now();
    const id = ++tween;
    const step = (now: number) => {
      if (id !== tween) return;
      const t = Math.min(1, (now - t0) / 450);
      shown.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const price = (cost: number, label: string, act: string) =>
    `<button data-act="${act}" ${run.biomass >= cost ? '' : 'disabled'}>${label} <span class="cost">${cost}</span></button>`;

  const broodsTab = () => {
    const card = (b: Brood, i: number) => {
      const { word } = broodTemper(run, b);
      const slots = Array.from({ length: STRAIN_SLOTS }, (_, k) => {
        const r = REWARD[b.strains[k]];
        return r ? `<li class="strain-slot on" title="${esc(r.text)}"><b>✦ ${esc(r.name)}</b><small>${esc(r.text)}</small></li>` : '<li class="strain-slot">✦ empty strain slot</li>';
      }).join('');
      return `<article class="brood-card${b.wounded ? ' hurt' : ''}${veteran(b) ? ' vet' : ''}">
        <div class="portrait" data-creature="${i}"></div>
        ${veteran(b) ? '<span class="badge vet" title="Veteran: its dots start tougher">★</span>' : ''}
        <span class="temper">${word}</span>
        <h4>${esc(b.name)}</h4>
        <p class="kind"><span class="glyph">${KIND_GLYPH[b.kind]}</span> ${KIND_NAME[b.kind]} · ${b.wins} win${b.wins === 1 ? '' : 's'}</p>
        <div class="size-bar" title="${b.size} of ${b.cap} dots"><i style="width:${Math.min(100, (100 * b.size) / b.cap)}%"></i><span>${b.size}/${b.cap}</span></div>
        <p class="state">${b.wounded ? `Wounded · sits out ${b.wounded} battle${b.wounded > 1 ? 's' : ''}` : 'Ready to fight'}</p>
        <ul class="strains">${slots}</ul>
        <div class="actions">
          ${b.wounded ? price(COST.heal, 'Heal', `heal:${b.id}`) : ''}
          ${price(COST.grow(b), `Cap +${COST.growBy}`, `grow:${b.id}`)}
        </div>
      </article>`;
    };
    body.innerHTML = `<div class="brood-cards">${run.broods.map(card).join('')}</div>
      <p class="hint">${run.broods.length} of ${MAX_ROSTER} broods. Heal a wounded brood so it can fight next battle; raise its cap so it can grow larger.</p>`;
    mountCreatures(body, run.broods.map((b) => broodCreature(run, b)), 112);
    const row = body.querySelector('.brood-cards') as HTMLElement;
    // A mouse wheel scrolls the row sideways.
    row.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        row.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
  };

  const unlocksTab = () => {
    const card = (u: Unlock) => {
      const d = UNLOCK_CARD[u];
      const own = unlocked(run, u);
      return `<article class="unlock-card${own ? ' on' : ''}">
        <span class="icon-art">${unlockIcon(u)}</span>
        <div class="who"><b>${d.name}</b><small>${d.gives}</small><small>Power: ${d.power}</small></div>
        ${own ? '<span class="state">Unlocked</span>' : price(unlockCost(u), 'Unlock', `unlock:${u}`)}
      </article>`;
    };
    body.innerHTML = `<p class="hint">Until a nest type is unlocked, it spawns Swarmers for you and gives no power.</p>
      <div class="unlock-cards">${UNLOCKS.map(card).join('')}</div>`;
  };

  const rewardsTab = () => {
    body.innerHTML = run.perks.length
      ? `<div class="unlock-cards">${run.perks
          .map((p) => {
            const r = REWARD[p] ?? trophyOf(p);
            return `<article class="unlock-card on"><span class="icon-art reward">✦</span><div class="who"><b>${esc(r?.name ?? p)}</b><small>${esc(r?.text ?? '')}</small></div></article>`;
          })
          .join('')}</div>`
      : '<p class="hint">No run-wide rewards yet. Win battles to pick them; strains show on their brood\'s card.</p>';
  };

  const draw = () => {
    nav.innerHTML = CAMP_TABS.map(
      (t) => `<button role="tab" aria-selected="${t.id === tab}" class="${t.id === tab ? 'on' : ''}" data-tab="${t.id}"><span>${t.icon}</span> ${t.label}</button>`,
    ).join('');
    nav.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.tab === tab) return;
        tab = b.dataset.tab as CampTab;
        sfx.mapHover();
        draw();
      }),
    );
    const keep = (body.querySelector('.brood-cards') as HTMLElement | null)?.scrollLeft ?? 0;
    if (tab === 'broods') broodsTab();
    else if (tab === 'unlocks') unlocksTab();
    else rewardsTab();
    const row = body.querySelector('.brood-cards') as HTMLElement | null;
    if (row) row.scrollLeft = keep;
    body.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const [act, arg] = btn.dataset.act!.split(':');
        const from = run.biomass;
        const done =
          act === 'heal' ? heal(run, Number(arg)) : act === 'grow' ? grow(run, Number(arg)) : unlock(run, arg === 'nova' ? 'nova' : Number(arg));
        if (!done) return;
        if (act === 'heal') sfx.broodHealed();
        else if (act === 'grow') sfx.broodGrown();
        else sfx.biomassSpent();
        h.save();
        h.changed();
        spent(from);
        draw();
      }),
    );
  };
  draw();
  return m;
}

/** A small static picture of a run, for the hub. */
function thumbnail(run: RunState): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'run-thumb';
  requestAnimationFrame(() => drawMap(c, run, { bloomT: run.bloom.time, selected: null, hover: null, time: 0, fresh: new Set(), freshT: 1, thumb: true }));
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
          <span>${RUN_DIFFICULTY[difficultyOf(run)].name} · turn ${run.turn} · ${run.biomass} biomass</span>
          <span>${broods(run)}</span>
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
  /** the Bloom time before this turn, to animate it growing */
  from: number;
  /** nodes it swallowed this turn */
  fresh: number[];
}

export function runMap(
  run: RunState,
  sfx: AudioEngine,
  h: { go: (id: number, fielded: number[]) => void; leave: () => void; save: () => void },
  intro: MapIntro | null = null,
): HTMLDivElement {
  const m = el(`
    <div class="screen modal runmap">
      <div class="runmap-frame">
        <header>
          <div class="run-title"><b>${esc(run.seedText)}</b><span>${RUN_DIFFICULTY[difficultyOf(run)].name} · turn ${run.turn}</span></div>
          <div class="run-stats"></div>
          <button class="small" data-a="leave">← All runs</button>
        </header>
        <div class="map-wrap">
          <canvas></canvas>
          <p class="map-hint">Tap a highlighted territory next to your swarm. Each move is a battle, then the Bloom advances. Tap your swarm to open the camp. Drag to look around.</p>
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
  const stats = m.querySelector('.run-stats') as HTMLElement;
  // Only biomass up here: your broods live in the camp (tap your swarm).
  const showStats = () => (stats.innerHTML = `<span class="biomass" title="Biomass: spend it at the camp"><b>${run.biomass}</b> biomass</span>`);
  showStats();
  m.querySelector('[data-a=leave]')!.addEventListener('click', h.leave);
  let campEl: HTMLElement | null = null;
  const camp = () => {
    close();
    sfx.mapSelect();
    campEl?.remove();
    campEl = campModal(run, sfx, {
      save: h.save,
      changed: showStats,
      close: () => {
        campEl?.remove();
        campEl = null;
      },
    });
    m.querySelector('.map-wrap')!.append(campEl);
  };

  const open = moves(run);
  let selected: number | null = null;
  let hover: number | null = null;
  let view: View = { s: 1, ox: 0, oy: 0 };
  const fresh = new Set(intro?.fresh ?? []);
  const fx = new MapFx(run);
  let moving = false;
  /** Your dots stream along the link to the new node, then the move happens. */
  const march = (n: RunNode, fielded: number[]) => {
    if (moving) return;
    moving = true;
    close();
    sfx.march();
    const wait = fx.swarm.go(run.nodes[run.at], n, (performance.now() - t0) / 1000);
    setTimeout(() => {
      try {
        h.go(n.id, fielded);
      } catch (err) {
        // Never strand the map mid-march: put the swarm back and let the player try again.
        console.error('run move failed', err);
        fx.swarm.stop();
        moving = false;
      }
    }, wait * 1000);
  };
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
    let foes: Rival[] = [];
    // A standing warlord's stronghold (#100) is its own kind of battle.
    const fortress = !taken && !dead && warlordAt(run, n.id)?.stronghold === n.id;
    if (n.kind !== 'start' && !taken && !dead) {
      foes = rivals(run, n.id);
      rows.push(
        n.kind === 'hold'
          ? `<dt>Enemies</dt><dd>The Bloom: every nest it holds in the field makes its waves bigger</dd>`
          : `<dt>Enemies</dt><dd>${n.rivals} rival${n.rivals > 1 ? 's' : ''} · ${DIFFICULTY_NAMES[n.difficulty]}${rivalStrip(foes, true, 'small')}</dd>`,
      );
      // Strongholds and Hold the line are fortresses, each in its own style (#67).
      const fort = fortress || n.kind === 'hold' ? cardMap(run, n).fortress : undefined;
      const ground = fort ? `Fortress (${FORTRESS_LABEL[fort.style]})` : CAVE_LABEL[n.caves];
      rows.push(`<dt>Map</dt><dd>${SIZE_LABEL[n.size]} · ${ground} · ${TERRAIN_LABEL[n.terrain]}<div class="battle-map-slot"></div></dd>`);
      if (n.kind === 'hold') {
        const sg = siegeFor(run, n.depth);
        rows.push(`<dt>Siege</dt><dd>Hold for ${Math.floor(sg.seconds / 60)}:${String(sg.seconds % 60).padStart(2, '0')} · a wave every ${sg.every}s, the first ${sg.size} strong and growing</dd>`);
      }
      rows.push(`<dt>Bloom</dt><dd>${bloomLabel(run, n.id)}</dd>`);
      const lord = warlordOf(run, n.id);
      if (lord) {
        const weak = lord.weakened ? ` · weakened ×${lord.weakened} by the Bloom` : '';
        const where = n.kind === 'finale' ? 'joins the finale · ' : '';
        rows.push(`<dt>Warlord</dt><dd><b style="color:${FACTION_HEX[lord.faction]}">♛ ${esc(lord.name)}</b> · ${where}${esc(lord.text)}${weak}</dd>`);
        const w = warlordFighting(run, n.id);
        if (w && w.stronghold === n.id) {
          rows.push(
            `<dt>Stronghold</dt><dd>Taking it breaks the domain: ${Math.round(STRONGHOLD_WEIGHT.rare)}% rare picks, and its trophy: ${esc(TRAITS[w.trait].trophy.text)}</dd>`,
          );
        }
      }
      if (n.reward) {
        const rescue =
          n.rescue === undefined ? '' : run.broods.length < MAX_ROSTER ? ` · rescue a ${KIND_NAME[n.rescue]} brood` : ` · a ${KIND_NAME[n.rescue]} brood waits, but your roster is full (${MAX_ROSTER})`;
        rows.push(`<dt>Reward</dt><dd>+${n.reward}+ biomass${rescue}</dd>`);
      }
      if (n.checkpoint) rows.push(`<dt>Checkpoint</dt><dd>${run.checkpointUsed ? 'Already used' : 'Reach it to save the run here, once'}</dd>`);
    }
    const status = n.id === run.at ? 'Your swarm is here, at its camp.' : dead ? 'Lost to the Bloom.' : taken ? 'Taken: march through without a battle.' : canGo ? '' : 'Not next to your swarm.';
    const verb = !canGo ? null : needsBattle(run, n.id) ? 'Fight' : 'March';
    panel.innerHTML = `
      <button class="icon close" data-a="close" aria-label="Close">✕</button>
      <h3 class="with-sigil"><span class="sigil-slot"></span>${fortress ? 'Stronghold' : KIND_LABEL[n.kind]}</h3>
      <p>${fortress ? `Take the warlord's citadel to win, even with rivals left. Or: ${KIND_TEXT[n.kind].charAt(0).toLowerCase()}${KIND_TEXT[n.kind].slice(1)}` : KIND_TEXT[n.kind]}</p>
      ${rows.length ? `<dl>${rows.join('')}</dl>` : ''}
      ${status ? `<p class="hint">${status}</p>` : ''}
      ${verb ? `<button class="primary" data-a="go">${verb}</button>` : ''}
      ${n.id === run.at ? '<button class="primary" data-a="camp">Open camp</button>' : ''}`;
    mountCreatures(panel, foes.map((r) => r.creature), 40);
    panel.querySelector('.sigil-slot')?.append(sigilCanvas(run, n, 36, FACTION_HEX[run.color]));
    // The battle's actual map: you in your colour, the rivals in theirs.
    panel.querySelector('.battle-map-slot')?.append(battleMapCanvas(run, n, 210, FACTION_HEX[run.color]));
    panel.querySelector('[data-a=close]')!.addEventListener('click', close);
    panel.querySelector('[data-a=camp]')?.addEventListener('click', camp);
    panel.querySelector('[data-a=go]')?.addEventListener('click', () => {
      if (verb === 'Fight') return choose(n);
      march(n, []);
    });
  };
  preview();

  /** Before a battle: pick up to three fit broods (last time's pick by default). */
  const choose = (n: RunNode) => {
    const fitOnes = run.broods.filter(fit);
    const max = maxFielded(run);
    const picked = new Set(run.fielded.filter((id) => fitOnes.some((b) => b.id === id)).slice(0, max));
    for (const b of fitOnes) if (picked.size < max) picked.add(b.id);
    const foes = rivals(run, n.id);
    const draw = () => {
      const rows = run.broods
        .map(
          (b) => `<button class="brood-pick${picked.has(b.id) ? ' on' : ''}" data-b="${b.id}" ${fit(b) ? '' : 'disabled'}>
            <span class="glyph">${KIND_GLYPH[b.kind]}</span>
            <span class="who"><b>${esc(b.name)}</b><small>${KIND_NAME[b.kind]} · ${b.size}/${b.cap}${veteran(b) ? ' · ★ veteran' : ''}${strainText(b, ' · ✦ ')}${b.wounded ? ' · wounded' : ''}</small></span>
          </button>`,
        )
        .join('');
      const count = picked.size;
      panel.innerHTML = `
        <button class="icon close" data-a="close" aria-label="Close">✕</button>
        <h3>Field your broods</h3>
        <div class="facing"><span class="hint">Facing</span>${rivalStrip(foes, true)}</div>
        <p class="hint">${max === 1 ? 'One only (Lone wolf), at double size' : `Up to ${max}`}. They are your starting army: win and they take the survivors of their kind; lose and they're wounded and halved.</p>
        <div class="brood-list">${rows}</div>
        ${fitOnes.length ? '' : '<p class="hint">Every brood is wounded. A militia of 10 Swarmers fights this one, and no brood is at risk.</p>'}
        <div class="row">
          <button data-a="back">Back</button>
          <button class="primary grow1" data-a="fight" ${fitOnes.length && !count ? 'disabled' : ''}>${count ? `Fight with ${count} brood${count > 1 ? 's' : ''}` : 'Fight with the militia'}</button>
        </div>`;
      mountCreatures(panel, foes.map((r) => r.creature), 56);
      panel.querySelector('[data-a=close]')!.addEventListener('click', close);
      panel.querySelector('[data-a=back]')!.addEventListener('click', preview);
      panel.querySelectorAll<HTMLButtonElement>('[data-b]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const id = Number(btn.dataset.b);
          if (picked.has(id)) picked.delete(id);
          else if (picked.size < max) picked.add(id);
          sfx.mapHover();
          draw();
        }),
      );
      panel.querySelector('[data-a=fight]')!.addEventListener('click', () => {
        march(n, [...picked]);
      });
    };
    draw();
  };

  const dpr = () => window.devicePixelRatio || 1;
  const local = (e: { clientX: number; clientY: number }) => {
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr(), y: (e.clientY - r.top) * dpr() };
  };
  const known = revealed(run);
  const pick = (e: PointerEvent): number | null => {
    const p = local(e);
    let best: number | null = null, bestD = (30 * dpr()) ** 2;
    const here = run.nodes[run.at];
    const off = 12 * CAMP_AT * dpr();
    if ((view.ox + here.x * view.s + off - p.x) ** 2 + (view.oy + here.y * view.s - off - p.y) ** 2 < (16 * dpr()) ** 2) return run.at;
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
    if (moving) return;
    const n = pick(e);
    if (n !== null && n === run.at && run.status === 'active') return camp();
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
  if (intro && intro.from !== run.bloom.time) sfx.bloomAdvance();
  const frame = () => {
    if (!m.isConnected) {
      if (performance.now() - t0 > 3000) return; // never attached
      requestAnimationFrame(frame);
      return;
    }
    const time = (performance.now() - t0) / 1000;
    const k = intro ? Math.min(1, time / ANIM) : 1;
    const ease = k * k * (3 - 2 * k);
    const bloomT = intro ? intro.from + (run.bloom.time - intro.from) * ease : run.bloom.time;
    const freshT = intro ? Math.max(0, Math.min(1, (time - ANIM * 0.5) / ANIM)) : 1;
    if (!swallowSounded && freshT > 0 && fresh.size) {
      swallowSounded = true;
      [...fresh].forEach((_, i) => sfx.swallow(i));
    }
    if (!cam && c.clientWidth > 0) cam = homeCam(run, c.clientWidth * dpr(), c.clientHeight * dpr());
    fx.tick(time);
    // A burst of spores as each swallowed node goes under.
    if (!fx.burstDone && freshT >= 1 && fresh.size) {
      fx.burstDone = true;
      for (const id of fresh) fx.spores.burst(run.nodes[id].x, run.nodes[id].y, 36);
    }
    view = drawMap(c, run, { bloomT, selected, hover, time, fresh, freshT, cam: cam ?? undefined, fx, ghost: k >= 1 && !moving });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return m;
}

// ---- after a battle ---------------------------------------------------------

const EVENT_TEXT: Record<BroodEvent['what'], (e: BroodEvent) => string> = {
  grew: (e) => `grew to ${e.size}`,
  shrank: (e) => `came back with ${e.size}`,
  held: (e) => `held at ${e.size}`,
  wounded: (e) => `is wounded and down to ${e.size}: it sits out the next battle`,
  died: () => 'was wiped out',
  rescued: (e) => `joins you: a ${KIND_NAME[e.kind]} brood of ${e.size}`,
  veteran: () => 'is now veteran ★: its dots start tougher',
  recovered: () => 'has recovered',
};

/** What happened to warlords this turn: a domain you broke, a stronghold the Bloom ate. */
function lordText(run: RunState, res: TurnResult): string {
  const items = res.warlords.map(({ id, what }) => {
    const w = run.warlords![id];
    const name = `<b style="color:${FACTION_HEX[w.faction]}">♛ ${esc(w.name)}</b>`;
    return what === 'broken'
      ? `<li>${name}'s domain is broken. Trophy: <b>${esc(TRAITS[w.trait].trophy.name)}</b>. ${esc(TRAITS[w.trait].trophy.text)}.</li>`
      : `<li>The Bloom ate ${name}'s stronghold: the warlord is gone.</li>`;
  });
  return items.length ? `<ul class="brood-events warlord-events">${items.join('')}</ul>` : '';
}

export function runDebrief(run: RunState, node: RunNode, won: boolean, res: TurnResult, h: { next: () => void; hub: () => void }): HTMLDivElement {
  const over = run.status !== 'active';
  const restored = res.checkpoint === 'restored';
  const title = restored
    ? 'Back to the checkpoint'
    : run.status === 'won'
      ? 'Run complete'
      : run.status === 'lost'
        ? 'Run lost'
        : won
          ? 'Territory taken'
          : 'Driven back';
  const text = restored
    ? 'Your swarm was finished, but the checkpoint holds: the run resumes from there. It only saves you once.'
    : run.status === 'won'
      ? `The Bloom's heart is destroyed. ${run.turn} turns, ${run.biomass} biomass gathered.`
      : run.status === 'lost'
        ? run.lostTo === 'bloom'
          ? 'The Bloom closed every route. Your swarm is consumed.'
          : 'Your last brood is gone.'
        : won
          ? `${res.warlords.some((w) => w.what === 'broken') ? 'Citadel taken' : `${KIND_LABEL[node.kind]} won`}. +${res.biomass} biomass.`
          : 'Your swarm falls back. The Bloom advances anyway.';
  const events = restored ? [] : res.events;
  const foes = node.kind === 'start' ? [] : rivals(run, node.id);
  const m = el(`
    <div class="screen modal dim">
      <div class="card brief run-debrief ${run.status === 'won' || (won && !over) ? 'win' : 'lose'}">
        <div class="eyebrow">${esc(run.seedText)} · turn ${run.turn}</div>
        <h2>${title}</h2>
        <p>${text}</p>
        ${foes.length && !restored ? rivalStrip(foes, true, won ? 'beaten' : '') : ''}
        ${restored ? '' : lordText(run, res)}
        ${events.length ? `<ul class="brood-events">${events.map((e) => `<li><span class="glyph">${KIND_GLYPH[e.kind]}</span> <b>${esc(e.name)}</b> ${EVENT_TEXT[e.what](e)}</li>`).join('')}</ul>` : ''}
        ${res.checkpoint === 'reached' ? '<p class="hint">⚑ Checkpoint reached: if your swarm falls after this, the run restarts here once.</p>' : ''}
        <p>${broods(run)} <span class="hint">${run.biomass} biomass</span></p>
        <div class="row end">
          ${over ? '<button class="primary" data-a="hub">Campaign</button>' : '<button class="primary" data-a="next">Continue</button>'}
        </div>
      </div>
    </div>`);
  mountCreatures(m, foes.map((r) => r.creature), 48);
  m.querySelector('[data-a=next]')?.addEventListener('click', h.next);
  m.querySelector('[data-a=hub]')?.addEventListener('click', h.hub);
  return m;
}

// ---- starter pick -----------------------------------------------------------

const LAST_DIFFICULTY = 'swarm.runDifficulty';

export function starterPick(seed: string, h: { pick: (p: PackId, d: RunDifficulty) => void; back: () => void }): HTMLDivElement {
  const ids = Object.keys(PACKS) as PackId[];
  let difficulty: RunDifficulty = 'standard';
  try {
    const last = localStorage.getItem(LAST_DIFFICULTY) as RunDifficulty | null;
    if (last && DIFFICULTIES.includes(last)) difficulty = last;
  } catch {
    /* storage unavailable: Standard */
  }
  const m = el(`
    <div class="screen modal">
      <div class="card hub">
        <div class="eyebrow">${esc(seed)}</div>
        <h2>Choose your swarm</h2>
        <div class="field run-difficulty">
          <div class="seg wrap">${DIFFICULTIES.map((d) => `<button data-d="${d}">${RUN_DIFFICULTY[d].name}</button>`).join('')}</div>
          <p class="hint" data-a="blurb"></p>
        </div>
        <p class="hint">Your first broods, and what you can already use. Everything else is unlocked at the camp with biomass.</p>
        <div class="packs">
          ${ids
            .map(
              (id) => `<button class="pack" data-p="${id}">
                <b>${PACKS[id].name}</b>
                <span class="glyphs">${PACKS[id].kinds.map((k) => `${KIND_GLYPH[k]} ${KIND_NAME[k]}`).join(' + ')}</span>
                <small>${PACKS[id].blurb}</small>
              </button>`,
            )
            .join('')}
        </div>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  const blurb = m.querySelector('[data-a=blurb]') as HTMLElement;
  const showDifficulty = () => {
    m.querySelectorAll<HTMLButtonElement>('[data-d]').forEach((b) => b.classList.toggle('on', b.dataset.d === difficulty));
    blurb.textContent = RUN_DIFFICULTY[difficulty].blurb;
  };
  m.querySelectorAll<HTMLButtonElement>('[data-d]').forEach((b) =>
    b.addEventListener('click', () => {
      difficulty = b.dataset.d as RunDifficulty;
      showDifficulty();
    }),
  );
  showDifficulty();
  m.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) =>
    b.addEventListener('click', () => {
      try {
        localStorage.setItem(LAST_DIFFICULTY, difficulty);
      } catch {
        /* not remembered */
      }
      h.pick(b.dataset.p as PackId, difficulty);
    }),
  );
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

// ---- reward pick ------------------------------------------------------------

const TIER_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare' } as const;

/** What a reward card says beyond its text: whose it is, and what it replaces. */
function rewardNote(run: RunState, r: Reward): string {
  if (r.kind !== undefined) return `${KIND_GLYPH[r.kind]} ${KIND_NAME[r.kind]} strain: goes to one brood`;
  if (r.power) {
    const held = run.perks.find((p) => REWARD[p]?.power === r.power);
    return held ? `Replaces ${REWARD[held].name}` : POWER_LABEL[r.power];
  }
  return r.family === 'pact' ? 'A pact: it has a cost' : 'For the rest of the run';
}

/** After a won battle: pick 1 of 3 rewards, reroll for biomass, or skip. */
export function rewardPick(run: RunState, sfx: AudioEngine, h: { done: () => void; save: () => void }): HTMLDivElement {
  const m = el(`<div class="screen modal dim"><div class="card hub reward-card"></div></div>`);
  const card = m.firstElementChild as HTMLElement;
  const finish = (r: Reward) => {
    if (r.family === 'pact') sfx.pactTaken();
    else sfx.rewardPick(r.tier);
    h.save();
    h.done();
  };

  const offer = () => {
    const ids = run.offer?.ids ?? [];
    const cost = rerollCost(run);
    card.innerHTML = `
      <div class="eyebrow">${esc(run.seedText)} · turn ${run.turn}</div>
      <h2>Choose a reward</h2>
      <p class="hint">${run.biomass} biomass</p>
      <div class="rewards">${ids
        .map((id) => {
          const r = REWARD[id];
          return `<button class="reward ${r.tier}${r.family === 'pact' ? ' pact' : ''}" data-r="${id}">
            <span class="tag">${FAMILY_LABEL[r.family]} · ${TIER_LABEL[r.tier]}</span>
            <b>${r.name}</b>
            <span>${r.text}</span>
            <small>${rewardNote(run, r)}</small>
          </button>`;
        })
        .join('')}</div>
      <div class="row">
        <button data-a="skip">Skip</button>
        <button class="grow1" data-a="reroll" ${run.biomass >= cost ? '' : 'disabled'}>Reroll · ${cost} biomass</button>
      </div>`;
    card.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        const r = REWARD[b.dataset.r!];
        if (r.family === 'strain') return pickBrood(r);
        if (takeReward(run, r.id)) finish(r);
      }),
    );
    card.querySelector('[data-a=skip]')!.addEventListener('click', () => {
      skipReward(run);
      sfx.mapSelect();
      h.save();
      h.done();
    });
    card.querySelector('[data-a=reroll]')!.addEventListener('click', () => {
      if (!rerollOffer(run)) return;
      sfx.rerollOffer();
      h.save();
      offer();
    });
  };

  /** A strain: which brood of its kind gets it (and, if that brood is full, what it replaces). */
  const pickBrood = (r: Reward, full: Brood | null = null) => {
    sfx.mapHover();
    const mine = run.broods.filter((b) => b.kind === r.kind);
    const rows = full
      ? full.strains
          .map(
            (s) => `<button class="brood-pick" data-replace="${s}">
              <span class="glyph">✦</span>
              <span class="who"><b>Replace ${REWARD[s]?.name ?? s}</b><small>${REWARD[s]?.text ?? ''}</small></span>
            </button>`,
          )
          .join('')
      : mine
          .map(
            (b) => `<button class="brood-pick" data-b="${b.id}" ${b.strains.includes(r.id) ? 'disabled' : ''}>
              <span class="glyph">${KIND_GLYPH[b.kind]}</span>
              <span class="who"><b>${esc(b.name)}</b><small>${b.size}/${b.cap}${strainText(b, ' · ✦ ') || ' · no strains yet'}${b.strains.length >= STRAIN_SLOTS ? ' · full' : ''}</small></span>
            </button>`,
          )
          .join('');
    card.innerHTML = `
      <div class="eyebrow">${r.name} · ${KIND_NAME[r.kind!]} strain</div>
      <h2>${full ? `${esc(full.name)} has no room` : 'Which brood?'}</h2>
      <p class="hint">${full ? `A brood carries ${STRAIN_SLOTS} strains. Pick one to give up for ${r.name}.` : `${r.text}. It changes all the ${KIND_NAME[r.kind!]} you spawn in battles this brood fights.`}</p>
      <div class="brood-list">${rows}</div>
      <div class="row end"><button data-a="back">Back</button></div>`;
    card.querySelector('[data-a=back]')!.addEventListener('click', () => (full ? pickBrood(r) : offer()));
    card.querySelectorAll<HTMLButtonElement>('[data-b]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const b = run.broods.find((o) => o.id === Number(btn.dataset.b))!;
        if (b.strains.length >= STRAIN_SLOTS) return pickBrood(r, b);
        if (takeReward(run, r.id, b.id)) finish(r);
      }),
    );
    card.querySelectorAll<HTMLButtonElement>('[data-replace]').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (takeReward(run, r.id, full!.id, btn.dataset.replace)) finish(r);
      }),
    );
  };

  offer();
  sfx.cardsRevealed();
  return m;
}
