import { LEVEL, MAX_LEVEL, NEUTRAL, POWER, POWER_NEST, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS, TICK_HZ, type NestPower } from './constants';
import { clamp } from './mathx';
import { queryRadius } from './spatial';
import { pushFx, removeUnit, UNIT_FEEDING, type Nest, type World } from './world';

/**
 * Everything a player (human, bot, or later a remote peer) can do.
 * Units are referenced by uid, never by slot, so commands stay valid
 * across machines and ticks. Selection itself is client-only state.
 */
export type Command =
  | { t: 'move'; p: number; units: number[]; x: number; y: number; nest: number }
  | { t: 'rally'; p: number; nests: number[]; x: number; y: number }
  | { t: 'upgrade'; p: number; nest: number }
  | { t: 'surge'; p: number; units: number[] }
  | { t: 'nova'; p: number; units: number[] }
  | { t: 'fortify'; p: number; units: number[] }
  | { t: 'barrage'; p: number; x: number; y: number }
  | { t: 'blink'; p: number; units: number[]; x: number; y: number }
  | { t: 'lockdown'; p: number; nest: number }
  /** tutorial missions only (endless worlds): bring the next wild swarm forward to `secs` from now */
  | { t: 'summon'; p: number; secs: number };

/** True if p holds (fully controls) a nest that grants this power. */
export function hasPower(w: World, p: number, power: NestPower): boolean {
  const type = POWER_NEST[power];
  if (!(w.factions[p].nestTypes & (1 << type))) return false;
  for (const n of w.nests) if (n.owner === p && n.type === type && n.control >= 1) return true;
  return false;
}

/** Power multiplier from the best nest of its type held: level 3 boosts it. */
export function powerBoost(w: World, p: number, power: NestPower): number {
  const type = POWER_NEST[power];
  for (const n of w.nests) if (n.owner === p && n.type === type && n.control >= 1 && n.level >= 3) return LEVEL.powerBoost;
  return 1;
}

