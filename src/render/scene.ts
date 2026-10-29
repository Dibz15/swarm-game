import { FACTION_RGB, WHITE, mixRgb, type RGB } from '../content/factions';
import { bastionRange, DAMAGE_VS, DOMINATION, EVENTS, Kind, NEUTRAL, NestType, POWER, UNIT_FEEDING, UNIT_STATS, UPGRADE_COST } from '../sim/index';
import { HEART, heartSlot, standingNests } from '../sim/heart';
import { WILD_HEART, type World } from '../sim/world';
import type { Renderer } from './renderer';
import type { TraitId } from '../campaign/warlords';

export interface SceneOpts {
  alpha: number;
  time: number;
  frame: number;
  /** slot mask of selected units, or null */
  selected: Uint8Array | null;
  selectedNests: ReadonlySet<number>;
  hoverNest: number;
  human: number;
  /** a campaign warlord in this battle (#66, #100): its units wear its trait's look */
  warlord?: { faction: number; trait: TraitId } | null;
}

/** Nest outline echoes its unit: Hive hex, Forge block, Spire needle, Den arrowhead, Bastion octagon. */
const NEST_SHAPE = [1, 2, 4, 3, 5];
const NEST_SPIN = [0.22, 0.1, -0.28, 0.7, 0.12];
const UNOWNED: RGB = [70, 76, 96];
/** wild event units: ash red, so they don't read as gray garrisons */
export const FERAL: RGB = [214, 92, 78];
export const DROP_RGB: RGB = [255, 226, 140];
const SELECT_MIX = 0.5;

export function drawWorld(r: Renderer, w: World, o: SceneOpts): void {
  r.useTerrain(w.terrain);
  drawCrystals(r, w, o);
  drawNests(r, w, o);
  drawBeams(r, w, o);
  drawUnits(r, w, o);
  drawBarrages(r, w, o);
  drawEvents(r, w, o);
}

const CRYSTAL_RGB: RGB = [170, 225, 255];

