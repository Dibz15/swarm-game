import { ENERGY, EVENTS, Kind, MAX_LEVEL, NEUTRAL, TICK_HZ } from './constants';
import { captureDrop, DROP_STEP, releaseSwarm, steerSwarm } from './events';
import { TAU, dcos, dpow, dsin } from './mathx';
import { Rng } from './rng';
import { pushFx, spawnUnit, WILD_COLOSSUS, type BoonId, type Defender, type SiegeState, type Wave, type WaveKind, type World } from './world';

/**
 * Hold the line (#67): you're dug in behind your own walls and must still
 * hold your capital when the clock runs out. The Bloom comes in waves of
 * different kinds on a schedule rolled up front (so the HUD can show what's
 * coming), hunting you. The field outside is the Bloom's: waves emerge from
 * its nests there, and every one it still holds makes them bigger, so
 * sallying out to take them thins the waves.
 * Every other wave, you pick a boon. Lose the capital and you have
 * SIEGE.retake to win it back. Everything random is seeded. PROVISIONAL (#68).
 *
 * Co-op (#228): two to four defenders on one team, each walled in at its own
 * capital. The waves are bigger and come faster, and hunt whichever defender
 * is nearest. Boons drop on the field outside each fortress instead of being
 * offered: whoever captures one gets it. The line holds only if every capital
 * is held at the clock; it breaks when every capital has stayed fallen past
 * SIEGE.retake, or the clock runs out with one still fallen.
 */
export interface SiegeSetup {
  /** how long to hold */
  seconds: number;
  /** the first wave, and the gap between waves (seconds) */
  first: number;
  every: number;
  /** the first wave's size, and how much each one grows */
  size: number;
  grow: number;
  /** how far into the run (0..1): later runs bring more kinds of wave */
  depth: number;
}

/**
 * The siege at `t` (0..1) along the campaign's curve: longer, faster and
 * bigger later, waves times `scale` (#67). The campaign places a node on it by
 * run depth and the Bloom's growth; a skirmish picks Easy, Normal or Hard (#222).
 * PROVISIONAL (#68).
 */
export function siegeAt(t: number, scale = 1): SiegeSetup {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return { seconds: Math.round(lerp(180, 300)), first: 20, every: Math.round(lerp(36, 26)), size: Math.round(lerp(22, 38) * scale), grow: 1.18, depth: t };
}

export const SIEGE = {
  /** a fallen capital has this long to be retaken */
  retake: 20 * TICK_HZ,
  /** no wave this close to the end */
  quiet: 10,
  /** each field nest the Bloom holds makes the waves this much bigger */
  perNest: 0.14,
  /** a boon is offered after every this-many waves, this long after the wave, and stays open this long */
  boonEvery: 2,
  boonDelay: 10 * TICK_HZ,
  boonOpen: 10 * TICK_HZ,
  /** co-op (#228): each defender past the first makes the waves this much bigger, and this much more often */
  coopSize: 0.6,
  coopPace: 0.15,
  /** co-op boon drops: telegraph, then how long they stay to be captured */
  dropTelegraph: 4 * TICK_HZ,
  dropOpen: 20 * TICK_HZ,
  /** how far out from a capital a boon drops (past the widest wall) */
  dropOut: [300, 420] as [number, number],
};

/** Boons between waves: what each does (scaled to the siege) and how it reads. */
export const BOONS: Record<BoonId, { name: string; text: string }> = {
  reinforce: { name: 'Reinforcements', text: 'A fresh brood at your capital, now' },
  production: { name: 'Hatcheries', text: 'Your nests spawn 20% faster for the rest of the siege' },
  energy: { name: 'Surge of power', text: 'Full energy, now' },
  levels: { name: 'Raise the walls', text: 'Your capital and inner nests go up a level' },
};
const BOON_IDS = Object.keys(BOONS) as BoonId[];

/** Each kind: when it joins the pool (run depth), its unit mix, and its size against a swarm. */
export const WAVE_KINDS: Record<WaveKind, { from: number; mix: readonly number[]; size: number; name: string }> = {
  swarm: { from: 0, mix: [Kind.Dot, Kind.Dot, Kind.Dot, Kind.Dot, Kind.Swift], size: 1, name: 'Swarm' },
  brutes: { from: 0, mix: [Kind.Tank, Kind.Tank, Kind.Tank, Kind.Dot], size: 0.45, name: 'Brutes' },
  raiders: { from: 0, mix: [Kind.Swift], size: 0.9, name: 'Raiders' },
  spears: { from: 0.35, mix: [Kind.Lancer, Kind.Lancer, Kind.Dot], size: 0.75, name: 'Spears' },
  pincer: { from: 0.35, mix: [Kind.Dot, Kind.Dot, Kind.Dot, Kind.Swift], size: 1.1, name: 'Pincer' },
  colossus: { from: 0.65, mix: [Kind.Dot, Kind.Dot, Kind.Swift], size: 0.5, name: 'Colossus' },
};
const KINDS = Object.keys(WAVE_KINDS) as WaveKind[];

