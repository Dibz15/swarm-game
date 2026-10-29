import { Kind, LEVEL, MAX_LEVEL, NEUTRAL, PACTS, POWER, POWER_NEST, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS, TICK_HZ, VARIANTS, type NestPower } from './constants';
import { clamp } from './mathx';
import { takeBoon } from './siege';
import { queryRadius } from './spatial';
import { inArmy, pushFx, removeUnit, spawnUnit, UNIT_FEEDING, type Nest, type World } from './world';

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
  | { t: 'summon'; p: number; secs: number }
  /** Hold the line (#67): take boon `k` of the current offer */
  | { t: 'boon'; p: number; k: number };

/** True if p holds (fully controls) a nest that grants this power. */
export function hasPower(w: World, p: number, power: NestPower): boolean {
  if (w.factions[p].mods.noPowers) return false;
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
    if (s === undefined || w.owner[s] !== p || !inArmy(w, s)) continue;
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

/** How far a Nova reaches from the middle of the `n` dots casting it (`mult`: the caster's mods). */
export function novaRadius(n: number, mult = 1): number {
  return Math.min(140, 70 + Math.sqrt(n) * 5) * mult;
}

/** What a Surge costs p. */
export const surgeCost = (w: World, p: number): number => POWER.surgeCost * w.factions[p].mods.surgeCost;

export function groupArrive(n: number): number {
  return 6 + Math.sqrt(n) * 4.2;
}

/**
 * Blink Echo (#60): harmless ghosts stay behind where the group was. They draw
 * fire like Shields, never fight or capture, and don't count toward the army.
 */
function echo(w: World, p: number, slots: number[], cx: number, cy: number): void {
  const E = VARIANTS.echo;
  const n = Math.min(E.max, Math.max(1, Math.round(slots.length * E.per)));
  for (let k = 0; k < n; k++) {
    const s = slots[k];
    // Spread them over the group's footprint.
    const x = (w.x[s] + cx) / 2, y = (w.y[s] + cy) / 2;
    const g = spawnUnit(w, p, Kind.Dot, x, y, x, y, 4);
    if (g < 0) return;
    w.ghost[g] = w.tick + E.ticks;
    w.hp[g] = E.hp;
    w.unitCount[p]--;
    w.ghosts++;
  }
}

/** Blood price (#60): the units a power costs instead of `energy`. */
export const bloodCost = (energy: number): number => Math.ceil(energy / PACTS.bloodPerUnit);

/**
 * Sacrifice n of p's units from `slots` for a power, those nearest (x, y)
 * first. Returns the rest.
 */
function sacrifice(w: World, p: number, slots: number[], n: number, x: number, y: number): number[] {
  const d2 = (s: number) => (w.x[s] - x) ** 2 + (w.y[s] - y) ** 2;
  const order = [...slots].sort((a, b) => d2(a) - d2(b) || a - b);
  for (let k = 0; k < n; k++) {
    const s = order[k];
    w.deaths.push(w.x[s], w.y[s], p);
    w.factions[p].stats.lost++;
    removeUnit(w, s);
  }
  return order.slice(n);
}

/**
 * Pay for a power: its energy, or under Blood price its units. A group power
 * (`group` given) needs someone in it and pays from it (those nearest its
 * middle, as Nova does), leaving at least `keep`; other powers (`group` null)
 * pay with p's units nearest (x, y). Returns the group left to cast with, or
 * null if p can't cast.
 */
function pay(w: World, p: number, cost: number, group: number[] | null, keep: number, x = 0, y = 0): number[] | null {
  if (group && group.length < Math.max(1, keep)) return null;
  const f = w.factions[p];
  if (!f.mods.bloodPrice) {
    if (f.energy < cost) return null;
    f.energy -= cost;
    return group ?? [];
  }
  const n = bloodCost(cost);
  let from = group;
  if (from) [x, y] = centroid(w, from);
  else {
    from = [];
    for (let i = 0; i < w.n; i++) if (w.owner[i] === p && inArmy(w, i)) from.push(i);
  }
  if (from.length - n < Math.max(1, keep)) return null;
  const rest = sacrifice(w, p, from, n, x, y);
  return group ? rest : [];
}

const POWERS = new Set<Command['t']>(['surge', 'nova', 'fortify', 'barrage', 'blink', 'lockdown']);

export function applyCommand(w: World, c: Command): void {
  const f = w.factions[c.p];
  if (!f || !f.active || f.eliminated || w.over) return;
  // Feral (#60): no powers at all.
  if (f.mods.noPowers && POWERS.has(c.t)) return;

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
        if (w.owner[s] === c.p && inArmy(w, s)) cand.push(s);
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
      const slots = pay(w, c.p, surgeCost(w, c.p), resolve(w, c.p, c.units), 1);
      if (!slots) return;
      const until = w.tick + Math.round(POWER.surgeTicks * f.mods.surgeTicks);
      for (const s of slots) w.surge[s] = until;
      const [cx, cy] = centroid(w, slots);
      pushFx(w, 'surge', cx, cy, c.p, groupArrive(slots.length) + 20);
      return;
    }

    case 'boon':
      takeBoon(w, c.p, c.k);
      return;
    case 'summon': {
      const ev = w.events;
      if (!w.endless || !ev?.spec.params.swarm) return;
      const at = w.tick + Math.max(1, Math.round(c.secs * TICK_HZ));
      if (ev.nextSwarm < 0 || ev.nextSwarm > at) ev.nextSwarm = at;
      return;
    }
    case 'nova': {
      const slots = pay(w, c.p, POWER.novaCost, resolve(w, c.p, c.units), 4);
      if (!slots) return;
      const [cx, cy] = centroid(w, slots);
      const R = novaRadius(slots.length, f.mods.novaRadius);

      // Sacrifice the units closest to the center.
      sacrifice(w, c.p, slots, Math.max(2, Math.floor(slots.length * POWER.novaSacrifice)), cx, cy);

      queryRadius(w, cx, cy, R, scratch);
      for (const j of scratch) {
        if (!w.hostile(w.owner[j], c.p)) continue;
        const dx = w.x[j] - cx, dy = w.y[j] - cy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const fall = 1 - 0.5 * (d / R);
        // Implode: weaker, and it pulls them in instead of throwing them out.
        const implode = f.mods.implode;
        w.dmg[j] += POWER.novaDamage * f.mods.novaDamage * fall * (UNIT_STATS[w.kind[j]].hp > 20 ? 1.6 : 1) * (implode ? VARIANTS.implode.damage : 1);
        w.lastHit[j] = c.p;
        const knock = POWER.novaKnock * fall * (implode ? -1 : 1);
        w.vx[j] += (dx / d) * knock;
        w.vy[j] += (dy / d) * knock;
      }
      pushFx(w, 'nova', cx, cy, c.p, R);
      return;
    }

    case 'fortify': {
      if (!hasPower(w, c.p, 'fortify')) return;
      const slots = pay(w, c.p, POWER.fortifyCost, resolve(w, c.p, c.units), 1);
      if (!slots) return;
      const until = w.tick + Math.round(POWER.fortifyTicks * powerBoost(w, c.p, 'fortify'));
      for (const s of slots) w.fortify[s] = until;
      const [cx, cy] = centroid(w, slots);
      pushFx(w, 'fortify', cx, cy, c.p, groupArrive(slots.length) + 14);
      return;
    }

    case 'barrage': {
      if (!hasPower(w, c.p, 'barrage')) return;
      const x = clamp(c.x, 0, w.width), y = clamp(c.y, 0, w.height);
      const from = barrageLaunch(w, c.p, x, y);
      if (!from || !pay(w, c.p, POWER.barrageCost, null, 1, from.x, from.y)) return;
      const r = POWER.barrageRadius * powerBoost(w, c.p, 'barrage');
      const impact = w.tick + barrageFlight(x - from.x, y - from.y);
      if (f.mods.cluster) {
        // Cluster: three smaller shells in a triangle round the aim point, one after another.
        const C = VARIANTS.cluster;
        const dx = x - from.x, dy = y - from.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / d, uy = dy / d;
        const at: [number, number][] = [
          [ux, uy],
          [-ux * 0.5 - uy * 0.87, -uy * 0.5 + ux * 0.87],
          [-ux * 0.5 + uy * 0.87, -uy * 0.5 - ux * 0.87],
        ];
        at.forEach(([ox, oy], k) => {
          const bx = clamp(x + ox * C.spread, 0, w.width), by = clamp(y + oy * C.spread, 0, w.height);
          w.barrages.push({ x: bx, y: by, owner: c.p, impact: impact + k * C.stagger, r: r * C.r, x0: from.x, y0: from.y, t0: w.tick, budget: C.budget });
        });
      } else w.barrages.push({ x, y, owner: c.p, impact, r, x0: from.x, y0: from.y, t0: w.tick });
      pushFx(w, 'barrage', x, y, c.p, f.mods.cluster ? r + VARIANTS.cluster.spread : r);
      return;
    }

    case 'blink': {
      if (!hasPower(w, c.p, 'blink')) return;
      const slots = pay(w, c.p, POWER.blinkCost, resolve(w, c.p, c.units), 1);
      if (!slots) return;
      const [cx, cy] = centroid(w, slots);
      let dx = c.x - cx, dy = c.y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const range = POWER.blinkRange * powerBoost(w, c.p, 'blink') * f.mods.blinkRange;
      if (d > range) {
        dx *= range / d;
        dy *= range / d;
      }
      const ar = groupArrive(slots.length);
      if (f.mods.echo) echo(w, c.p, slots, cx, cy);
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
      if (!hasPower(w, c.p, 'lockdown')) return;
      const n = w.nests[c.nest];
      if (!n || n.owner < 0 || n.owner === NEUTRAL || !w.hostile(n.owner, c.p)) return;
      if (!pay(w, c.p, POWER.lockdownCost, null, 1, n.x, n.y)) return;
      n.lockedUntil = w.tick + Math.round(POWER.lockdownTicks * powerBoost(w, c.p, 'lockdown') * f.mods.lockdownTicks);
      n.lockedBy = c.p;
      pushFx(w, 'lockdown', n.x, n.y, c.p, n.r, n.id, n.owner);
      return;
    }
  }
}