/** The nest a Barrage at (x, y) launches from: the nearest one p owns within range, or null. */
export function barrageLaunch(w: World, p: number, x: number, y: number): Nest | null {
  let best: Nest | null = null, bd = POWER.barrageRange * POWER.barrageRange;
  for (const n of w.nests) {
    if (n.owner !== p) continue;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d <= bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/** Ticks a Barrage shell takes to land: a short launch, then a fixed speed over the distance. */
export function barrageFlight(dx: number, dy: number): number {
  return Math.round((POWER.barrageLaunch + Math.sqrt(dx * dx + dy * dy) / POWER.barrageSpeed) * TICK_HZ);
}

/** Dots still needed to repair a nest's control and finish its next level. */
export function feedNeed(n: { control: number; level: number; feedProgress: number; feedIncoming: number }): number {
  const repair = n.control < 1 ? Math.ceil((1 - n.control) / LEVEL.repair - 1e-9) : 0;
  const grow = n.level < MAX_LEVEL ? UPGRADE_COST[n.level] - n.feedProgress : 0;
  return repair + grow - n.feedIncoming;
}

const scratch: number[] = [];

/** uids -> slots, keeping only idle-able units owned by p */
function resolve(w: World, p: number, uids: number[]): number[] {
  const out: number[] = [];
  for (const u of uids) {
    const s = w.uidToSlot.get(u);
    if (s === undefined || !w.alive[s] || w.owner[s] !== p || w.state[s] === UNIT_FEEDING) continue;
    out.push(s);
  }
  return out;
}

function centroid(w: World, slots: number[]): [number, number] {
  let sx = 0, sy = 0;
  for (const s of slots) {
    sx += w.x[s];
    sy += w.y[s];
  }
  return [sx / slots.length, sy / slots.length];
}

/** How far a Nova reaches from the middle of the `n` dots casting it. */
export function novaRadius(n: number): number {
  return Math.min(140, 70 + Math.sqrt(n) * 5);
}

export function groupArrive(n: number): number {
  return 6 + Math.sqrt(n) * 4.2;
}

export function applyCommand(w: World, c: Command): void {
  const f = w.factions[c.p];
  if (!f || !f.active || f.eliminated || w.over) return;

  switch (c.t) {
    case 'move': {
      const slots = resolve(w, c.p, c.units);
      if (slots.length === 0) return;
      let x = c.x, y = c.y, nestR = 0;
      const nest = w.nests[c.nest];
      if (nest) {
        x = nest.x;
        y = nest.y;
        nestR = nest.r;
      }
      x = clamp(x, 4, w.width - 4);
      y = clamp(y, 4, w.height - 4);
      if (!nest) [x, y] = w.terrain.freePoint(x, y);
      const ar = Math.max(nestR * 0.8, groupArrive(slots.length));
      for (const s of slots) {
        w.ox[s] = x;
        w.oy[s] = y;
        w.arrive[s] = ar;
      }
      return;
    }

    case 'rally': {
      for (const id of c.nests) {
        const n = w.nests[id];
        if (!n || n.owner !== c.p) continue;
        [n.rallyX, n.rallyY] = w.terrain.freePoint(clamp(c.x, 4, w.width - 4), clamp(c.y, 4, w.height - 4));
      }
      return;
    }

    case 'upgrade': {
      const n = w.nests[c.nest];
      // Feeding repairs a damaged nest's control first, then levels it up.
      if (!n || n.owner !== c.p) return;
      const need = feedNeed(n);
      if (need <= 0) return;
      queryRadius(w, n.x, n.y, UPGRADE_PICK_RADIUS, scratch);
      const cand: number[] = [];
      for (const s of scratch) {
        if (w.owner[s] === c.p && w.state[s] !== UNIT_FEEDING) cand.push(s);
      }
      if (cand.length < need) {
        pushFx(w, 'upgradeFail', n.x, n.y, c.p, need - cand.length, n.id);
        return;
      }
      const d2 = (s: number) => (w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2;
      cand.sort((a, b) => d2(a) - d2(b) || a - b);
      for (let k = 0; k < need; k++) {
        const s = cand[k];
        w.state[s] = UNIT_FEEDING;
        w.feedNest[s] = n.id;
        n.feedIncoming++;
      }
      return;
    }

    case 'surge': {
      if (f.energy < POWER.surgeCost) return;
      const slots = resolve(w, c.p, c.units);
      if (slots.length === 0) return;
      f.energy -= POWER.surgeCost;
      const until = w.tick + POWER.surgeTicks;
      for (const s of slots) w.surge[s] = until;
      const [cx, cy] = centroid(w, slots);
      pushFx(w, 'surge', cx, cy, c.p, groupArrive(slots.length) + 20);
      return;
    }

    case 'summon': {
      const ev = w.events;
      if (!w.endless || !ev?.spec.params.swarm) return;
      const at = w.tick + Math.max(1, Math.round(c.secs * TICK_HZ));
      if (ev.nextSwarm < 0 || ev.nextSwarm > at) ev.nextSwarm = at;
      return;
    }
    case 'nova': {
      if (f.energy < POWER.novaCost) return;
      const slots = resolve(w, c.p, c.units);
      if (slots.length < 4) return;
      f.energy -= POWER.novaCost;
      const [cx, cy] = centroid(w, slots);
      const R = novaRadius(slots.length);

      // Sacrifice the units closest to the center.
      const d2 = (s: number) => (w.x[s] - cx) ** 2 + (w.y[s] - cy) ** 2;
      slots.sort((a, b) => d2(a) - d2(b) || a - b);
      const k = Math.max(2, Math.floor(slots.length * POWER.novaSacrifice));
      for (let i = 0; i < k; i++) {
        const s = slots[i];
        w.deaths.push(w.x[s], w.y[s], w.owner[s]);
        f.stats.lost++;
        removeUnit(w, s);
      }

      queryRadius(w, cx, cy, R, scratch);
      for (const j of scratch) {
        if (!w.hostile(w.owner[j], c.p)) continue;
        const dx = w.x[j] - cx, dy = w.y[j] - cy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const fall = 1 - 0.5 * (d / R);
        w.dmg[j] += POWER.novaDamage * fall * (UNIT_STATS[w.kind[j]].hp > 20 ? 1.6 : 1);
        w.lastHit[j] = c.p;
        w.vx[j] += (dx / d) * POWER.novaKnock * fall;
        w.vy[j] += (dy / d) * POWER.novaKnock * fall;
      }
      pushFx(w, 'nova', cx, cy, c.p, R);
      return;
    }

    case 'fortify': {
      if (f.energy < POWER.fortifyCost || !hasPower(w, c.p, 'fortify')) return;
      const slots = resolve(w, c.p, c.units);
      if (slots.length === 0) return;
      f.energy -= POWER.fortifyCost;
      const until = w.tick + Math.round(POWER.fortifyTicks * powerBoost(w, c.p, 'fortify'));
      for (const s of slots) w.fortify[s] = until;
      const [cx, cy] = centroid(w, slots);
      pushFx(w, 'fortify', cx, cy, c.p, groupArrive(slots.length) + 14);
      return;
    }

    case 'barrage': {
      if (f.energy < POWER.barrageCost || !hasPower(w, c.p, 'barrage')) return;
      const x = clamp(c.x, 0, w.width), y = clamp(c.y, 0, w.height);
      const from = barrageLaunch(w, c.p, x, y);
      if (!from) return;
      f.energy -= POWER.barrageCost;
      const r = POWER.barrageRadius * powerBoost(w, c.p, 'barrage');
      const impact = w.tick + barrageFlight(x - from.x, y - from.y);
      w.barrages.push({ x, y, owner: c.p, impact, r, x0: from.x, y0: from.y, t0: w.tick });
      pushFx(w, 'barrage', x, y, c.p, r);
      return;
    }

    case 'blink': {
      if (f.energy < POWER.blinkCost || !hasPower(w, c.p, 'blink')) return;
      const slots = resolve(w, c.p, c.units);
      if (slots.length === 0) return;
      f.energy -= POWER.blinkCost;
      const [cx, cy] = centroid(w, slots);
      let dx = c.x - cx, dy = c.y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const range = POWER.blinkRange * powerBoost(w, c.p, 'blink');
      if (d > range) {
        dx *= range / d;
        dy *= range / d;
      }
      const ar = groupArrive(slots.length);
      // Blink jumps walls, but nobody lands inside one.
      const tr = w.terrain;
      for (const s of slots) {
        let nx = clamp(w.x[s] + dx, 2, w.width - 2), ny = clamp(w.y[s] + dy, 2, w.height - 2);
        if (tr.hasWalls && tr.collide(nx, ny, UNIT_STATS[w.kind[s]].size * 0.5)) {
          nx = tr.ox;
          ny = tr.oy;
        }
        w.x[s] = w.px[s] = nx;
        w.y[s] = w.py[s] = ny;
        [w.ox[s], w.oy[s]] = tr.freePoint(cx + dx, cy + dy);
        w.arrive[s] = ar;
      }
      pushFx(w, 'blink', cx + dx, cy + dy, c.p, ar + 10, -1, -1, cx, cy);
      return;
    }

    case 'lockdown': {
      if (f.energy < POWER.lockdownCost || !hasPower(w, c.p, 'lockdown')) return;
      const n = w.nests[c.nest];
      if (!n || n.owner < 0 || n.owner === NEUTRAL || !w.hostile(n.owner, c.p)) return;
      f.energy -= POWER.lockdownCost;
      n.lockedUntil = w.tick + Math.round(POWER.lockdownTicks * powerBoost(w, c.p, 'lockdown'));
      pushFx(w, 'lockdown', n.x, n.y, c.p, n.r, n.id, n.owner);
      return;
    }
  }
}
