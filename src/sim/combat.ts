import { AGGRO_EXTRA, DT, ENERGY, NEUTRAL, POWER, RETARGET, UNIT_STATS } from './constants';
import { removeUnit, type World } from './world';

const MAX_SCAN = 420;

/** Nearest hostile unit within radius, or -1. Scan is capped for dense blobs. */
function findTarget(w: World, i: number, radius: number): number {
  const g = w.grid;
  const x = w.x[i], y = w.y[i];
  const myTeam = w.teamOf[w.owner[i]];
  const x0 = g.cx(x - radius), x1 = g.cx(x + radius);
  const y0 = g.cy(y - radius), y1 = g.cy(y + radius);
  let best = -1;
  let bestD = radius * radius;
  let scanned = 0;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const c = cy * g.cols + cx;
      for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) {
        const j = g.items[k];
        if (w.teamOf[w.owner[j]] === myTeam || !w.alive[j]) continue;
        const dx = w.x[j] - x, dy = w.y[j] - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
        if (++scanned > MAX_SCAN) return best;
      }
    }
  }
  return best;
}

export function updateCombat(w: World): void {
  const n = w.n;
  const phase = w.tick % RETARGET;
  for (let i = 0; i < n; i++) {
    w.engaged[i] = 0;
    if (!w.alive[i]) continue;
    const st = UNIT_STATS[w.kind[i]];
    const aggro = st.range + AGGRO_EXTRA;

    let t = w.tgt[i];
    let valid = t >= 0 && w.alive[t] === 1 && w.uid[t] === w.tgtUid[i];
    let d2 = 0;
    if (valid) {
      const dx = w.x[t] - w.x[i], dy = w.y[t] - w.y[i];
      d2 = dx * dx + dy * dy;
      if (d2 > aggro * aggro) valid = false;
    }
    if (!valid || i % RETARGET === phase) {
      const nt = findTarget(w, i, aggro);
      if (nt !== t) {
        t = nt;
        w.tgt[i] = t;
        w.tgtUid[i] = t >= 0 ? w.uid[t] : 0;
      }
      if (t < 0) continue;
      const dx = w.x[t] - w.x[i], dy = w.y[t] - w.y[i];
      d2 = dx * dx + dy * dy;
    }

    if (d2 <= st.range * st.range) {
      const mult = w.surge[i] > w.tick ? POWER.surgeDmg : 1;
      w.dmg[t] += st.dps * mult * DT;
      w.lastHit[t] = w.owner[i];
      w.engaged[i] = 1;
      const b = w.beamCount++ * 2;
      w.beams[b] = i;
      w.beams[b + 1] = t;
    }
  }
}

/** Apply accumulated damage; remove the dead and credit kills. */
export function resolveDamage(w: World): void {
  const n = w.n;
  for (let i = 0; i < n; i++) {
    if (!w.alive[i] || w.dmg[i] === 0) continue;
    w.hp[i] -= w.dmg[i];
    w.dmg[i] = 0;
    if (w.hp[i] > 0) continue;
    const killer = w.lastHit[i];
    if (killer >= 0 && killer !== NEUTRAL) {
      const kf = w.factions[killer];
      kf.stats.kills++;
      kf.energy = Math.min(ENERGY.max, kf.energy + ENERGY.kill);
    }
    w.factions[w.owner[i]].stats.lost++;
    w.deaths.push(w.x[i], w.y[i], w.owner[i]);
    removeUnit(w, i);
  }
}