/** Energy crystals: a spinning shard cluster that takes the holder's color. */
function drawCrystals(r: Renderer, w: World, o: SceneOpts): void {
  for (let k = 0; k < w.crystals.length; k++) {
    const c = w.crystals[k];
    const held = c.holder >= 0;
    const col = held ? mixRgb(FACTION_RGB[c.holder], WHITE, 0.25) : CRYSTAL_RGB;
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 3 + k);
    // Zone ring: dim when free, the holder's color while charging.
    r.shape(false, c.x, c.y, c.r, 0, 1, 0, 0.025, col, held ? Math.round(110 + 70 * pulse) : 55);
    r.shape(false, c.x, c.y, c.r, 7, 1, 0, 0, col, held ? 22 : 10);
    // Core: a slow hex with shards orbiting it.
    r.shape(false, c.x, c.y, 9, 1, 0, o.time * 0.6 + k, 0.6, col, 230);
    for (let s = 0; s < 3; s++) {
      const a = o.time * (held ? 1.6 : 0.5) + (s * Math.PI * 2) / 3 + k;
      const d = 14 + 2 * Math.sin(o.time * 2 + s);
      r.unit(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, 4.2, col[0], col[1], col[2], 235, 2, a + Math.PI / 2);
    }
  }
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

    // Levels read at any zoom: a bigger, brighter body, harder spawn pulses,
    // and one extra orbit ring per level.
    const lv = n.level - 1;
    const R = n.r * (1 + 0.1 * lv);
    const spawnPulse = Math.max(0, 1 - (w.tick - n.lastSpawn) / 8) * (0.6 + 0.3 * lv);
    const bodyA = n.owner < 0 ? 170 : n.owner === NEUTRAL ? 200 : 255;
    r.shape(false, n.x, n.y, R, NEST_SHAPE[n.type], progress, o.time * NEST_SPIN[n.type], spawnPulse + 0.12 * lv, c, bodyA, ringC, ringA);
    for (let l = 1; l <= lv; l++) {
      const tierA = n.owner < 0 ? 90 : 170;
      r.shape(false, n.x, n.y, R * (1.12 + 0.13 * l), 0, 1, 0, 0.035 + 0.01 * l, c, tierA);
      // A bead orbiting each tier ring, so upgraded nests visibly turn.
      const a = o.time * (0.8 + 0.4 * l) * (l % 2 ? 1 : -1) + n.id;
      const rr = R * (1.12 + 0.13 * l);
      r.unit(n.x + Math.cos(a) * rr, n.y + Math.sin(a) * rr, 4, c[0], c[1], c[2], 255);
    }

    // Nests of a dominating team throb, faster as the clock runs down.
    if (n.owner >= 0 && n.owner !== NEUTRAL && w.domTicks[w.teamOf[n.owner]] > 0) {
      const k = w.domTicks[w.teamOf[n.owner]] / DOMINATION.ticks;
      const beat = 0.5 + 0.5 * Math.sin(o.time * (4 + 10 * k));
      r.shape(true, n.x, n.y, R * (1.6 + 0.25 * beat), 0, 1, 0, 0.05, c, Math.round(90 + 140 * beat));
      r.shape(false, n.x, n.y, R * 1.9, 7, 1, 0, 0, c, Math.round(18 + 30 * beat));
    }

    // Capitals wear a second, slowly counter-rotating ring.
    if (n.capital && n.owner >= 0 && n.owner !== NEUTRAL) {
      r.shape(false, n.x, n.y, n.r * 1.2, 0, 0.92, 0, 0.035, c, 120);
    }
    // A warlord's capital wears a crown (#66); a stronghold's citadel a bigger one,
    // and a slow ring of battlements while it stands (#100).
    const citadel = n.id === w.citadel;
    const lordCap = !!o.warlord && n.capital && n.owner === o.warlord.faction;
    if (citadel || lordCap) {
      const lc = FACTION_RGB[o.warlord?.faction ?? n.owner] ?? c;
      if (lordCap && o.warlord!.trait === 'broodmother') {
        const beat = Math.pow(0.5 + 0.5 * Math.sin(o.time * 2.2), 2);
        r.shape(true, n.x, n.y, R * (1.35 + 0.12 * beat), 0, 1, 0, 0.06, lc, Math.round(60 + 100 * beat));
      }
      if (citadel && n.owner !== o.human) r.shape(false, n.x, n.y, R * 1.55, 0, 0.9, o.time * 0.15, 0.05, lc, 150);
      crownAt(r, n.x, n.y - R * (citadel ? 1.9 : 1.6), citadel ? 1.6 : 1.1, lc);
    }

    // Level pips under the nest.
    const pipY = n.y + R * (1.25 + 0.13 * lv) + 6;
    for (let l = 0; l < n.level; l++) {
      const px = n.x + (l - (n.level - 1) / 2) * 8;
      r.unit(px, pipY, 4, c[0], c[1], c[2], n.owner < 0 ? 140 : 255);
    }

    // Feeding meter: solid for dots delivered, faint for dots on the way.
    if (n.feedProgress > 0 || n.feedIncoming > 0) {
      const cost = UPGRADE_COST[n.level] || 1;
      const mr = R * (1.12 + 0.13 * (lv + 1));
      r.shape(true, n.x, n.y, mr, 0, 1, 0, 0.04, WHITE, 45);
      r.shape(true, n.x, n.y, mr, 0, Math.min(1, (n.feedProgress + n.feedIncoming) / cost), 0, 0.08, WHITE, 70);
      r.shape(true, n.x, n.y, mr, 0, n.feedProgress / cost, 0, 0.08, WHITE, 235);
    }

    if (n.type === NestType.Bastion && n.owner >= 0) {
      const range = bastionRange(w, n);
      const a = selected || hover ? 90 : n.owner === NEUTRAL ? 28 : 18;
      r.shape(false, n.x, n.y, range, 0, 1, 0, 1.2 / range, c, a);
    }

    if (own && (n.rallyX !== n.x || n.rallyY !== n.y)) {
      const a = selected ? 150 : 45;
      r.beam(n.x, n.y, n.rallyX, n.rallyY, c[0], c[1], c[2], a);
      r.shape(true, n.rallyX, n.rallyY, 6, 0, 1, o.time, 0.25, c, selected ? 200 : 70);
    }

    // Lockdown: a white ring that drains as the lock runs out.
    if (n.lockedUntil > w.tick) {
      const left = Math.min(1, (n.lockedUntil - w.tick) / POWER.lockdownTicks);
      r.shape(true, n.x, n.y, n.r * 1.3, 0, left, -o.time * 2, 0.07, WHITE, 230);
      r.shape(true, n.x, n.y, n.r * 0.9, 4, 0, o.time * 3, 0.5, WHITE, 120);
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

/** Beam width (px) by attacker kind: Lancers fire heavy beams. */
const BEAM_WIDTH = [1.6, 2.2, 2.8, 1.2];

function drawBeams(r: Renderer, w: World, o: SceneOpts): void {
  const a = o.alpha;
  const flick = o.frame >> 1;
  for (let k = 0; k < w.beamCount; k++) {
    const s = w.beams[k * 2];
    const t = w.beams[k * 2 + 1];
    let x1: number, y1: number, owner: number, width: number;
    if (s < 0) {
      const n = w.nests[-s - 1];
      x1 = n.x;
      y1 = n.y;
      owner = n.owner;
      width = 2.4;
    } else {
      x1 = w.px[s] + (w.x[s] - w.px[s]) * a;
      y1 = w.py[s] + (w.y[s] - w.py[s]) * a;
      owner = w.owner[s];
      width = BEAM_WIDTH[w.kind[s]];
    }
    const x2 = w.px[t] + (w.x[t] - w.px[t]) * a;
    const y2 = w.py[t] + (w.y[t] - w.py[t]) * a;
    let c = FACTION_RGB[owner] ?? UNOWNED;
    const lancer = s >= 0 && w.kind[s] === Kind.Lancer;
    let alpha = s < 0 || lancer ? 200 + Math.round(55 * hash01(k, flick)) : Math.round(50 + 170 * hash01(k, flick));
    // Counters read in the fight: strong hits are thick and hot, weak ones thin and dim.
    if (s >= 0) {
      const eff = DAMAGE_VS[w.kind[s]][w.kind[t]];
      if (eff >= 1.3) {
        width *= 1.6;
        c = mixRgb(c, WHITE, 0.35);
        alpha = Math.max(alpha, 190);
      } else if (eff <= 0.75) {
        width *= 0.6;
        alpha = Math.round(alpha * 0.4);
      }
    }
    r.beam(x1, y1, x2, y2, c[0], c[1], c[2], alpha, width);
  }
}

function drawUnits(r: Renderer, w: World, o: SceneOpts): void {
  const a = o.alpha;
  const sel = o.selected;
  const surgeGlow = 0.5 + 0.5 * Math.sin(o.time * 18);
  const lit: RGB[] = FACTION_RGB.map((c) => mixRgb(c, WHITE, SELECT_MIX));
  // The warlord's units (#100): a pale halo on all of them, and their trait's look.
  const lord = o.warlord?.faction ?? -1;
  const trait = o.warlord?.trait;
  const halo = lord >= 0 ? mixRgb(FACTION_RGB[lord], WHITE, 0.55) : WHITE;
  const swarmBeat = 1 + 0.18 * Math.sin(o.time * 6);
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i]) continue;
    const x = w.px[i] + (w.x[i] - w.px[i]) * a;
    const y = w.py[i] + (w.y[i] - w.py[i]) * a;
    const owner = w.owner[i];
    const kind = w.kind[i];
    let c = sel && sel[i] ? lit[owner] : w.wild[i] ? FERAL : FACTION_RGB[owner];
    let size = UNIT_STATS[kind].size;
    // The Bloom's heart: bigger, and it throbs (faster as it weakens).
    if (w.wild[i] === WILD_HEART) {
      const beat = Math.pow(0.5 + 0.5 * Math.sin(o.time * (2.4 + 1.2 * (w.heart?.phase ?? 0))), 3);
      size = HEART.size * (1 + 0.09 * beat);
      c = mixRgb(HEART_RGB, WHITE, 0.15 * beat);
    }
    let alpha = owner === NEUTRAL ? 200 : 255;
    if (w.surge[i] > w.tick) {
      c = mixRgb(c, WHITE, 0.25 * surgeGlow);
      size *= 1.15;
    }
    if (w.state[i] === UNIT_FEEDING) alpha = 190;
    // Veterans from level-3 nests: a touch bigger and brighter.
    if (w.vet[i]) {
      size *= 1.15;
      c = mixRgb(c, WHITE, 0.18);
    }

    // Heading: face the target while fighting, else the direction of travel.
    let angle = 0;
    if (kind === Kind.Colossus) angle = o.time * 0.4 + i;
    else if (kind === Kind.Lancer || kind === Kind.Swift) {
      const t = w.tgt[i];
      if (w.engaged[i] && t >= 0) angle = Math.atan2(w.y[t] - w.y[i], w.x[t] - w.x[i]);
      else angle = Math.atan2(w.vy[i], w.vx[i]);
    }
    // Swifts leave a faint streak behind them (a Raider-king's, long and bright).
    const lords = owner === lord;
    if (kind === Kind.Swift) {
      const sp2 = w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i];
      const king = lords && trait === 'raider-king';
      if (sp2 > 400) r.beam(x - w.vx[i] * (king ? 0.4 : 0.16), y - w.vy[i] * (king ? 0.4 : 0.16), x, y, c[0], c[1], c[2], king ? 150 : 70, king ? 2.2 : 1.4);
    }
    const shape = kind + (w.fortify[i] > w.tick ? 10 : 0);
    if (lords) {
      if (trait === 'swarmlord' && kind === Kind.Dot) size *= swarmBeat;
      r.unit(x, y, size * 1.7, halo[0], halo[1], halo[2], 70, shape, angle);
      if (trait === 'ironhide' && kind === Kind.Tank) r.shape(false, x, y, size * 1.15, 5, 1, angle, 0.2, mixRgb(c, WHITE, 0.35), 170);
      if (trait === 'longspine' && kind === Kind.Lancer) {
        const sx = Math.cos(angle), sy = Math.sin(angle);
        r.beam(x, y, x + sx * size * 2.6, y + sy * size * 2.6, c[0], c[1], c[2], 200, 1.3);
      }
      if (trait === 'stormcaller' && (i * 7 + o.frame) % 41 === 0) {
        const k = (i * 13 + o.frame) % 8;
        r.unit(x + Math.cos(k) * size * 1.6, y + Math.sin(k) * size * 1.6, 2.2, 220, 235, 255, 240);
      }
    }
    r.unit(x, y, size, c[0], c[1], c[2], alpha, shape, angle);
  }
}

