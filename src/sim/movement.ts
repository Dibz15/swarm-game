import { DT, HOLD_EXTRA, Kind, LEASH, LEVEL, MAX_LEVEL, POWER, STRAINS, TERRAIN, TRAITS, UNIT_STATS, UPGRADE_COST, VARIANTS } from './constants';
import { T_NEBULA, T_RIFT } from './terrain';
import { maxHp, pushFx, removeUnit, UNIT_FEEDING, UNIT_RETREAT, WILD_HEART, type Nest, type World } from './world';

const MAX_SEP_SCAN = 22;
const STEER = 0.3;

/** Radius of the nest whose ring contains (x, y), or 0 in the open field. */
function holdRadius(w: World, x: number, y: number): number {
  for (const n of w.nests) {
    const dx = n.x - x, dy = n.y - y;
    if (dx * dx + dy * dy <= n.r * n.r) return n.r;
  }
  return 0;
}

/** The nearest nest p owns, or null. */
function nearestOwn(w: World, p: number, x: number, y: number): Nest | null {
  let best: Nest | null = null, bestD = Infinity;
  for (const n of w.nests) {
    if (n.owner !== p) continue;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * Skirmish (#60): a badly hurt Raider falls back to its nearest nest, heals
 * in its ring, then returns to its orders. Returns the nest to head for, or
 * null when it isn't retreating.
 */
function skirmish(w: World, i: number): Nest | null {
  const max = maxHp(w, i);
  const S = STRAINS.skirmish;
  if (w.state[i] !== UNIT_RETREAT && w.hp[i] >= max * S.flee) return null;
  const nest = nearestOwn(w, w.owner[i], w.x[i], w.y[i]);
  if (!nest) {
    w.state[i] = 0;
    return null;
  }
  w.state[i] = UNIT_RETREAT;
  const dx = nest.x - w.x[i], dy = nest.y - w.y[i];
  if (dx * dx + dy * dy <= nest.r * nest.r) {
    w.hp[i] = Math.min(max, w.hp[i] + S.heal * DT);
    if (w.hp[i] >= max * S.back) {
      w.state[i] = 0;
      return null;
    }
  }
  return nest;
}

export function updateMovement(w: World): void {
  const g = w.grid;
  const n = w.n;
  const W = w.width, H = w.height;
  const tr = w.terrain;
  for (let i = 0; i < n; i++) {
    // The Bloom's heart is rooted (heart.ts).
    if (!w.alive[i] || w.wild[i] === WILD_HEART) continue;
    const st = UNIT_STATS[w.kind[i]];
    const x = w.x[i], y = w.y[i];
    const fm = w.factions[w.owner[i]].mods;
    const fortified = w.fortify[i] > w.tick;
    const surged = w.surge[i] > w.tick;
    // Mend: a Surge heals instead of speeding them up.
    if (surged && fm.mend) {
      const max = maxHp(w, i);
      w.hp[i] = Math.min(max, w.hp[i] + (max * VARIANTS.mend.heal) / (POWER.surgeTicks * fm.surgeTicks));
    }
    let spd =
      st.speed * fm.kind[w.kind[i]].speed * (surged && !fm.mend ? POWER.surgeSpeed : 1) * (fortified ? (fm.fortifyRoot ? 0 : POWER.fortifySlow) : 1);
    if (w.called[i] > w.tick) spd *= STRAINS.call.speed;
    if (tr.hasFields) {
      const fl = tr.flagsAt(x, y);
      if (fl & T_NEBULA) spd *= TERRAIN.nebulaSlow;
      // Rift damage lands with everything else next tick.
      if (fl & T_RIFT) w.dmg[i] += TERRAIN.riftDps * DT;
    }
    let desX = 0, desY = 0;

    if (w.state[i] === UNIT_FEEDING) {
      const nest = w.nests[w.feedNest[i]];
      if (!nest || nest.owner !== w.owner[i] || (nest.level >= MAX_LEVEL && nest.control >= 1)) {
        // Nest lost or maxed while en route: stand down where we are.
        nest && nest.feedIncoming--;
        w.state[i] = 0;
        w.ox[i] = x;
        w.oy[i] = y;
        w.arrive[i] = 20;
      } else {
        const dx = nest.x - x, dy = nest.y - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < nest.r * 0.35) {
          removeUnit(w, i);
          // Repair first, then grow.
          if (nest.control < 1) {
            nest.control = Math.min(1, nest.control + LEVEL.repair);
            continue;
          }
          nest.feedProgress++;
          if (nest.feedProgress >= UPGRADE_COST[nest.level]) {
            nest.level++;
            nest.feedProgress = 0;
            pushFx(w, 'levelup', nest.x, nest.y, nest.owner, nest.r, nest.id);
          }
          continue;
        }
        if (tr.hasPaths && d > nest.r && tr.steer(x, y, nest.x, nest.y, w.tick)) {
          desX = tr.ox * spd * 1.3;
          desY = tr.oy * spd * 1.3;
        } else {
          const s = (spd * 1.3) / (d || 1);
          desX = dx * s;
          desY = dy * s;
        }
      }
    }

    const refuge = w.state[i] !== UNIT_FEEDING && fm.kind[w.kind[i]].skirmish ? skirmish(w, i) : null;
    if (refuge) {
      // Falling back: straight for the nest, through the fight.
      const dx = refuge.x - x, dy = refuge.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > refuge.r * 0.5) {
        if (tr.hasPaths && tr.steer(x, y, refuge.x, refuge.y, w.tick)) {
          desX = tr.ox * spd;
          desY = tr.oy * spd;
        } else {
          desX = (dx / d) * spd;
          desY = (dy / d) * spd;
        }
      }
    } else if (w.state[i] !== UNIT_FEEDING) {
      const dx = w.ox[i] - x, dy = w.oy[i] - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ar = w.arrive[i];
      if (d > ar) {
        const f = Math.min(1, (d - ar) / 12);
        // Route around walls and bad ground; straight when nothing is in the way.
        if (tr.hasPaths && d > ar + 8 && tr.steer(x, y, w.ox[i], w.oy[i], w.tick)) {
          desX = tr.ox * spd * f;
          desY = tr.oy * spd * f;
        } else {
          desX = (dx / d) * spd * f;
          desY = (dy / d) * spd * f;
        }
      }
      const t = w.tgt[i];
      if (w.engaged[i]) {
        // Units in range mostly stand and fight, with a slight push forward.
        desX *= 0.12;
        desY *= 0.12;
      } else if (t >= 0 && w.alive[t] && w.uid[t] === w.tgtUid[i] && d <= ar * 1.6 + 8) {
        // Idle and an enemy is near: close in, within a leash of the order point.
        // Units holding a nest only chase what steps into the ring.
        const lx = w.x[t] - w.ox[i], ly = w.y[t] - w.oy[i];
        const hold = holdRadius(w, w.ox[i], w.oy[i]);
        const leash = hold > 0 ? Math.max(ar, hold) + HOLD_EXTRA : ar + LEASH;
        if (lx * lx + ly * ly < leash * leash) {
          const tx = w.x[t] - x, ty = w.y[t] - y;
          const td = Math.sqrt(tx * tx + ty * ty) || 1;
          desX = (tx / td) * spd;
          desY = (ty / td) * spd;
        }
      }
    }

    // Separation: push away from close neighbors (any faction) so swarms
    // spread into blobs. Scan is capped so dense crowds stay cheap.
    let sepX = 0, sepY = 0;
    const sep = st.sep;
    const sep2 = sep * sep;
    // Dots also count nearby friendly Dots for the pack bonus (used next tick),
    // and Shields count Shields for Phalanx.
    const kind = w.kind[i];
    const isDot = kind === Kind.Dot;
    const isTank = kind === Kind.Tank;
    const near2 = isDot ? TRAITS.pack.radius * TRAITS.pack.radius : STRAINS.phalanx.radius * STRAINS.phalanx.radius;
    const me = w.owner[i];
    let pack = 0;
    const gcx = g.cx(x), gcy = g.cy(y);
    let scanned = 0;
    outer: for (let oy = 0; oy < 3; oy++) {
      // own row first, then neighbors
      const cy = gcy + (oy === 0 ? 0 : oy === 1 ? -1 : 1);
      if (cy < 0 || cy >= g.rows) continue;
      for (let ox = 0; ox < 3; ox++) {
        const cx = gcx + (ox === 0 ? 0 : ox === 1 ? -1 : 1);
        if (cx < 0 || cx >= g.cols) continue;
        const c = cy * g.cols + cx;
        for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) {
          const j = g.items[k];
          if (j === i || !w.alive[j]) continue;
          const ddx = x - w.x[j], ddy = y - w.y[j];
          const dd = ddx * ddx + ddy * ddy;
          if ((isDot || isTank) && dd < near2 && w.owner[j] === me && w.kind[j] === kind && !w.ghost[j]) pack++;
          if (dd < sep2) {
            if (dd > 1e-6) {
              const d = Math.sqrt(dd);
              const push = ((sep - d) / sep) * spd * 1.6;
              sepX += (ddx / d) * push;
              sepY += (ddy / d) * push;
            } else {
              sepX += i < j ? spd : -spd;
            }
          }
          if (++scanned >= MAX_SEP_SCAN) break outer;
        }
      }
    }

    if (isTank) w.guard[i] = Math.min(255, pack);
    else w.pack[i] = pack;

    let vx = w.vx[i] + (desX + sepX - w.vx[i]) * STEER;
    let vy = w.vy[i] + (desY + sepY - w.vy[i]) * STEER;
    const max = spd * 2.5;
    const v2 = vx * vx + vy * vy;
    if (v2 > max * max) {
      const s = max / Math.sqrt(v2);
      vx *= s;
      vy *= s;
    }
    w.vx[i] = vx;
    w.vy[i] = vy;
    let nx = x + vx * DT, ny = y + vy * DT;
    if (nx < 2) nx = 2;
    else if (nx > W - 2) nx = W - 2;
    if (ny < 2) ny = 2;
    else if (ny > H - 2) ny = H - 2;
    if (tr.hasWalls && tr.collide(nx, ny, st.size * 0.5)) {
      nx = tr.ox;
      ny = tr.oy;
    }
    w.x[i] = nx;
    w.y[i] = ny;
  }
}
