import {
  BALANCE,
  BASTION,
  CAPITAL,
  bastionTurret,
  escalation,
  DT,
  ENERGY,
  FACTION_UNIT_CAP,
  LEVEL_SPAWN_MULT,
  NEST_KIND,
  NEST_SPAWN_MULT,
  Kind,
  TRAITS,
  NEUTRAL,
  NUM_FACTIONS,
  NestType,
  UNIT_STATS,
} from './constants';
import { TAU, dcos, dsin } from './mathx';
import { queryRadius } from './spatial';
import { pushFx, spawnUnit, UNIT_FEEDING, type Nest, type World } from './world';

const scratch: number[] = [];
const counts = new Int32Array(NUM_FACTIONS);

function captureRate(count: number, level: number): number {
  return (DT * (0.12 + 0.025 * Math.min(count, 24))) / (0.8 + 0.2 * level);
}

const nestCount = new Int32Array(NUM_FACTIONS);

export function updateNests(w: World): void {
  w.armor.fill(1, 0, w.n);
  nestCount.fill(0);
  for (const n of w.nests) if (n.owner >= 0) nestCount[n.owner]++;
  for (const n of w.nests) {
    updateControl(w, n);
    applyArmor(w, n);
    if (n.owner >= 0) {
      if (n.type === NestType.Bastion && n.control >= BASTION.minControl) {
        const t = bastionTurret(n.owner, n.level);
        turretFire(w, n, BASTION.range + BASTION.rangePerLevel * (n.level - 1), t.targets, t.dps);
      }
      if (n.capital && n.owner !== NEUTRAL && n.control >= 1) turretFire(w, n, CAPITAL.range, CAPITAL.targets, CAPITAL.dps);
    }
    spawn(w, n);
  }
}

/** Defender's advantage: own units near a held nest take less damage. */
function applyArmor(w: World, n: Nest): void {
  // Neutral garrisons don't get it, so the early expansion pace stays the same.
  if (n.owner < 0 || n.owner === NEUTRAL || n.control < 1) return;
  const bastion = n.type === NestType.Bastion;
  const r = bastion ? BASTION.range + BASTION.rangePerLevel * (n.level - 1) : n.r + BALANCE.homeRadius;
  // Home turf fades fully during escalation; capitals keep half their armor.
  const L = escalation(w.tick);
  const home = 1 - (1 - BALANCE.homeArmor) * (1 - L);
  const cap = 1 - (1 - CAPITAL.armor) * (1 - 0.5 * L);
  const k = Math.min(bastion ? BASTION.aura : home, n.capital ? cap : 1);
  const team = w.teamOf[n.owner];
  queryRadius(w, n.x, n.y, r, scratch);
  for (const s of scratch) {
    if (w.teamOf[w.owner[s]] === team && w.armor[s] > k) w.armor[s] = k;
  }
}

function updateControl(w: World, n: Nest): void {
  counts.fill(0);
  queryRadius(w, n.x, n.y, n.r, scratch);
  for (const s of scratch) {
    if (w.state[s] === UNIT_FEEDING) continue;
    // Swifts are raiders: they capture and drain nests several times faster.
    counts[w.owner[s]] += w.kind[s] === Kind.Swift ? TRAITS.raidCapture : 1;
  }

  // Which teams are standing on the nest, and which faction leads each?
  let teamA = -1, leadA = -1, totalA = 0;
  let multiTeam = false;
  for (let f = 0; f < NUM_FACTIONS; f++) {
    if (counts[f] === 0) continue;
    const t = w.teamOf[f];
    if (teamA === -1) {
      teamA = t;
      leadA = f;
      totalA = counts[f];
    } else if (t === teamA) {
      totalA += counts[f];
      if (counts[f] > counts[leadA]) leadA = f;
    } else {
      multiTeam = true;
    }
  }

  const ownerTeam = n.owner >= 0 ? w.teamOf[n.owner] : -1;
  n.contested = multiTeam || (teamA !== -1 && teamA !== ownerTeam);

  if (multiTeam) return; // fighting on the nest freezes control

  if (teamA === -1) {
    // Nobody here: owned nests recover, unowned ones decay.
    if (n.owner < 0) n.control = Math.max(0, n.control - DT * 0.08);
    else if (n.lockedUntil <= w.tick) n.control = Math.min(1, n.control + DT * 0.08);
    return;
  }

  // Neutral garrison units only defend; they never capture.
  if (leadA === NEUTRAL && n.owner !== NEUTRAL) return;

  const rate = captureRate(totalA, n.level);
  if (n.owner >= 0 && teamA === ownerTeam) {
    if (n.lockedUntil <= w.tick) n.control = Math.min(1, n.control + rate);
    return;
  }

  if (n.owner >= 0) {
    // Enemy-held: drain control until it flips to unowned.
    n.control -= rate;
    if (n.control <= 0) {
      const prev = n.owner;
      if (prev !== NEUTRAL) n.level = Math.max(1, n.level - 1);
      n.owner = -1;
      n.control = 0;
      n.controller = leadA;
      n.feedProgress = 0;
      pushFx(w, 'neutralize', n.x, n.y, leadA, n.r, n.id, prev);
    }
    return;
  }

  // Unowned: someone else's partial control must drain first.
  if (n.controller >= 0 && w.teamOf[n.controller] !== teamA && n.control > 0) {
    n.control -= rate;
    if (n.control <= 0) {
      n.control = 0;
      n.controller = leadA;
    }
    return;
  }
  n.controller = leadA;
  n.control += rate;
  if (n.control >= 1) {
    n.control = 1;
    n.owner = leadA;
    n.spawnAcc = 0;
    n.rallyX = n.x;
    n.rallyY = n.y;
    const f = w.factions[leadA];
    f.stats.captured++;
    f.energy = Math.min(ENERGY.max, f.energy + ENERGY.capture);
    pushFx(w, 'capture', n.x, n.y, leadA, n.r, n.id);
  }
}