/** A crown above a warlord's capital: three points over a band. */
function crownAt(r: Renderer, x: number, y: number, s: number, c: RGB): void {
  r.beam(x - 8 * s, y + 3 * s, x + 8 * s, y + 3 * s, c[0], c[1], c[2], 240, 3 * s);
  r.shape(true, x - 6 * s, y, 4.5 * s, 3, 0, 0, 0.6, c, 240);
  r.shape(true, x, y - 1.5 * s, 6 * s, 3, 0, 0, 0.6, c, 240);
  r.shape(true, x + 6 * s, y, 4.5 * s, 3, 0, 0, 0.6, c, 240);
}

/** Supply drops (falling beacon, then a capture ring) and Colossus health rings. */
function drawEvents(r: Renderer, w: World, o: SceneOpts): void {
  const ev = w.events;
  if (!ev) return;
  const R = EVENTS.dropRadius;
  for (const d of ev.drops) {
    const left = (d.lands - w.tick - o.alpha) / EVENTS.dropTelegraph;
    if (left > 0) {
      // Incoming: a ring closing in, and a column of light.
      r.shape(true, d.x, d.y, R * (1 + left * 2.5), 0, 1, o.time, 0.03, DROP_RGB, Math.round(90 + 120 * (1 - left)));
      r.shape(false, d.x, d.y, R, 7, 1, 0, 0, DROP_RGB, Math.round(30 * (1 - left)));
      r.beam(d.x, d.y - 260 * left - 20, d.x, d.y, DROP_RGB[0], DROP_RGB[1], DROP_RGB[2], Math.round(160 * (1 - left)), 3);
      continue;
    }
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 4);
    const hc = d.holder >= 0 ? FACTION_RGB[d.holder] : DROP_RGB;
    r.shape(false, d.x, d.y, 11, 2, 0, o.time * 1.5, 0.5, DROP_RGB, 240);
    r.shape(false, d.x, d.y, R, 7, 1, 0, 0, DROP_RGB, Math.round(14 + 14 * pulse));
    r.shape(true, d.x, d.y, R, 0, 1, 0, 0.02, DROP_RGB, Math.round(70 + 60 * pulse));
    if (d.progress > 0) r.shape(true, d.x, d.y, R + 6, 0, d.progress, 0, 0.07, hc, 235);
  }
  drawHeart(r, w, o);
  for (const c of ev.colossi) {
    const s = w.uidToSlot.get(c.uid);
    if (s === undefined) continue;
    const x = w.px[s] + (w.x[s] - w.px[s]) * o.alpha, y = w.py[s] + (w.y[s] - w.py[s]) * o.alpha;
    r.shape(true, x, y, 30, 0, w.hp[s] / c.maxHp, 0, 0.06, FERAL, 220);
    r.shape(true, x, y, 30, 0, 1, 0, 0.03, FERAL, 50);
  }
}