/** Start the siege: the defenders' capitals, the far spawns, and the whole wave schedule. */
export function initSiege(w: World, s: SiegeSetup, humans: readonly number[]): void {
  const ev = w.events;
  const caps = humans.map((f) => ({ f, cap: w.nests.find((n) => n.capital && n.owner === f) })).filter((d) => d.cap);
  if (!ev || !caps.length) return;
  // Waves emerge from the Bloom's nests; once those are all taken, from the
  // map's swarm spawns furthest from every defender (the far half).
  const spawns = [...ev.spec.swarmSpawns]
    .map((p) => ({ p, d: Math.min(...caps.map(({ cap }) => (p[0] - cap!.x) ** 2 + (p[1] - cap!.y) ** 2)) }))
    .sort((a, b) => b.d - a.d)
    .slice(0, Math.max(2, Math.ceil(ev.spec.swarmSpawns.length / 2)))
    .map((o) => o.p);
  if (!spawns.length) return;
  // More defenders, bigger and faster waves: the line is still a fight (#228). PROVISIONAL (#231).
  const k = caps.length - 1;
  const ss = k ? { ...s, size: Math.round(s.size * (1 + SIEGE.coopSize * k)), every: s.every / (1 + SIEGE.coopPace * k) } : s;
  const defenders: Defender[] = caps.map(({ f, cap }) => ({ f, capital: cap!.id, lostAt: -1, drop: k ? dropSpot(w, cap!.x, cap!.y, spawns) : null }));
  w.siege = {
    until: w.tick + Math.round(s.seconds * TICK_HZ),
    waves: rollWaves(new Rng(w.seed ^ 0x5e1e9e), ss, spawns, w.tick),
    next: 0,
    defenders,
    spawns,
    bloomNests: w.nests.filter((n) => n.owner === NEUTRAL).map((n) => n.id),
    offer: null,
    offerAt: -1,
    boons: [],
    drops: [],
  };
}

/**
 * Where a defender's boons drop (co-op, #228): open ground outside its walls,
 * toward the Bloom's nearest spawn, that its capital can walk to.
 */
function dropSpot(w: World, cx: number, cy: number, spawns: [number, number][]): [number, number] | null {
  let tx = w.width / 2, ty = w.height / 2, bd = Infinity;
  for (const [x, y] of spawns) {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bd) (bd = d), (tx = x), (ty = y);
  }
  const dl = Math.sqrt((tx - cx) ** 2 + (ty - cy) ** 2) || 1;
  const ux = (tx - cx) / dl, uy = (ty - cy) / dl;
  const [r0, r1] = SIEGE.dropOut;
  for (let r = r0; r <= r1; r += 20)
    for (const b of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
      const c = dcos(b), sn = dsin(b);
      const x = cx + (ux * c - uy * sn) * r, y = cy + (ux * sn + uy * c) * r;
      if (x < 40 || y < 40 || x > w.width - 40 || y > w.height - 40) continue;
      if (w.terrain.clearance(x, y) < EVENTS.dropRadius) continue;
      if (Number.isFinite(w.terrain.pathDist(x, y, cx, cy, 0))) return [x, y];
    }
  return null;
}

/** How much bigger the waves are for the field nests the Bloom still holds. */
export function bloomFactor(w: World): number {
  const sg = w.siege!;
  let n = 0;
  for (const id of sg.bloomNests) if (w.nests[id].owner === NEUTRAL) n++;
  return 1 + SIEGE.perNest * n;
}

/** A wave's size as it would come right now. */
export const waveSize = (w: World, wave: Wave): number => Math.round(wave.size * bloomFactor(w));

/** The wave schedule: when, what, how many and from where. */
export function rollWaves(rng: Rng, s: SiegeSetup, spawns: [number, number][], t0 = 0): Wave[] {
  const out: Wave[] = [];
  const pool = KINDS.filter((k) => WAVE_KINDS[k].from <= s.depth);
  let lastColossus = -10;
  for (let k = 0, t = s.first; t < s.seconds - SIEGE.quiet; k++, t += s.every) {
    const prev = out[out.length - 1]?.kind;
    // The first is a plain swarm; after that no kind twice running, and a Colossus at most every fourth wave.
    const ok = pool.filter((c) => c !== prev && (c !== 'colossus' || (k >= 3 && k - lastColossus >= 4)));
    const kind: WaveKind = k === 0 ? 'swarm' : rng.pick(ok.length ? ok : pool);
    if (kind === 'colossus') lastColossus = k;
    const a = rng.int(spawns.length);
    let from = [a];
    if (kind === 'pincer') {
      // The spawn furthest from the first: they close in from both sides.
      let b = a, best = -1;
      spawns.forEach((p, i) => {
        const d = (p[0] - spawns[a][0]) ** 2 + (p[1] - spawns[a][1]) ** 2;
        if (d > best) (best = d), (b = i);
      });
      from = [a, b];
    }
    const size = Math.max(4, Math.round(s.size * dpow(s.grow, k) * WAVE_KINDS[kind].size));
    out.push({ at: t0 + Math.round(t * TICK_HZ), kind, size, from });
  }
  return out;
}

