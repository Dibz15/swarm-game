import { EVENTS, Kind, NEUTRAL, TICK_HZ, UNIT_STATS } from './constants';
import { giantReward, releaseSwarm } from './events';
import { TAU, dcos, dsin } from './mathx';
import { queryRadius } from './spatial';
import { pushFx, spawnUnit, WILD_HEART, WILD_SWARM, type HeartRule, type World } from './world';

/**
 * The Bloom's heart: the campaign finale's boss. A rooted giant near the map
 * centre, warded by the Bloom nests around it, that fights back in phases:
 * a telegraphed pulse, spore lobs at the thickest crowd, defenders called up
 * when it's pressed, and a burst and a recall at 66% and 33% health. Left
 * alone, it regrows (but never past a phase it lost). Everything random comes from the events' seeded stream.
 */
export const HEART = {
  hp: 2000,
  /** extra hp per node the Bloom swallowed */
  hpPerStrength: 0.06,
  /** drawn size (the sim uses the Colossus's reach) */
  size: 30,
  /** damage taken drops by this much per standing Bloom nest */
  ward: 0.15,
  /** Bloom nests: 2, plus one per this many swallowed nodes, at most 4 */
  nestsPer: 4,
  nestsMax: 4,
  /** seconds between a Bloom nest's swarms, and their size (+ strength / 2) */
  nestEvery: 45,
  nestSwarm: 6,
  /** the pulse: seconds between, by phase; its wind-up; reach and damage grow per phase */
  pulseEvery: [9, 7.5, 6],
  pulseWindup: 1.5 * TICK_HZ,
  pulseR: 120,
  pulseRPerPhase: 30,
  pulseDamage: 4,
  pulseDamagePerPhase: 2,
  /** spore lobs: seconds between volleys, reach, blast radius, flight time */
  lobEvery: 7,
  lobRange: 500,
  lobR: 44,
  lobFlight: 1.6 * TICK_HZ,
  /** a spore lob spreads this share of a Barrage's damage budget */
  lobBudget: 0.5,
  /** defenders: called when this much enemy weight is within callR; cooldown by phase */
  callR: 260,
  callWeight: 12,
  callEvery: [25, 18, 12],
  callSize: 10,
  /** phase shift: a burst of this size (+ strength), and swarms rally home this long */
  burstSize: 16,
  recall: 20 * TICK_HZ,
  /** regrowth: after this long with no enemy within threatR, this share of hp a second, never past its phase */
  regrowAfter: 10 * TICK_HZ,
  threatR: 200,
  regrow: 0.004,
};

const scratch: number[] = [];
/** Spore-lob targeting: hostile count per grid cell in reach, and one hostile unit in each. */
const crowd = new Map<number, number>();
const pick = new Map<number, number>();

/** Root the heart near the centre, away from the nests, and wake the Bloom nests around it. */
export function initHeart(w: World, strength: number, rule: HeartRule): void {
  if (!w.events) return;
  const [x, y] = heartSpot(w);
  const s = spawnUnit(w, NEUTRAL, Kind.Colossus, x, y, x, y, 4);
  if (s < 0) return;
  const maxHp = HEART.hp * (1 + HEART.hpPerStrength * strength);
  w.hp[s] = maxHp;
  w.wild[s] = WILD_HEART;
  // Only the heart launches Bloom-owned strikes.
  w.factions[NEUTRAL].mods = { ...w.factions[NEUTRAL].mods, barrageBudget: HEART.lobBudget };
  const count = Math.min(HEART.nestsMax, 2 + Math.floor(strength / HEART.nestsPer));
  const nests = w.nests
    .filter((n) => n.owner === NEUTRAL)
    .map((n) => ({ id: n.id, d: (n.x - x) ** 2 + (n.y - y) ** 2 }))
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .slice(0, count)
    .map((n) => n.id);
  const t = w.tick;
  w.heart = {
    uid: w.uid[s],
    x,
    y,
    maxHp,
    strength,
    rule,
    phase: 0,
    nests,
    // Staggered, so the nests don't all release together.
    nestNext: nests.map((_, k) => t + Math.round((HEART.nestEvery * (0.5 + k / Math.max(1, nests.length))) * TICK_HZ)),
    nextPulse: t + Math.round(HEART.pulseEvery[0] * TICK_HZ),
    pulseAt: -1,
    nextLob: t + Math.round(HEART.lobEvery * TICK_HZ),
    nextCall: 0,
    threat: t,
    recall: 0,
    slain: false,
  };
}

