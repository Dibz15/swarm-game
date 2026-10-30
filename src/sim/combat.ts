import { AGGRO_EXTRA, ALERT_EVERY, ALERT_RADIUS, DAMAGE_VS, RETALIATE_EXTRA, DT, ENERGY, Kind, NEUTRAL, POWER, RETARGET, STRAINS, TRAITS, UNIT_STATS } from './constants';
import { queryRadius } from './spatial';
import { segDist2 } from './terrain';
import { pushFx, removeUnit, UNIT_RETREAT, WILD_HEART, type World } from './world';
import { colossusSlain } from './events';
import { heartSlain, heartWard } from './heart';

const MAX_SCAN = 420;

const TAUNT2 = TRAITS.taunt * TRAITS.taunt;
const pierceScratch: number[] = [];

/**
 * Nearest hostile unit within radius that isn't behind a wall, or -1.
 * Line of sight is only checked on the winner; if a wall blocks it, scan
 * again checking every candidate (rare: only right next to walls).
 */
function findTarget(w: World, i: number, radius: number): number {
  const best = scanTarget(w, i, radius, false);
  if (best < 0 || !w.terrain.hasWalls || w.terrain.los(w.x[i], w.y[i], w.x[best], w.y[best])) return best;
  return scanTarget(w, i, radius, true);
}

/**
 * Nearest hostile unit within radius, or -1. Tanks draw fire: they count as
 * closer than they are. Scan is capped for dense blobs.
 */
function scanTarget(w: World, i: number, radius: number, walls: boolean): number {
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
        const raw = dx * dx + dy * dy;
        if (raw > radius * radius) continue;
        const d = w.kind[j] === Kind.Tank ? raw * TAUNT2 * w.factions[w.owner[j]].mods.kind[Kind.Tank].taunt : raw;
        if (d < bestD && (!walls || w.terrain.los(x, y, w.x[j], w.y[j]))) {
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
    // Retreating Raiders (Skirmish) don't stop to fight.
    if (!w.alive[i] || w.state[i] === UNIT_RETREAT) continue;
    const st = UNIT_STATS[w.kind[i]];
    const km = w.factions[w.owner[i]].mods.kind[w.kind[i]];
    const range = st.range * km.range;
    const aggro = range + AGGRO_EXTRA;

    // Targets stay valid a little past notice range, so a unit can keep
    // answering an attacker that outranges it.
    const reach = aggro + RETALIATE_EXTRA;
    let t = w.tgt[i];
    let valid = t >= 0 && w.alive[t] === 1 && w.uid[t] === w.tgtUid[i];
    let d2 = 0;
    if (valid) {
      const dx = w.x[t] - w.x[i], dy = w.y[t] - w.y[i];
      d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) valid = false;
    }
    if (!valid || i % RETARGET === phase) {
      let nt = findTarget(w, i, aggro);
      if (nt < 0) {
        // Nothing in sight: turn on whoever shot us, if they're close enough.
        const a = w.attacker[i];
        if (a >= 0 && w.alive[a] && w.uid[a] === w.attackerUid[i]) {
          const ax = w.x[a] - w.x[i], ay = w.y[a] - w.y[i];
          if (ax * ax + ay * ay <= reach * reach && (!w.terrain.hasWalls || w.terrain.los(w.x[i], w.y[i], w.x[a], w.y[a]))) nt = a;
        }
      }
      if (nt !== t) {
        t = nt;
        w.tgt[i] = t;
        w.tgtUid[i] = t >= 0 ? w.uid[t] : 0;
      }
      if (t < 0) continue;
      const dx = w.x[t] - w.x[i], dy = w.y[t] - w.y[i];
      d2 = dx * dx + dy * dy;
    }

    if (d2 <= range * range) {
      const k = w.kind[i];
      let mult = (w.surge[i] > w.tick ? POWER.surgeDmg : 1) * DAMAGE_VS[k][w.kind[t]];
      if (k === Kind.Dot) mult *= 1 + Math.min(TRAITS.pack.max * km.pack, w.pack[i] * TRAITS.pack.perAlly * km.pack);
      if (w.called[i] > w.tick) mult *= 1 + km.call;
      const dmg = st.dps * km.dps * mult * DT;
      w.dmg[t] += dmg;
      // Spikes: some of the damage it takes comes back at whoever struck it.
      const spikes = w.factions[w.owner[t]].mods.kind[w.kind[t]].spikes;
      if (spikes > 0) {
        w.dmg[i] += dmg * taken(w, t) * spikes;
        w.lastHit[i] = w.owner[t];
      }
      w.lastHit[t] = w.owner[i];
      w.attacker[t] = i;
      w.attackerUid[t] = w.uid[i];
      if (w.tick - w.alertTick[t] >= ALERT_EVERY) alert(w, t, i);
      if (k === Kind.Lancer) {
        if (km.pierceLine) pierceLine(w, i, t, st.dps * km.dps * DT);
        else pierce(w, i, t, st.dps * km.dps * DT, km.splash);
      }
      w.engaged[i] = 1;
      const b = w.beamCount++ * 2;
      w.beams[b] = i;
      w.beams[b + 1] = t;
    }
  }
}

