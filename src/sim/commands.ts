import { MAX_LEVEL, POWER, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS } from './constants';
import { clamp } from './mathx';
import { queryRadius } from './spatial';
import { pushFx, removeUnit, UNIT_FEEDING, type World } from './world';

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
  | { t: 'nova'; p: number; units: number[] };

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
        n.rallyX = clamp(c.x, 4, w.width - 4);
        n.rallyY = clamp(c.y, 4, w.height - 4);
      }
      return;
    }

    case 'upgrade': {
      const n = w.nests[c.nest];
      if (!n || n.owner !== c.p || n.level >= MAX_LEVEL || n.control < 1) return;
      const need = UPGRADE_COST[n.level] - n.feedProgress - n.feedIncoming;
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

    case 'nova': {
      if (f.energy < POWER.novaCost) return;
      const slots = resolve(w, c.p, c.units);
      if (slots.length < 4) return;
      f.energy -= POWER.novaCost;
      const [cx, cy] = centroid(w, slots);
      const R = Math.min(175, 64 + Math.sqrt(slots.length) * 7.5);

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
  }
}
