import { siegeVictory } from './siege';
import { BALANCE, DOMINATION, DT, ENERGY, ESCALATION, POWER, TERRAIN, VARIANTS, escalation, NEUTRAL, NEUTRAL_TEAM, NUM_FACTIONS, TICK_HZ } from './constants';
import { applyCommand, type Command } from './commands';
import { updateCombat, resolveDamage } from './combat';
import { updateMovement } from './movement';
import { updateNests } from './nests';
import { updateEvents } from './events';
import { pushFx, removeUnit, type World } from './world';
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
  updateBurns(w);
  updateCombat(w);
  resolveDamage(w);
  updateMovement(w);
  updateCrystals(w);
  expireGhosts(w);
  siphon(w);

  // Energy: factions behind the biggest army charge faster.
  let leader = 1;
  for (let f = 0; f < NEUTRAL; f++) if (w.factions[f].active) leader = Math.max(leader, w.unitCount[f]);
  for (let f = 0; f < NEUTRAL; f++) {
    const fa = w.factions[f];
    if (!fa.active || fa.eliminated) continue;
    const behind = 1 - w.unitCount[f] / leader;
    const rate = ENERGY.passive * (1 + BALANCE.underdogEnergy * behind * (1 - escalation(w.tick)));
    fa.energy = Math.min(ENERGY.max, fa.energy + rate * fa.mods.energyRate * DT);
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
const hits: { j: number; d: number }[] = [];
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
        if (o === NEUTRAL || w.ghost[s]) continue;
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
    if (!f.eliminated) f.energy = Math.min(ENERGY.max, f.energy + TERRAIN.crystalEnergy * f.mods.crystalRate * DT);
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
    queryRadius(w, b.x, b.y, b.r, blast);
    // Full damage (with falloff) from the center out, until the strike's
    // budget is spent: a small group still dies, a big packed blob loses its core.
    hits.length = 0;
    for (const j of blast) {
      if (!w.hostile(w.owner[j], b.owner)) continue;
      hits.push({ j, d: Math.sqrt((w.x[j] - b.x) ** 2 + (w.y[j] - b.y) ** 2) });
    }
    hits.sort((p, q) => p.d - q.d || p.j - q.j);
    const fm = w.factions[b.owner].mods;
    let budget = POWER.barrageBudget * (b.r / POWER.barrageRadius) * fm.barrageBudget * (b.budget ?? 1) * (fm.scorch ? VARIANTS.scorch.budget : 1);
    for (const { j, d } of hits) {
      if (budget <= 0) break;
      const dmg = Math.min(budget, POWER.barrageDamage * (1 - 0.4 * (d / b.r)));
      w.dmg[j] += dmg;
      w.lastHit[j] = b.owner;
      budget -= dmg;
    }
    pushFx(w, 'barrageHit', b.x, b.y, b.owner, b.r);
    if (fm.scorch) w.burns.push({ x: b.x, y: b.y, r: b.r, owner: b.owner, until: w.tick + VARIANTS.scorch.ticks });
  }
  w.barrages = keep;
}

/** Scorch (#60): burning ground hurts every hostile standing in it. */
function updateBurns(w: World): void {
  if (w.burns.length === 0) return;
  w.burns = w.burns.filter((b) => b.until > w.tick);
  for (const b of w.burns) {
    queryRadius(w, b.x, b.y, b.r, blast);
    for (const j of blast) {
      if (!w.hostile(w.owner[j], b.owner)) continue;
      w.dmg[j] += VARIANTS.scorch.dps * DT;
      w.lastHit[j] = b.owner;
    }
  }
}

/** Echo (#60): ghosts fade when their time is up. */
function expireGhosts(w: World): void {
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.ghost[i] && w.ghost[i] <= w.tick) removeUnit(w, i);
}