/** Open ground near the centre, as far from every nest as it can get. */
function heartSpot(w: World): [number, number] {
  const cx = w.width / 2, cy = w.height / 2;
  let best: [number, number] = w.terrain.freePoint(cx, cy, 30);
  let bestD = -1;
  for (let ring = 0; ring <= 3; ring++) {
    const n = ring === 0 ? 1 : 10;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + ring;
      const p = w.terrain.freePoint(cx + dcos(a) * ring * 45, cy + dsin(a) * ring * 45, 30);
      let d = Infinity;
      for (const nest of w.nests) d = Math.min(d, Math.sqrt((nest.x - p[0]) ** 2 + (nest.y - p[1]) ** 2) - nest.r);
      // Prefer the middle: distance from the centre costs a little.
      const score = Math.min(d, 140) - ring * 12;
      if (score > bestD) {
        bestD = score;
        best = p;
      }
    }
  }
  return best;
}

/** Bloom nests the Bloom still holds. */
export function standingNests(w: World): number {
  const h = w.heart;
  if (!h) return 0;
  let n = 0;
  for (const id of h.nests) if (w.nests[id].owner === NEUTRAL) n++;
  return n;
}

/** The heart's damage multiplier: each standing Bloom nest wards it. */
export function heartWard(w: World): number {
  return Math.max(0.2, 1 - HEART.ward * standingNests(w));
}

/** Slot of the living heart, or -1. */
export function heartSlot(w: World): number {
  const h = w.heart;
  if (!h || h.slain) return -1;
  return w.uidToSlot.get(h.uid) ?? -1;
}

export function updateHeart(w: World): void {
  const h = w.heart!;
  const s = heartSlot(w);
  if (s < 0) return;
  const t = w.tick;
  // (Rooted: updateMovement skips it.)

  // Bloom nests release swarms while the Bloom holds them. One the players
  // take is lost to the Bloom for good, even if it later goes wild again.
  for (let k = h.nests.length - 1; k >= 0; k--) {
    if (w.nests[h.nests[k]].owner !== NEUTRAL) {
      h.nests.splice(k, 1);
      h.nestNext.splice(k, 1);
      continue;
    }
    if (t < h.nestNext[k]) continue;
    h.nestNext[k] = t + Math.round(HEART.nestEvery * TICK_HZ);
    nestSwarm(w, h.nests[k]);
  }

  const frac = w.hp[s] / h.maxHp;
  const phase = frac < 1 / 3 ? 2 : frac < 2 / 3 ? 1 : 0;
  if (phase > h.phase) {
    h.phase = phase;
    shift(w, s);
  }

  if (h.pulseAt >= 0 && t >= h.pulseAt) {
    h.pulseAt = -1;
    pulse(w);
  } else if (h.pulseAt < 0 && t >= h.nextPulse) {
    h.pulseAt = t + HEART.pulseWindup;
    h.nextPulse = t + Math.round(HEART.pulseEvery[h.phase] * TICK_HZ);
    pushFx(w, 'heartWindup', h.x, h.y, NEUTRAL, pulseR(h.phase));
  }

  if (t >= h.nextLob) {
    h.nextLob = t + Math.round(HEART.lobEvery * TICK_HZ);
    lob(w, h.phase + 1);
  }

  if (t % TICK_HZ === 0) {
    queryRadius(w, h.x, h.y, HEART.callR, scratch);
    let weight = 0, close = false;
    for (const j of scratch) {
      if (!w.hostile(w.owner[j], NEUTRAL)) continue;
      weight += UNIT_STATS[w.kind[j]].weight;
      if (!close && (w.x[j] - h.x) ** 2 + (w.y[j] - h.y) ** 2 < HEART.threatR * HEART.threatR) close = true;
    }
    // (Hits from any range also set threat, in resolveDamage.)
    if (close) h.threat = t;
    if (weight >= HEART.callWeight && t >= h.nextCall) {
      h.nextCall = t + HEART.callEvery[h.phase] * TICK_HZ;
      releaseSwarm(w, h.x, h.y, HEART.callSize + h.strength, null);
    }
    // A fallen phase stays fallen: regrowth stops at its line.
    if (t - h.threat > HEART.regrowAfter) w.hp[s] = Math.min(h.maxHp * (1 - h.phase / 3), w.hp[s] + h.maxHp * HEART.regrow);
  }

  if (t < h.recall && t % EVENTS.swarmRethink === 0) rally(w);
}

