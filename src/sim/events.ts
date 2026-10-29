import { DT, ENERGY, EVENTS, Kind, MAX_LEVEL, NEST_KIND, NEUTRAL, NUM_FACTIONS, TICK_HZ, TRAITS, UNIT_STATS, escalation } from './constants';
import { groupArrive } from './commands';
import type { EventSpec } from './mapgen';
import { TAU, dcos, dsin } from './mathx';
import { updateHeart } from './heart';
import { updateSiege } from './siege';
import { Rng } from './rng';
import { queryRadius } from './spatial';
import { pushFx, removeUnit, spawnUnit, WILD_COLOSSUS, WILD_SWARM, type Colossus, type Swarm, type World } from './world';

/**
 * Living-map events: wild swarms, supply drops, the Colossus and garrison
 * regrowth. The schedule and places come from the map spec; everything
 * random uses the events' own seeded stream, so a match with events off
 * plays exactly as before. Neutral units are driven directly (they are not
 * a player, so they issue no Commands).
 */
export function initEvents(w: World, spec: EventSpec): void {
  const p = spec.params;
  if (!p.swarm && !p.drop && p.colossus.length === 0 && !p.regrow) return;
  w.events = {
    spec,
    rng: new Rng(w.seed ^ 0x6ee7a1),
    nextSwarm: p.swarm ? Math.round(p.swarm.first * TICK_HZ) : -1,
    nextDrop: p.drop ? Math.round(p.drop.first * TICK_HZ) : -1,
    swarmCount: 0,
    dropCount: 0,
    swarms: [],
    drops: [],
    colossi: [],
  };
}

const scratch: number[] = [];

export function updateEvents(w: World): void {
  const ev = w.events;
  if (!ev) return;
  const p = ev.spec.params;
  const t = w.tick;

  if (p.swarm && t === ev.nextSwarm) {
    spawnSwarm(w);
    ev.nextSwarm += Math.round(p.swarm.every * TICK_HZ);
  }
  if (p.drop && t === ev.nextDrop) {
    spawnDrop(w);
    ev.nextDrop += Math.round(p.drop.every * TICK_HZ);
  }
  for (let k = 0; k < p.colossus.length; k++) {
    if (t === Math.round(p.colossus[k] * TICK_HZ)) spawnColossus(w, k);
  }

  if (ev.swarms.length && t % EVENTS.swarmRethink === 0) for (const s of ev.swarms) steerSwarm(w, s);
  if (w.heart) updateHeart(w);
  if (w.siege) updateSiege(w);
  ev.swarms = ev.swarms.filter((s) => (s.uids = s.uids.filter((u) => w.uidToSlot.has(u))).length > 0);
  if (ev.colossi.length) updateColossi(w);
  if (ev.drops.length) updateDrops(w);
  if (p.regrow > 0 && t % TICK_HZ === 0) regrow(w, p.regrow);
}

// ---- wild swarm ------------------------------------------------------------

function wildCount(w: World): number {
  let n = 0;
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.wild[i] === WILD_SWARM) n++;
  return n;
}

function spawnSwarm(w: World): void {
  const ev = w.events!;
  const cfg = ev.spec.params.swarm!;
  const size = Math.round(cfg.size * (1 + 0.6 * escalation(w.tick)));
  if (wildCount(w) > size * EVENTS.swarmMaxOut) return;
  const spawns = ev.spec.swarmSpawns;
  // Rotate through the borders from a seeded start, so no sector is favored.
  if (ev.swarmCount === 0) ev.swarmCount = ev.rng.int(spawns.length);
  const [sx, sy] = spawns[ev.swarmCount++ % spawns.length];
  releaseSwarm(w, sx, sy, size, ev.spec.params.bloom ? 'bloomSwarm' : 'swarmSpawn');
}

/** A wild swarm of `size` around (sx, sy) that starts hunting at once. */
/** A wild swarm's usual mix: Swarmers, every fifth a Raider. */
const SWARM_MIX: readonly number[] = [Kind.Dot, Kind.Dot, Kind.Dot, Kind.Dot, Kind.Swift];