/** The Bloom's heart, a deeper red than the other wild units. */
const HEART_RGB: RGB = [196, 54, 74];

/**
 * The heart's rings: health, a ward band (one notch per standing Bloom nest,
 * each of which also wears a ring), and the pulse: a glow that swells through
 * the wind-up toward the ring it will hit.
 */
function drawHeart(r: Renderer, w: World, o: SceneOpts): void {
  const h = w.heart;
  if (!h || h.slain) return;
  const s = heartSlot(w);
  if (s < 0) return;
  const R = HEART.size + 16;
  r.shape(true, h.x, h.y, R, 0, w.hp[s] / h.maxHp, 0, 0.07, HEART_RGB, 230);
  r.shape(true, h.x, h.y, R, 0, 1, 0, 0.035, HEART_RGB, 50);
  const ward = standingNests(w);
  for (let k = 0; k < ward; k++) {
    r.shape(true, h.x, h.y, R + 9 + k * 6, 0, 1, o.time * 0.3 + k, 0.02, FERAL, 120);
  }
  for (const id of h.nests) {
    const n = w.nests[id];
    if (n.owner !== NEUTRAL) continue;
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 2 + id);
    r.shape(true, n.x, n.y, n.r + 10, 0, 1, o.time * 0.4, 0.04, FERAL, Math.round(90 + 80 * pulse));
  }
  if (h.pulseAt >= 0) {
    const k = 1 - Math.max(0, (h.pulseAt - w.tick - o.alpha) / HEART.pulseWindup);
    const pr = HEART.pulseR + HEART.pulseRPerPhase * h.phase;
    r.shape(true, h.x, h.y, pr, 7, 1, 0, 0, HEART_RGB, Math.round(70 * k));
    r.shape(true, h.x, h.y, pr, 0, 1, 0, 0.02, HEART_RGB, Math.round(120 + 120 * k));
    r.shape(true, h.x, h.y, pr * k, 0, 1, 0, 0.05, WHITE, Math.round(160 * k));
  }
}

