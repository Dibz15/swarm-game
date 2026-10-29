import { Kind, NEUTRAL, TICK_HZ } from './constants';
import { releaseSwarm, steerSwarm } from './events';
import { dpow } from './mathx';
import { Rng } from './rng';
import { pushFx, spawnUnit, WILD_COLOSSUS, type SiegeState, type Wave, type WaveKind, type World } from './world';

/**
 * Hold the line (#67): you're dug in behind your own walls and must still
 * hold your capital when the clock runs out. The Bloom comes in waves of
 * different kinds on a schedule rolled up front (so the HUD can show what's
 * coming), hunting you; a rival pushes too. Lose the capital and you have
 * SIEGE.retake to win it back. Everything random is seeded. PROVISIONAL (#68).
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

export const SIEGE = {
  /** a fallen capital has this long to be retaken */
  retake: 20 * TICK_HZ,
  /** no wave this close to the end */
  quiet: 10,
};

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

/** Start the siege: the defender's capital, the far spawns, and the whole wave schedule. */
export function initSiege(w: World, s: SiegeSetup, human: number): void {
  const ev = w.events;
  const capital = w.nests.find((n) => n.capital && n.owner === human);
  if (!ev || !capital) return;
  // Waves come from the far half of the map's swarm spawns.
  const spawns = [...ev.spec.swarmSpawns]
    .map((p) => ({ p, d: (p[0] - capital.x) ** 2 + (p[1] - capital.y) ** 2 }))
    .sort((a, b) => b.d - a.d)
    .slice(0, Math.max(2, Math.ceil(ev.spec.swarmSpawns.length / 2)))
    .map((o) => o.p);
  if (!spawns.length) return;
  w.siege = {
    until: w.tick + Math.round(s.seconds * TICK_HZ),
    waves: rollWaves(new Rng(w.seed ^ 0x5e1e9e), s, spawns, w.tick),
    next: 0,
    human,
    capital: capital.id,
    lostAt: -1,
    spawns,
  };
}

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
  while (sg.next < sg.waves.length && w.tick >= sg.waves[sg.next].at) release(w, sg, sg.waves[sg.next++]);
}

function release(w: World, sg: SiegeState, wave: Wave): void {
  const info = WAVE_KINDS[wave.kind];
  const per = wave.from.length > 1 ? Math.ceil(wave.size / wave.from.length) : wave.size;
  for (const i of wave.from) {
    const [x, y] = sg.spawns[i];
    const sw = releaseSwarm(w, x, y, per, 'bloomSwarm', info.mix);
    sw.hunt = sg.human;
    sw.raid = wave.kind === 'raiders';
    steerSwarm(w, sw);
    pushFx(w, 'siegeWave', x, y, NEUTRAL, 40, -1, sg.next - 1);
  }
  if (wave.kind === 'colossus') {
    // A Colossus walks straight for your capital, and stays there.
    const [x, y] = sg.spawns[wave.from[0]];
    const cap = w.nests[sg.capital];
    const s = spawnUnit(w, NEUTRAL, Kind.Colossus, x, y, cap.x, cap.y, 30);
    if (s >= 0) {
      w.wild[s] = WILD_COLOSSUS;
      w.events!.colossi.push({ uid: w.uid[s], path: [[x, y], [cap.x, cap.y]], leg: 1, maxHp: w.hp[s], stay: true });
      pushFx(w, 'colossusSpawn', x, y, NEUTRAL, 60);
    }
  }
}

/**
 * The siege's say in victory (from checkVictory): the line breaks if the
 * capital stays lost for SIEGE.retake; it holds if the capital is yours at the
 * end. Returns true when the siege decided the check (nothing else may end it).
 */
export function siegeVictory(w: World): boolean {
  const sg = w.siege!;
  const cap = w.nests[sg.capital];
  const human = w.factions[sg.human];
  const held = cap.owner === sg.human;
  if (!held && sg.lostAt < 0) {
    sg.lostAt = w.tick;
    pushFx(w, 'capitalLost', cap.x, cap.y, sg.human, cap.r);
  } else if (held && sg.lostAt >= 0) {
    sg.lostAt = -1;
    pushFx(w, 'capitalRetaken', cap.x, cap.y, sg.human, cap.r);
  }
  if (human.eliminated || (sg.lostAt >= 0 && w.tick - sg.lostAt >= SIEGE.retake)) {
    w.over = true;
    w.winnerTeam = -1;
    w.winReason = 'fallen';
  } else if (w.tick >= sg.until && held) {
    w.over = true;
    w.winnerTeam = w.teamOf[sg.human];
    w.winReason = 'held';
  }
  return true;
}