/** Lockdown Siphon (#60): a locked nest's owner bleeds energy to whoever locked it. */
function siphon(w: World): void {
  for (const n of w.nests) {
    if (n.lockedUntil <= w.tick || n.lockedBy === undefined || n.lockedBy < 0 || n.owner < 0 || n.owner === NEUTRAL) continue;
    const to = w.factions[n.lockedBy], from = w.factions[n.owner];
    if (!to.mods.siphon) continue;
    const take = Math.min(from.energy, to.mods.siphon * DT);
    from.energy -= take;
    to.energy = Math.min(ENERGY.max, to.energy + take);
  }
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

  if (w.endless) return;
  // Hold the line (#67): only the siege decides it.
  if (w.siege && siegeVictory(w)) return;
  // A stronghold (#100): a human taking the citadel wins, whoever else is left.
  if (w.citadel >= 0) {
    const c = w.nests[w.citadel];
    if (c.owner >= 0 && c.owner !== NEUTRAL && c.control >= 1 && w.factions[c.owner].human) {
      w.over = true;
      w.winnerTeam = w.teamOf[c.owner];
      w.winReason = 'citadel';
      return;
    }
  }
  // While the Bloom's heart lives it is the goal: only losing every human
  // (or, with no human in the match, every player) ends the match.
  if (w.heart && !w.heart.slain) {
    let humans = 0, alive = 0;
    for (let f = 0; f < NEUTRAL; f++) {
      const fa = w.factions[f];
      if (!fa.human || !fa.active) continue;
      humans++;
      if (!fa.eliminated) alive++;
    }
    if (humans > 0 ? alive === 0 : aliveTeams.size === 0) {
      w.over = true;
      w.winnerTeam = -1;
      w.winReason = 'elimination';
    }
    return;
  }
  if (aliveTeams.size <= 1) {
    w.over = true;
    w.winnerTeam = aliveTeams.size === 1 ? [...aliveTeams][0] : -1;
    w.winReason = 'elimination';
    return;
  }

  const need = Math.ceil(w.nests.length * w.domShare);
  for (const t of aliveTeams) {
    if (nestsByTeam[t] >= need) {
      if (w.domTicks[t] === 0) pushFx(w, 'domStart', 0, 0, teamFace(w, t));
      w.domTicks[t] += 15;
      if (w.domTicks[t] >= DOMINATION.ticks) {
        w.over = true;
        w.winnerTeam = t;
        w.winReason = 'domination';
        return;
      }
    } else {
      if (w.domTicks[t] > 0) pushFx(w, 'domBreak', 0, 0, teamFace(w, t));
      w.domTicks[t] = 0;
    }
  }
}

/** The faction that stands for a team: the live member holding the most nests. */
function teamFace(w: World, team: number): number {
  let best = -1, bestN = -1;
  for (let f = 0; f < NEUTRAL; f++) {
    const fa = w.factions[f];
    if (!fa.active || fa.eliminated || fa.team !== team) continue;
    let n = 0;
    for (const nest of w.nests) if (nest.owner === f) n++;
    if (n > bestN) {
      bestN = n;
      best = f;
    }
  }
  return best;
}

export interface DominationStatus {
  team: number;
  /** faction to show for the team */
  face: number;
  /** ticks until the team wins */
  left: number;
  /** nests the team holds, and how many it needs */
  held: number;
  need: number;
  /** nests rivals must take back to break it */
  toBreak: number;
}

/** The team currently dominating, or null. */
export function dominationStatus(w: World): DominationStatus | null {
  for (let t = 0; t < w.domTicks.length; t++) {
    if (w.domTicks[t] <= 0) continue;
    let held = 0;
    for (const n of w.nests) if (n.owner >= 0 && n.owner !== NEUTRAL && w.teamOf[n.owner] === t) held++;
    const need = Math.ceil(w.nests.length * w.domShare);
    return { team: t, face: teamFace(w, t), left: Math.max(0, DOMINATION.ticks - w.domTicks[t]), held, need, toBreak: Math.max(1, held - need + 1) };
  }
  return null;
}