function spawn(w: World, n: Nest): void {
  if (n.owner < 0 || n.owner === NEUTRAL || n.control < 1 || n.contested || n.lockedUntil > w.tick) return;
  const kind = NEST_KIND[n.type];
  if (kind < 0) return;
  if (w.unitCount[n.owner] >= FACTION_UNIT_CAP) return;
  const f = w.factions[n.owner];
  // Soft cap: big armies produce slower, which keeps comebacks possible.
  // Both comeback rules relax as the match escalates.
  const L = escalation(w.tick);
  const k = nestCount[n.owner];
  const softCap = (BALANCE.softCap + BALANCE.capPerNest * k) * (1 + 2 * L);
  const soft = 1 / (1 + Math.max(0, w.unitCount[n.owner] - softCap) / BALANCE.softScale);
  // Diminishing returns on width: k nests produce like k^exp nests.
  const exp = BALANCE.nestExponent + (1 - BALANCE.nestExponent) * L;
  const wide = k > 1 ? Math.pow(k, exp - 1) : 1;
  n.spawnAcc += DT * LEVEL_SPAWN_MULT[n.level] * NEST_SPAWN_MULT[n.type] * f.prodMult * soft * wide;
  const interval = UNIT_STATS[kind].interval;
  if (n.spawnAcc < interval) return;
  n.spawnAcc -= interval;

  const a = w.rng.next() * TAU;
  const sx = n.x + dcos(a) * n.r * 0.7;
  const sy = n.y + dsin(a) * n.r * 0.7;
  const atHome = n.rallyX === n.x && n.rallyY === n.y;
  const s = spawnUnit(w, n.owner, kind, sx, sy, n.rallyX, n.rallyY, atHome ? n.r + 14 : 28);
  if (s < 0) return;
  // Give it an outward nudge so it visibly pops out of the nest.
  w.vx[s] = dcos(a) * 30;
  w.vy[s] = dsin(a) * 30;
  n.lastSpawn = w.tick;
  f.stats.spawned++;
  if (w.unitCount[n.owner] > f.stats.peak) f.stats.peak = w.unitCount[n.owner];
}

const bestSlot = new Int32Array(4);
const bestD = new Float64Array(4);

/** Beam turret: hits the k nearest hostile units in range. */
function turretFire(w: World, n: Nest, range: number, k: number, dps: number): void {
  for (let i = 0; i < k; i++) {
    bestSlot[i] = -1;
    bestD[i] = Infinity;
  }
  queryRadius(w, n.x, n.y, range, scratch);
  const walls = w.terrain.hasWalls && w.terrain.wallsNear(n.x - range, n.y - range, n.x + range, n.y + range);
  for (const s of scratch) {
    if (!w.hostile(w.owner[s], n.owner)) continue;
    const d = (w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2;
    if (walls && d < bestD[k - 1] && !w.terrain.los(n.x, n.y, w.x[s], w.y[s])) continue;
    // insertion into the k nearest
    for (let i = 0; i < k; i++) {
      if (d < bestD[i]) {
        for (let j = k - 1; j > i; j--) {
          bestD[j] = bestD[j - 1];
          bestSlot[j] = bestSlot[j - 1];
        }
        bestD[i] = d;
        bestSlot[i] = s;
        break;
      }
    }
  }
  for (let i = 0; i < k; i++) {
    const s = bestSlot[i];
    if (s < 0) break;
    w.dmg[s] += dps * DT;
    w.lastHit[s] = n.owner;
    w.beams[w.beamCount * 2] = -(n.id + 1);
    w.beams[w.beamCount * 2 + 1] = s;
    w.beamCount++;
  }
}