/** Release the waves that are due. Runs from updateEvents. */
export function updateSiege(w: World): void {
  const sg = w.siege!;
  while (sg.next < sg.waves.length && w.tick >= sg.waves[sg.next].at) {
    release(w, sg, sg.waves[sg.next++]);
    if (sg.next % SIEGE.boonEvery === 0 && sg.offerAt < 0 && !sg.offer) sg.offerAt = w.tick + SIEGE.boonDelay;
  }
  // Boons: offered a little after every other wave; the first is taken if you don't choose.
  // In co-op they drop on the field instead (#228).
  if (sg.offerAt >= 0 && w.tick >= sg.offerAt && sg.defenders.length > 1) {
    sg.offerAt = -1;
    dropBoons(w, sg);
  } else if (sg.offerAt >= 0 && w.tick >= sg.offerAt) {
    sg.offerAt = -1;
    const rng = new Rng((w.seed ^ 0xb0b0) + sg.boons.length * 7919);
    const pool = [...BOON_IDS];
    const ids: BoonId[] = [];
    while (ids.length < 3) ids.push(pool.splice(rng.int(pool.length), 1)[0]);
    sg.offer = { ids, until: w.tick + SIEGE.boonOpen };
    pushFx(w, 'boonOffer', 0, 0, sg.defenders[0].f);
  }
  if (sg.offer && w.tick >= sg.offer.until) takeBoon(w, sg.defenders[0].f, 0);
  if (sg.drops.length) updateBoonDrops(w, sg);
}

/** Co-op (#228): a boon drops outside each defender's walls, each a seeded pick. */
function dropBoons(w: World, sg: SiegeState): void {
  const rng = new Rng((w.seed ^ 0xd2091) + sg.next * 7919);
  sg.defenders.forEach((d) => {
    if (!d.drop || w.factions[d.f].eliminated) return;
    const [x, y] = d.drop;
    const id = BOON_IDS[rng.int(BOON_IDS.length)];
    const lands = w.tick + SIEGE.dropTelegraph;
    sg.drops.push({ id, x, y, lands, expires: lands + SIEGE.dropOpen, progress: 0, holder: -1 });
    pushFx(w, 'boonDrop', x, y, d.f, EVENTS.dropRadius, -1, BOON_IDS.indexOf(id));
  });
}

/** Boon drops fill like supply drops; whoever completes one gets the boon. */
function updateBoonDrops(w: World, sg: SiegeState): void {
  sg.drops = sg.drops.filter((d) => {
    if (w.tick >= d.expires) return false;
    if (w.tick < d.lands || w.tick % DROP_STEP !== 0) return true;
    const f = captureDrop(w, d);
    if (f < 0) return true;
    sg.boons.push(d.id);
    applyBoon(w, f, d.id);
    return false;
  });
}

/** Take boon `k` of the offer on the table (a command, so it's in lockstep). */
export function takeBoon(w: World, p: number, k: number): void {
  const sg = w.siege;
  if (!sg || !sg.offer || sg.defenders.length !== 1 || p !== sg.defenders[0].f) return;
  const id = sg.offer.ids[k] ?? sg.offer.ids[0];
  sg.offer = null;
  sg.boons.push(id);
  applyBoon(w, p, id);
}

/** Boon `id` for faction `p`, around its own capital (or the first defender's, if `p` isn't one). */
function applyBoon(w: World, p: number, id: BoonId): void {
  const sg = w.siege!;
  const f = w.factions[p];
  const cap = w.nests[(sg.defenders.find((d) => d.f === p) ?? sg.defenders[0]).capital];
  if (id === 'reinforce') {
    // About the size of the next wave's half, mostly Swarmers with Shields among them.
    const next = sg.waves[Math.min(sg.next, sg.waves.length - 1)];
    const n = Math.round(10 + 0.5 * (next ? waveSize(w, next) : 20));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU, r = cap.r * (0.6 + 0.5 * ((k * 7) % 5) / 5);
      spawnUnit(w, p, k % 4 === 3 ? Kind.Tank : Kind.Dot, cap.x + dcos(a) * r, cap.y + dsin(a) * r, cap.x, cap.y, cap.r + 14);
    }
  } else if (id === 'production') f.prodMult *= 1.2;
  else if (id === 'energy') f.energy = ENERGY.max;
  else if (id === 'levels') {
    for (const n of w.nests) if (n.owner === p && (n.capital || (n.x - cap.x) ** 2 + (n.y - cap.y) ** 2 < 260 * 260)) n.level = Math.min(MAX_LEVEL, n.level + 1);
  }
  pushFx(w, 'boonTaken', cap.x, cap.y, p, cap.r, -1, BOON_IDS.indexOf(id));
}

