import { BALANCE, DOMINATION, DT, ENERGY, ESCALATION, POWER, TERRAIN, escalation, NEUTRAL, NEUTRAL_TEAM, NUM_FACTIONS, TICK_HZ } from './constants';
import { applyCommand, type Command } from './commands';
import { updateCombat, resolveDamage } from './combat';
import { updateMovement } from './movement';
import { updateNests } from './nests';
import { updateEvents } from './events';
import { pushFx, type World } from './world';
import { queryRadius } from './spatial';

/**
 * Advance the world one fixed tick. Pure function of (world, commands):
 * the same inputs always produce the same state, which is what lockstep
 * multiplayer and replays rely on.
 */
export function step(w: World, commands: readonly Command[]): void {
  if (w.over) return;
  w.tick++;
  w.beamCount = 0;
  w.px.set(w.x.subarray(0, w.n));
  w.py.set(w.y.subarray(0, w.n));

  w.grid.build(w);
  for (const c of commands) applyCommand(w, c);
  for (const b of w.bots) b.update(w);
  updateEvents(w);

  updateNests(w);
  resolveBarrages(w);
  updateCombat(w);
  resolveDamage(w);
  updateMovement(w);
  updateCrystals(w);

  // Energy: factions behind the biggest army charge faster.
  let leader = 1;
  for (let f = 0; f < NEUTRAL; f++) if (w.factions[f].active) leader = Math.max(leader, w.unitCount[f]);
  for (let f = 0; f < NEUTRAL; f++) {
    const fa = w.factions[f];
    if (!fa.active || fa.eliminated) continue;
    const behind = 1 - w.unitCount[f] / leader;
    const rate = ENERGY.passive * (1 + BALANCE.underdogEnergy * behind * (1 - escalation(w.tick)));
    fa.energy = Math.min(ENERGY.max, fa.energy + rate * DT);
  }

  if (w.tick % TICK_HZ === 0) {
    for (let f = 0; f < NEUTRAL; f++) {
      if (w.factions[f].active) w.history[f].push(w.unitCount[f]);
    }
  }
  if (w.tick === ESCALATION.start) pushFx(w, 'escalation', 0, 0, -1);
  if (w.tick % 15 === 0) checkVictory(w);
}

const blast: number[] = [];
const CRYSTAL_EVERY = 6;

/** Crystals charge energy for the only team standing on them. */
function updateCrystals(w: World): void {
  if (w.crystals.length === 0) return;
  if (w.tick % CRYSTAL_EVERY === 0) {
    for (const c of w.crystals) {
      queryRadius(w, c.x, c.y, c.r, blast);
      let lead = -1, team = -1, mixed = false;
      for (const s of blast) {
        const o = w.owner[s];
        if (o === NEUTRAL) continue;
        if (team < 0) {
          team = w.teamOf[o];
          lead = o;
        } else if (w.teamOf[o] !== team) {
          mixed = true;
          break;
        }
      }
      const holder = mixed ? -1 : lead;
      if (holder >= 0 && holder !== c.last) {
        pushFx(w, 'crystal', c.x, c.y, holder, c.r);
        c.last = holder;
      }
      c.holder = holder;
    }
  }
  for (const c of w.crystals) {
    if (c.holder < 0) continue;
    const f = w.factions[c.holder];
    if (!f.eliminated) f.energy = Math.min(ENERGY.max, f.energy + TERRAIN.crystalEnergy * DT);
  }
}

/** Barrage strikes that land this tick. */
function resolveBarrages(w: World): void {
  if (w.barrages.length === 0) return;
  const keep = [];
  for (const b of w.barrages) {
    if (b.impact > w.tick) {
      keep.push(b);
      continue;
    }
    queryRadius(w, b.x, b.y, POWER.barrageRadius, blast);
    for (const j of blast) {
      if (!w.hostile(w.owner[j], b.owner)) continue;
      const d = Math.sqrt((w.x[j] - b.x) ** 2 + (w.y[j] - b.y) ** 2);
      w.dmg[j] += POWER.barrageDamage * (1 - 0.4 * (d / POWER.barrageRadius));
      w.lastHit[j] = b.owner;
    }
    pushFx(w, 'barrageHit', b.x, b.y, b.owner, POWER.barrageRadius);
  }
  w.barrages = keep;
}

const nestsByTeam = new Int32Array(NEUTRAL_TEAM + 1);

function checkVictory(w: World): void {
  const ownsNest = new Uint8Array(NUM_FACTIONS);
  nestsByTeam.fill(0);
  for (const n of w.nests) {
    if (n.owner < 0) continue;
    ownsNest[n.owner] = 1;
    nestsByTeam[w.teamOf[n.owner]]++;
  }

  const aliveTeams = new Set<number>();
  for (let f = 0; f < NEUTRAL; f++) {
    const fa = w.factions[f];
    if (!fa.active || fa.eliminated) continue;
    if (w.unitCount[f] === 0 && !ownsNest[f]) {
      fa.eliminated = true;
      fa.eliminatedTick = w.tick;
      fa.energy = 0;
      pushFx(w, 'eliminated', 0, 0, f);
      continue;
    }
    aliveTeams.add(fa.team);
  }

  if (aliveTeams.size <= 1) {
    w.over = true;
    w.winnerTeam = aliveTeams.size === 1 ? [...aliveTeams][0] : -1;
    return;
  }

  const need = Math.ceil(w.nests.length * w.domShare);
  for (const t of aliveTeams) {
    if (nestsByTeam[t] >= need) {
      w.domTicks[t] += 15;
      if (w.domTicks[t] >= DOMINATION.ticks) {
        w.over = true;
        w.winnerTeam = t;
        return;
      }
    } else {
      w.domTicks[t] = 0;
    }
  }
}