const alertScratch: number[] = [];

/** Victim t calls for help: idle allies nearby turn on attacker a. */
function alert(w: World, t: number, a: number): void {
  w.alertTick[t] = w.tick;
  queryRadius(w, w.x[t], w.y[t], ALERT_RADIUS, alertScratch);
  const team = w.teamOf[w.owner[t]];
  for (const j of alertScratch) {
    if (w.teamOf[w.owner[j]] !== team || w.engaged[j]) continue;
    w.attacker[j] = a;
    w.attackerUid[j] = w.uid[a];
  }
}

/** Lancer shots splash onto a few enemies packed around the target. */
function pierce(w: World, i: number, t: number, base: number, splash: number): void {
  queryRadius(w, w.x[t], w.y[t], TRAITS.pierce.radius * splash, pierceScratch);
  let hit = 0;
  const owner = w.owner[i];
  for (const j of pierceScratch) {
    if (j === t || !w.hostile(w.owner[j], owner)) continue;
    w.dmg[j] += base * TRAITS.pierce.damage * DAMAGE_VS[Kind.Lancer][w.kind[j]];
    w.lastHit[j] = owner;
    if (++hit >= TRAITS.pierce.extra) break;
  }
}

/** Piercing (#60): the shot carries on past the target and hits a few more along its line. */
function pierceLine(w: World, i: number, t: number, base: number): void {
  const L = STRAINS.line;
  const dx = w.x[t] - w.x[i], dy = w.y[t] - w.y[i];
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const ex = w.x[t] + (dx / d) * L.reach, ey = w.y[t] + (dy / d) * L.reach;
  queryRadius(w, (w.x[t] + ex) / 2, (w.y[t] + ey) / 2, L.reach / 2 + L.width, pierceScratch);
  let hit = 0;
  const owner = w.owner[i];
  for (const j of pierceScratch) {
    if (j === t || !w.hostile(w.owner[j], owner)) continue;
    if (segDist2(w.x[j], w.y[j], w.x[t], w.y[t], ex, ey) > L.width * L.width) continue;
    w.dmg[j] += base * L.damage * DAMAGE_VS[Kind.Lancer][w.kind[j]];
    w.lastHit[j] = owner;
    if (++hit >= L.extra) break;
  }
}

const callScratch: number[] = [];
/** Swarm-call rings drawn this tick: a big clash shows a few, not one per death. */
let callFxTick = -1, callFx = 0;
const CALL_FX_PER_TICK = 3;

/** Swarm-call (#60): a dying Swarmer rouses the Swarmers around it. */
function swarmCall(w: World, i: number): void {
  const owner = w.owner[i];
  queryRadius(w, w.x[i], w.y[i], STRAINS.call.radius, callScratch);
  for (const j of callScratch) if (j !== i && w.owner[j] === owner && w.kind[j] === Kind.Dot) w.called[j] = w.tick + STRAINS.call.ticks;
  if (callFxTick !== w.tick) (callFxTick = w.tick), (callFx = 0);
  if (callFx++ < CALL_FX_PER_TICK) pushFx(w, 'swarmCall', w.x[i], w.y[i], owner, STRAINS.call.radius);
}

/** Share of a hit unit i actually takes: home armour, Surge, Fortify and Phalanx (not the heart's ward). */
function taken(w: World, i: number): number {
  const fm = w.factions[w.owner[i]].mods;
  const surged = w.surge[i] > w.tick ? POWER.surgeArmor : 1;
  const fortified = w.fortify[i] > w.tick ? POWER.fortifyArmor * fm.fortifyArmor : 1;
  // Phalanx: Shields shoulder to shoulder take less.
  const ph = fm.kind[w.kind[i]].phalanx;
  const phalanx = ph > 0 ? 1 - ph * Math.min(w.guard[i], STRAINS.phalanx.max) : 1;
  return w.armor[i] * surged * fortified * phalanx;
}

/** Apply accumulated damage; remove the dead and credit kills. */
export function resolveDamage(w: World): void {
  const n = w.n;
  for (let i = 0; i < n; i++) {
    if (!w.alive[i] || w.dmg[i] === 0) continue;
    let ward = 1;
    if (w.wild[i] === WILD_HEART) {
      ward = heartWard(w);
      // Any hit, from any range, keeps it from regrowing.
      w.heart!.threat = w.tick;
    }
    w.hp[i] -= w.dmg[i] * taken(w, i) * ward;
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
    if (w.wild[i] === WILD_HEART) heartSlain(w, killer);
    else if (w.kind[i] === Kind.Colossus) colossusSlain(w, w.x[i], w.y[i], killer);
    if (w.factions[w.owner[i]].mods.kind[w.kind[i]].call > 0) swarmCall(w, i);
    removeUnit(w, i);
  }
}