export function releaseSwarm(w: World, sx: number, sy: number, size: number, fx: 'swarmSpawn' | 'bloomSwarm' | null, mix: readonly number[] = SWARM_MIX): Swarm {
  const ev = w.events!;
  const sw: Swarm = { uids: [], tx: sx, ty: sy };
  const spread = Math.sqrt(size) * 6;
  for (let k = 0; k < size; k++) {
    const a = ev.rng.next() * TAU, r = Math.sqrt(ev.rng.next()) * spread;
    const [x, y] = w.terrain.freePoint(sx + dcos(a) * r, sy + dsin(a) * r, 4);
    const kind = mix[k % mix.length];
    const s = spawnUnit(w, NEUTRAL, kind, x, y, sx, sy, groupArrive(size));
    if (s < 0) break;
    w.wild[s] = WILD_SWARM;
    sw.uids.push(w.uid[s]);
  }
  ev.swarms.push(sw);
  steerSwarm(w, sw);
  if (fx) pushFx(w, fx, sx, sy, NEUTRAL, spread);
  return sw;
}

const candX: number[] = [];
const candY: number[] = [];

/** Head for the biggest army nearby; wander between drop spots if nobody is around. */
export function steerSwarm(w: World, sw: Swarm): void {
  let cx = 0, cy = 0, n = 0;
  for (const u of sw.uids) {
    const s = w.uidToSlot.get(u);
    if (s === undefined) continue;
    cx += w.x[s];
    cy += w.y[s];
    n++;
  }
  if (n === 0) return;
  cx /= n;
  cy /= n;

  // Candidates: player nests plus a stride sample of player units. A siege
  // wave (#67) only hunts its quarry, and goes for the nearest of its nests.
  candX.length = candY.length = 0;
  if (sw.hunt !== undefined) {
    let bd = Infinity;
    for (const nest of w.nests) {
      if (nest.owner !== sw.hunt) continue;
      // The capital is the prize; raiders pick off the outer nests first.
      const d = (nest.x - cx) ** 2 + (nest.y - cy) ** 2 + (nest.capital === !!sw.raid ? 1e8 : 0);
      if (d < bd) (bd = d), (sw.tx = nest.x), (sw.ty = nest.y);
    }
    if (bd < Infinity) {
      const ar = groupArrive(n);
      for (const u of sw.uids) {
        const s = w.uidToSlot.get(u);
        if (s === undefined) continue;
        w.ox[s] = sw.tx;
        w.oy[s] = sw.ty;
        w.arrive[s] = ar;
      }
      return;
    }
  }
  for (const nest of w.nests) {
    if (nest.owner >= 0 && nest.owner !== NEUTRAL) {
      candX.push(nest.x);
      candY.push(nest.y);
    }
  }
  for (let i = w.tick % 17; i < w.n; i += 17) {
    if (!w.alive[i] || w.owner[i] === NEUTRAL) continue;
    candX.push(w.x[i]);
    candY.push(w.y[i]);
  }
  let best = -1, bestScore = 4;
  for (let k = 0; k < candX.length; k++) {
    queryRadius(w, candX[k], candY[k], EVENTS.swarmSense, scratch);
    let wt = 0;
    for (const s of scratch) if (w.owner[s] !== NEUTRAL) wt += UNIT_STATS[w.kind[s]].weight;
    const d = Math.sqrt((candX[k] - cx) ** 2 + (candY[k] - cy) ** 2);
    const score = wt / (1 + d / 400);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  if (best >= 0) {
    sw.tx = candX[best];
    sw.ty = candY[best];
  } else if ((sw.tx - cx) ** 2 + (sw.ty - cy) ** 2 < 60 * 60) {
    // Hand-authored maps may have no drop spots: then it just holds.
    const spots = w.events!.spec.dropSpots;
    if (spots.length) [sw.tx, sw.ty] = spots[w.events!.rng.int(spots.length)];
  }
  const ar = groupArrive(n);
  for (const u of sw.uids) {
    const s = w.uidToSlot.get(u);
    if (s === undefined) continue;
    w.ox[s] = sw.tx;
    w.oy[s] = sw.ty;
    w.arrive[s] = ar;
  }
}

// ---- supply drops ------------------------------------------------------------

function spawnDrop(w: World): void {
  const ev = w.events!;
  const spots = ev.spec.dropSpots;
  // Usually land near whoever is weakest, so drops pull the leader out of
  // its turtle instead of feeding it. Never the same spot twice in a row.
  let k = ev.rng.int(spots.length);
  const weak = weakestHome(w);
  if (weak && ev.rng.next() < EVENTS.dropNearWeakest) {
    let bd = Infinity;
    for (let j = 0; j < spots.length; j++) {
      if (spots.length > 1 && j === ev.dropCount) continue;
      const d = w.terrain.pathDist(weak[0], weak[1], spots[j][0], spots[j][1], w.tick);
      if (d < bd) {
        bd = d;
        k = j;
      }
    }
  } else if (spots.length > 1 && k === ev.dropCount) k = (k + 1) % spots.length;
  ev.dropCount = k;
  const [x, y] = spots[k];
  ev.drops.push({ x, y, lands: w.tick + EVENTS.dropTelegraph, expires: w.tick + EVENTS.dropTelegraph + EVENTS.dropLifetime, progress: 0, holder: -1 });
  pushFx(w, 'dropIncoming', x, y, NEUTRAL, EVENTS.dropRadius);
}

/** Nest centroid of the active player with the smallest army, or null. */
function weakestHome(w: World): [number, number] | null {
  let weak = -1;
  for (let f = 0; f < NEUTRAL; f++) {
    const fa = w.factions[f];
    if (!fa.active || fa.eliminated) continue;
    if (weak < 0 || w.unitCount[f] < w.unitCount[weak]) weak = f;
  }
  let x = 0, y = 0, n = 0;
  for (const nest of w.nests) {
    if (nest.owner !== weak) continue;
    x += nest.x;
    y += nest.y;
    n++;
  }
  return n > 0 ? [x / n, y / n] : null;
}

/** The faction with the biggest army. */
function armyLeader(w: World): number {
  let lead = -1;
  for (let f = 0; f < NEUTRAL; f++) {
    if (!w.factions[f].active || w.factions[f].eliminated) continue;
    if (lead < 0 || w.unitCount[f] > w.unitCount[lead]) lead = f;
  }
  return lead;
}

const counts = new Int32Array(NUM_FACTIONS);

function updateDrops(w: World): void {
  const ev = w.events!;
  const STEP = 6;
  ev.drops = ev.drops.filter((d) => {
    if (w.tick >= d.expires) return false;
    if (w.tick < d.lands || w.tick % STEP !== 0) return true;
    // Who's on it? Raiders count triple, as on nests; wild units only block.
    counts.fill(0);
    queryRadius(w, d.x, d.y, EVENTS.dropRadius, scratch);
    let team = -1, lead = -1, mixed = false, total = 0;
    for (const s of scratch) {
      const o = w.owner[s];
      if (team >= 0 && w.teamOf[o] !== team) mixed = true;
      if (team < 0) team = w.teamOf[o];
      counts[o] += w.kind[s] === Kind.Swift ? TRAITS.raidCapture : 1;
      if (lead < 0 || counts[o] > counts[lead]) lead = o;
      total += w.kind[s] === Kind.Swift ? TRAITS.raidCapture : 1;
    }
    if (mixed || lead < 0 || lead === NEUTRAL) return true;
    const rate = (EVENTS.dropBase + EVENTS.dropPerUnit * Math.min(total, 20)) * DT * STEP;
    if (d.holder >= 0 && w.teamOf[d.holder] !== w.teamOf[lead]) {
      // Someone else's progress drains first, twice as fast.
      d.progress -= rate * 2;
      if (d.progress <= 0) {
        d.progress = 0;
        d.holder = lead;
      }
      return true;
    }
    d.holder = lead;
    d.progress += rate;
    if (d.progress < 1) return true;
    const f = w.factions[lead];
    // The biggest army only gets the energy: drops are a comeback tool.
    const upgraded = lead === armyLeader(w) ? 0 : grantUpgrade(w, lead);
    f.energy = Math.min(ENERGY.max, f.energy + EVENTS.dropEnergy + (upgraded ? 0 : EVENTS.dropEnergyNoUpgrade));
    pushFx(w, 'dropTaken', d.x, d.y, lead, EVENTS.dropRadius, upgraded ? upgraded : -1);
    return false;
  });
}

/** Level up a faction's lowest nest that can still grow. Returns its id + 1, or 0. */
export function grantUpgrade(w: World, f: number): number {
  let best = -1;
  for (const n of w.nests) {
    if (n.owner !== f || n.control < 1 || n.level >= MAX_LEVEL) continue;
    if (best < 0 || n.level < w.nests[best].level) best = n.id;
  }
  if (best < 0) return 0;
  const n = w.nests[best];
  n.level++;
  n.feedProgress = 0;
  pushFx(w, 'levelup', n.x, n.y, f, n.r, n.id);
  return best + 1;
}

// ---- Colossus ----------------------------------------------------------------

function spawnColossus(w: World, k: number): void {
  const ev = w.events!;
  const paths = ev.spec.colossusPaths;
  const path = paths[(ev.rng.int(paths.length) + k) % paths.length];
  const [x, y] = path[0];
  const s = spawnUnit(w, NEUTRAL, Kind.Colossus, x, y, path[1][0], path[1][1], 30);
  if (s < 0) return;
  w.wild[s] = WILD_COLOSSUS;
  ev.colossi.push({ uid: w.uid[s], path, leg: 1, maxHp: w.hp[s] });
  pushFx(w, 'colossusSpawn', x, y, NEUTRAL, 60);
}

function updateColossi(w: World): void {
  const ev = w.events!;
  ev.colossi = ev.colossi.filter((c: Colossus) => {
    const s = w.uidToSlot.get(c.uid);
    if (s === undefined) return false;
    const [tx, ty] = c.path[c.leg];
    if ((w.x[s] - tx) ** 2 + (w.y[s] - ty) ** 2 < 50 * 50) {
      if (c.leg === c.path.length - 1) {
        if (c.stay) return true;
        // Walked off the far side: nobody got it.
        removeUnit(w, s);
        return false;
      }
      c.leg++;
      w.ox[s] = c.path[c.leg][0];
      w.oy[s] = c.path[c.leg][1];
    }
    if ((w.tick + s) % TRAITS.stomp.every === 0) stomp(w, s);
    return true;
  });
}

function stomp(w: World, s: number): void {
  queryRadius(w, w.x[s], w.y[s], TRAITS.stomp.radius, scratch);
  let hit = 0;
  for (const j of scratch) {
    if (!w.hostile(w.owner[j], NEUTRAL)) continue;
    w.dmg[j] += TRAITS.stomp.damage;
    w.lastHit[j] = NEUTRAL;
    hit++;
  }
  if (hit > 0) pushFx(w, 'stomp', w.x[s], w.y[s], NEUTRAL, TRAITS.stomp.radius);
}

/** Whoever lands the killing blow on a Colossus: full energy and a free upgrade. */
export function colossusSlain(w: World, x: number, y: number, killer: number): void {
  giantReward(w, killer);
  pushFx(w, 'colossusDown', x, y, killer, 80);
}

/** Whoever fells a giant (a Colossus or the Bloom's heart) gets full energy and an upgrade. Returns whether a player did. */
export function giantReward(w: World, killer: number): boolean {
  if (killer < 0 || killer === NEUTRAL) return false;
  w.factions[killer].energy = ENERGY.max;
  grantUpgrade(w, killer);
  return true;
}

// ---- garrison regrowth --------------------------------------------------------

/** Neutral nests rebuild their guards; unowned nests left alone go wild again. Runs once a second. */
function regrow(w: World, every: number): void {
  const t = w.tick;
  const due = t % Math.round(every * TICK_HZ) < TICK_HZ;
  for (const n of w.nests) {
    queryRadius(w, n.x, n.y, n.r + 30, scratch);
    let guards = 0, others = 0;
    for (const s of scratch) {
      if (w.owner[s] === NEUTRAL && w.wild[s] === 0) guards++;
      else others++;
    }
    if (others > 0) n.visited = t;
    if (n.owner < 0 && t - n.visited > EVENTS.revertAfter && n.control <= 0) {
      n.owner = NEUTRAL;
      n.controller = NEUTRAL;
      n.control = 1;
      n.garrison = Math.max(EVENTS.revertGarrison, Math.min(n.garrison, EVENTS.revertGarrison * 2));
      pushFx(w, 'neutralize', n.x, n.y, NEUTRAL, n.r, n.id, -1);
    }
    if (!due || n.owner !== NEUTRAL || others > 0 || guards >= n.garrison) continue;
    const kind = NEST_KIND[n.type] < 0 ? Kind.Dot : NEST_KIND[n.type];
    const a = w.events!.rng.next() * TAU;
    const x = n.x + dcos(a) * n.r * 0.7, y = n.y + dsin(a) * n.r * 0.7;
    spawnUnit(w, NEUTRAL, kind, x, y, x, y, 6);
  }
}
