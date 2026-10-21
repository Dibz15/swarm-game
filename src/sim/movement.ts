import { DT, LEASH, MAX_LEVEL, POWER, UNIT_STATS, UPGRADE_COST } from './constants';
import { pushFx, removeUnit, UNIT_FEEDING, type World } from './world';

const MAX_SEP_SCAN = 22;
const STEER = 0.3;

export function updateMovement(w: World): void {
  const g = w.grid;
  const n = w.n;
  const W = w.width, H = w.height;
  for (let i = 0; i < n; i++) {
    if (!w.alive[i]) continue;
    const st = UNIT_STATS[w.kind[i]];
    const spd = st.speed * (w.surge[i] > w.tick ? POWER.surgeSpeed : 1);
    const x = w.x[i], y = w.y[i];
    let desX = 0, desY = 0;

    if (w.state[i] === UNIT_FEEDING) {
      const nest = w.nests[w.feedNest[i]];
      if (!nest || nest.owner !== w.owner[i] || nest.level >= MAX_LEVEL) {
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
          nest.feedProgress++;
          if (nest.feedProgress >= UPGRADE_COST[nest.level]) {
            nest.level++;
            nest.feedProgress = 0;
            pushFx(w, 'levelup', nest.x, nest.y, nest.owner, nest.r, nest.id);
          }
          continue;
        }
        const s = (spd * 1.3) / (d || 1);
        desX = dx * s;
        desY = dy * s;
      }
    }

    if (w.state[i] !== UNIT_FEEDING) {
      const dx = w.ox[i] - x, dy = w.oy[i] - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ar = w.arrive[i];
      if (d > ar) {
        const f = Math.min(1, (d - ar) / 12);
        desX = (dx / d) * spd * f;
        desY = (dy / d) * spd * f;
      }
      const t = w.tgt[i];
      if (w.engaged[i]) {
        // Units in range mostly stand and fight, with a slight push forward.
        desX *= 0.12;
        desY *= 0.12;
      } else if (t >= 0 && w.alive[t] && w.uid[t] === w.tgtUid[i] && d <= ar * 1.6 + 8) {
        // Idle and an enemy is near: close in, within a leash of the order point.
        const lx = w.x[t] - w.ox[i], ly = w.y[t] - w.oy[i];
        if (lx * lx + ly * ly < (ar + LEASH) ** 2) {
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
    w.x[i] = nx;
    w.y[i] = ny;
  }
}