function pulseR(phase: number): number {
  return HEART.pulseR + HEART.pulseRPerPhase * phase;
}

/** The telegraphed shockwave lands: everything hostile inside the ring is hit. */
function pulse(w: World): void {
  const h = w.heart!;
  const R = pulseR(h.phase);
  const dmg = HEART.pulseDamage + HEART.pulseDamagePerPhase * h.phase;
  queryRadius(w, h.x, h.y, R, scratch);
  for (const j of scratch) {
    if (!w.hostile(w.owner[j], NEUTRAL)) continue;
    w.dmg[j] += dmg;
    w.lastHit[j] = NEUTRAL;
  }
  pushFx(w, 'heartPulse', h.x, h.y, NEUTRAL, R);
}

/** Spore lobs at the thickest crowd of enemies in reach (Barrage strikes owned by the Bloom). */
function lob(w: World, volley: number): void {
  const h = w.heart!;
  const ev = w.events!;
  queryRadius(w, h.x, h.y, HEART.lobRange, scratch);
  const g = w.grid;
  crowd.clear();
  pick.clear();
  for (const j of scratch) {
    if (!w.hostile(w.owner[j], NEUTRAL) || w.kind[j] === Kind.Colossus) continue;
    const c = g.cy(w.y[j]) * g.cols + g.cx(w.x[j]);
    crowd.set(c, (crowd.get(c) ?? 0) + 1);
    if (!pick.has(c)) pick.set(c, j);
  }
  for (let v = 0; v < volley; v++) {
    let best = -1, most = 0;
    for (const [c, n] of crowd) if (n > most || (n === most && c < best)) [best, most] = [c, n];
    if (best < 0) break;
    crowd.delete(best);
    const j = pick.get(best)!;
    const a = ev.rng.next() * TAU, r = ev.rng.next() * 20;
    const x = w.x[j] + dcos(a) * r, y = w.y[j] + dsin(a) * r;
    w.barrages.push({ x, y, owner: NEUTRAL, impact: w.tick + HEART.lobFlight + v * 4, r: HEART.lobR, x0: h.x, y0: h.y, t0: w.tick });
  }
}

/** A Bloom nest releases its swarm. */
function nestSwarm(w: World, id: number): void {
  const h = w.heart!;
  const n = w.nests[id];
  releaseSwarm(w, n.x, n.y, HEART.nestSwarm + Math.round(h.strength / 2), 'bloomSwarm');
}

/** A phase falls: a roar, a burst of defenders, every Bloom nest releases, and the swarms rally home. */
function shift(w: World, s: number): void {
  const h = w.heart!;
  pushFx(w, 'heartPhase', h.x, h.y, NEUTRAL, pulseR(h.phase));
  releaseSwarm(w, w.x[s], w.y[s], HEART.burstSize + h.strength, null);
  for (const id of h.nests) if (w.nests[id].owner === NEUTRAL) nestSwarm(w, id);
  h.recall = w.tick + HEART.recall;
  h.nextPulse = Math.min(h.nextPulse, w.tick + TICK_HZ);
  rally(w);
}

/** Every wild swarm heads for the heart. */
function rally(w: World): void {
  const h = w.heart!;
  for (const sw of w.events!.swarms) {
    sw.tx = h.x;
    sw.ty = h.y;
    for (const u of sw.uids) {
      const j = w.uidToSlot.get(u);
      if (j === undefined || w.wild[j] !== WILD_SWARM) continue;
      w.ox[j] = h.x;
      w.oy[j] = h.y;
    }
  }
}

/**
 * The heart dies. Its killer gets full energy and an upgrade. Under the
 * 'heart' rule, a human team's kill wins the match; if a rival lands the
 * blow, or under 'heart+rivals' (Brutal), the players fight it out as usual.
 */
export function heartSlain(w: World, killer: number): void {
  const h = w.heart!;
  h.slain = true;
  const player = giantReward(w, killer);
  pushFx(w, 'heartDown', h.x, h.y, player ? killer : -1, 120);
  if (h.rule !== 'heart' || !player || !w.factions.some((f) => f.active && f.human && w.teamOf[f.id] === w.teamOf[killer])) return;
  w.over = true;
  w.winnerTeam = w.teamOf[killer];
  w.winReason = 'heart';
}