const SHADOW: RGB = [0, 0, 0];

/**
 * Pending Barrage strikes: a shell arcs from the nest that launched it, its
 * shadow sliding along the ground, while a ring closes in on the impact zone.
 */
function drawBarrages(r: Renderer, w: World, o: SceneOpts): void {
  for (const b of w.barrages) {
    const c = b.owner === NEUTRAL ? HEART_RGB : FACTION_RGB[b.owner] ?? WHITE;
    const left = Math.max(0, (b.impact - w.tick - o.alpha) / Math.max(1, b.impact - b.t0));
    const R = b.r;
    const k = 1 - left;
    const dx = b.x - b.x0, dy = b.y - b.y0;
    // Apex height grows with range; "up" is up the screen (top-down view).
    const H = Math.min(240, 50 + Math.sqrt(dx * dx + dy * dy) * 0.45);
    const at = (t: number): [number, number] => [b.x0 + dx * t, b.y0 + dy * t - 4 * t * (1 - t) * H];
    if (k < 0.15) r.shape(true, b.x0, b.y0, 14 + k * 160, 0, 1, 0, 0.12, c, Math.round(200 * (1 - k / 0.15)));
    r.shape(true, b.x0 + dx * k, b.y0 + dy * k, 6 + 5 * k, 7, 1, 0, 0, SHADOW, 130);
    for (let s = 8; s >= 1; s--) {
      const [tx, ty] = at(Math.max(0, k - s * 0.022));
      r.shape(true, tx, ty, 6.5 - s * 0.6, 7, 1, 0, 0, c, 220 - s * 24);
    }
    const [hx, hy] = at(k);
    r.shape(true, hx, hy, 16, 7, 1, 0, 0, c, 80);
    r.shape(true, hx, hy, 7, 7, 1, 0, 0, WHITE, 255);
    r.shape(true, b.x, b.y, R, 0, 1, 0, 0.025, c, 150);
    r.shape(true, b.x, b.y, R * (1 + left * 1.2), 0, 1, 0, 0.04, c, Math.round(220 * (1 - left * 0.5)));
    r.shape(true, b.x, b.y, R, 7, 1, 0, 0, c, Math.round(40 + 60 * (1 - left)));
  }
}