function release(w: World, sg: SiegeState, wave: Wave): void {
  const info = WAVE_KINDS[wave.kind];
  const size = waveSize(w, wave);
  const from = sources(w, sg, wave);
  const per = Math.ceil(size / from.length);
  from.forEach(([x, y], side) => {
    const sw = releaseSwarm(w, x, y, per, 'bloomSwarm', info.mix);
    sw.hunt = w.teamOf[sg.defenders[0].f];
    sw.raid = wave.kind === 'raiders';
    steerSwarm(w, sw);
    pushFx(w, 'siegeWave', x, y, NEUTRAL, 40, -1, sg.next - 1, side);
  });
  if (wave.kind === 'colossus') {
    // A Colossus walks straight for the nearest capital, and stays there.
    const [x, y] = from[0];
    let cap = w.nests[sg.defenders[0].capital];
    for (const d of sg.defenders) {
      const n = w.nests[d.capital];
      if ((n.x - x) ** 2 + (n.y - y) ** 2 < (cap.x - x) ** 2 + (cap.y - y) ** 2) cap = n;
    }
    const s = spawnUnit(w, NEUTRAL, Kind.Colossus, x, y, cap.x, cap.y, 30);
    if (s >= 0) {
      w.wild[s] = WILD_COLOSSUS;
      w.events!.colossi.push({ uid: w.uid[s], path: [[x, y], [cap.x, cap.y]], leg: 1, maxHp: w.hp[s], stay: true });
      pushFx(w, 'colossusSpawn', x, y, NEUTRAL, 60);
    }
  }
}

/**
 * Where a wave comes from: one of the Bloom's nests still standing in the
 * field (a pincer: two, as far apart as they get). Only once you have taken
 * them all does it come in from the map's edge.
 */
function sources(w: World, sg: SiegeState, wave: Wave): [number, number][] {
  const standing = sg.bloomNests.map((id) => w.nests[id]).filter((n) => n.owner === NEUTRAL);
  if (!standing.length) return wave.from.map((i) => sg.spawns[i]);
  const a = standing[wave.from[0] % standing.length];
  const out: [number, number][] = [[a.x, a.y]];
  if (wave.from.length > 1 && standing.length > 1) {
    let b = a, best = -1;
    for (const n of standing) {
      const d = (n.x - a.x) ** 2 + (n.y - a.y) ** 2;
      if (d > best) (best = d), (b = n);
    }
    out.push([b.x, b.y]);
  } else if (wave.from.length > 1) out.push(sg.spawns[wave.from[1]]);
  return out;
}

/**
 * The siege's say in victory (from checkVictory). Each capital that stays lost
 * for SIEGE.retake is gone for good unless retaken; the line breaks when every
 * one is (or every defender is wiped out). It holds if every capital is the
 * defenders' at the end; in co-op, one still fallen then breaks it (#228).
 * Returns true when the siege decided the check (nothing else may end it).
 */
export function siegeVictory(w: World): boolean {
  const sg = w.siege!;
  const team = w.teamOf[sg.defenders[0].f];
  let allHeld = true, allGone = true, allDead = true;
  for (const d of sg.defenders) {
    const cap = w.nests[d.capital];
    // A teammate retaking it counts (#228).
    const held = cap.owner >= 0 && cap.owner !== NEUTRAL && w.teamOf[cap.owner] === team;
    if (!held && d.lostAt < 0) {
      d.lostAt = w.tick;
      pushFx(w, 'capitalLost', cap.x, cap.y, d.f, cap.r);
    } else if (held && d.lostAt >= 0) {
      d.lostAt = -1;
      pushFx(w, 'capitalRetaken', cap.x, cap.y, cap.owner, cap.r);
    }
    if (!held) allHeld = false;
    if (!(d.lostAt >= 0 && w.tick - d.lostAt >= SIEGE.retake)) allGone = false;
    if (!w.factions[d.f].eliminated) allDead = false;
  }
  const end = w.tick >= sg.until;
  if (allDead || allGone || (end && !allHeld && sg.defenders.length > 1)) {
    w.over = true;
    w.winnerTeam = -1;
    w.winReason = 'fallen';
  } else if (end && allHeld) {
    w.over = true;
    w.winnerTeam = team;
    w.winReason = 'held';
  }
  return true;
}
