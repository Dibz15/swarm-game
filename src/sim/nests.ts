import {
  BASTION,
  DT,
  ENERGY,
  FACTION_UNIT_CAP,
  LEVEL_SPAWN_MULT,
  NEST_KIND,
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

export function updateNests(w: World): void {
  for (const n of w.nests) {
    updateControl(w, n);
    if (n.type === NestType.Bastion) bastionFire(w, n);
    else spawn(w, n);
  }
}

function updateControl(w: World, n: Nest): void {
  counts.fill(0);
  queryRadius(w, n.x, n.y, n.r, scratch);
  for (const s of scratch) {
    if (w.state[s] === UNIT_FEEDING) continue;
    counts[w.owner[s]]++;
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
    if (n.owner >= 0) n.control = Math.min(1, n.control + DT * 0.08);
    else n.control = Math.max(0, n.control - DT * 0.08);
    return;
  }

  // Neutral garrison units only defend; they never capture.
  if (leadA === NEUTRAL && n.owner !== NEUTRAL) return;

  const rate = captureRate(totalA, n.level);
  if (n.owner >= 0 && teamA === ownerTeam) {
    n.control = Math.min(1, n.control + rate);
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
  if (n.owner < 0 || n.owner === NEUTRAL || n.control < 1 || n.contested) return;
  const kind = NEST_KIND[n.type];
  if (kind < 0) return;
  if (w.unitCount[n.owner] >= FACTION_UNIT_CAP) return;
  const f = w.factions[n.owner];
  n.spawnAcc += DT * LEVEL_SPAWN_MULT[n.level] * f.prodMult;
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

function bastionFire(w: World, n: Nest): void {
  if (n.owner < 0 || n.control < BASTION.minControl) return;
  const range = BASTION.range + BASTION.rangePerLevel * (n.level - 1);
  const k = n.owner === NEUTRAL ? 1 : n.level;
  for (let i = 0; i < k; i++) {
    bestSlot[i] = -1;
    bestD[i] = Infinity;
  }
  queryRadius(w, n.x, n.y, range, scratch);
  for (const s of scratch) {
    if (!w.hostile(w.owner[s], n.owner)) continue;
    const d = (w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2;
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
    w.dmg[s] += BASTION.dps * DT;
    w.lastHit[s] = n.owner;
    w.beams[w.beamCount * 2] = -(n.id + 1);
    w.beams[w.beamCount * 2 + 1] = s;
    w.beamCount++;
  }
}
