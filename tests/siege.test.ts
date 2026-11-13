import { describe, expect, it } from 'vitest';
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { resolveDamage } from '../src/sim/combat';
import { Kind, NEUTRAL, TICK_HZ } from '../src/sim/constants';
import { FORTRESS_STYLES } from '../src/sim/fortify';
import { worldHash } from '../src/sim/hash';
import { generateMap } from '../src/sim/mapgen';
import { Rng } from '../src/sim/rng';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { SIEGE, WAVE_KINDS, rollWaves, waveSize, type SiegeSetup } from '../src/sim/siege';
import { step } from '../src/sim/step';
import { Terrain } from '../src/sim/terrain';
import { Proxy } from '../src/proxy/proxy';
import { spawnUnit, WILD_SWARM, type World } from '../src/sim/world';
import { bloomNestMask, growthTarget } from '../src/render/bloom';

const SIEGE_SETUP: SiegeSetup = { seconds: 200, first: 20, every: 30, size: 20, grow: 1.12, depth: 1 };

/** You (0) holding the line against the waves and one rival (1). */
function siege(seed = 4, s: SiegeSetup = SIEGE_SETUP): MatchSetup {
  return {
    seed,
    size: 'medium',
    terrain: 'standard',
    events: 'calm',
    siege: s,
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'rusher' } },
    ],
  };
}

const run = (w: ReturnType<typeof createWorld>, ticks: number) => {
  for (let t = 0; t < ticks && !w.over; t++) {
    step(w, []);
    w.fx = [];
    w.deaths = [];
  }
};

describe('the wave schedule', () => {
  const spawns: [number, number][] = [[0, 0], [1000, 0], [500, 900]];

  it('is seeded, opens with a plain swarm, never repeats a kind and grows', () => {
    const a = rollWaves(new Rng(3), SIEGE_SETUP, spawns);
    expect(rollWaves(new Rng(3), SIEGE_SETUP, spawns)).toEqual(a);
    expect(a[0].kind).toBe('swarm');
    for (let k = 1; k < a.length; k++) {
      expect(a[k].kind).not.toBe(a[k - 1].kind);
      expect(a[k].at).toBeGreaterThan(a[k - 1].at);
    }
    // No wave in the last quiet seconds.
    expect(a[a.length - 1].at).toBeLessThan((SIEGE_SETUP.seconds - SIEGE.quiet) * TICK_HZ);
  });

  it('brings more kinds later in a run; a pincer comes from two sides', () => {
    const kinds = (depth: number) => new Set(Array.from({ length: 20 }, (_, k) => rollWaves(new Rng(k), { ...SIEGE_SETUP, depth }, spawns).map((w) => w.kind)).flat());
    const early = kinds(0), late = kinds(1);
    for (const k of early) expect(WAVE_KINDS[k].from).toBe(0);
    expect(late.has('pincer')).toBe(true);
    expect(late.has('colossus')).toBe(true);
    const pincer = Array.from({ length: 20 }, (_, k) => rollWaves(new Rng(k), SIEGE_SETUP, spawns)).flat().find((w) => w.kind === 'pincer')!;
    expect(new Set(pincer.from).size).toBe(2);
  });
});

describe('holding the line', () => {
  it('walls you in and sends waves of the right kind after your capital', () => {
    const w = createWorld(siege());
    const sg = w.siege!;
    expect(sg.defenders[0].capital).toBe(w.nests.find((n) => n.capital && n.owner === 0)!.id);
    const first = sg.waves[0];
    run(w, first.at + 2);
    const sw = w.events!.swarms.find((s) => s.hunt === 0)!;
    expect(sw).toBeDefined();
    expect([sw.tx, sw.ty]).toEqual([w.nests[sg.defenders[0].capital].x, w.nests[sg.defenders[0].capital].y]);
    const kinds = sw.uids.map((u) => w.kind[w.uidToSlot.get(u)!]);
    expect(kinds.filter((k) => k === Kind.Dot).length).toBeGreaterThan(kinds.filter((k) => k === Kind.Swift).length);
  });

  it('holds when the clock runs out with the capital yours, and wiping out the rival does not end it early', () => {
    const w = createWorld(siege(4, { ...SIEGE_SETUP, seconds: 30, first: 100 }));
    w.factions[1].eliminated = true;
    run(w, 10 * TICK_HZ);
    expect(w.over).toBe(false);
    run(w, 25 * TICK_HZ);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('held');
    expect(w.winnerTeam).toBe(w.teamOf[0]);
  });

  it('a fallen capital can be retaken within 20 s; left fallen, the line breaks', () => {
    const fall = (w: ReturnType<typeof createWorld>) => {
      const cap = w.nests[w.siege!.defenders[0].capital];
      cap.owner = -1;
      cap.controller = NEUTRAL;
      cap.control = 0;
    };
    const w = createWorld(siege(4, { ...SIEGE_SETUP, first: 1000 }));
    fall(w);
    run(w, SIEGE.retake - TICK_HZ);
    expect(w.over).toBe(false);
    const cap = w.nests[w.siege!.defenders[0].capital];
    cap.owner = cap.controller = 0;
    cap.control = 1;
    run(w, 2 * TICK_HZ);
    expect(w.siege!.defenders[0].lostAt).toBe(-1);
    // This time nobody's left to take it back.
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 0) w.dmg[i] = 1e9;
    resolveDamage(w);
    fall(w);
    run(w, SIEGE.retake + TICK_HZ);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('fallen');
  });

  it('waves emerge from a Bloom nest still standing; with none left, from the map edge', () => {
    const w = createWorld(siege(4, { ...SIEGE_SETUP, first: 2, every: 40 }));
    const sg = w.siege!;
    const fx: { x: number; y: number }[] = [];
    for (let t = 0; t < sg.waves[0].at + 2; t++) {
      step(w, []);
      for (const e of w.fx) if (e.type === 'siegeWave') fx.push({ x: e.x, y: e.y });
      w.fx = [];
    }
    expect(sg.bloomNests.some((id) => w.nests[id].x === fx[0].x && w.nests[id].y === fx[0].y)).toBe(true);
    for (const id of sg.bloomNests) w.nests[id].owner = 0;
    // Clear the first wave, so it can't take the capital before the next one comes.
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] !== 0) w.dmg[i] = 1e9;
    resolveDamage(w);
    fx.length = 0;
    for (let t = 0; t < 41 * TICK_HZ && !fx.length; t++) {
      step(w, []);
      for (const e of w.fx) if (e.type === 'siegeWave') fx.push({ x: e.x, y: e.y });
      w.fx = [];
    }
    expect(sg.spawns.some(([x, y]) => x === fx[0].x && y === fx[0].y)).toBe(true);
  });

  it('every field nest the Bloom holds makes the waves bigger', () => {
    const w = createWorld(siege());
    const sg = w.siege!;
    expect(sg.bloomNests.length).toBeGreaterThan(3);
    const wave = sg.waves[0];
    const full = waveSize(w, wave);
    expect(full).toBe(Math.round(wave.size * (1 + SIEGE.perNest * sg.bloomNests.length)));
    for (const id of sg.bloomNests) w.nests[id].owner = 0;
    expect(waveSize(w, wave)).toBe(wave.size);
  });

  it('offers a boon every other wave; the first is taken if you do not choose, or the one you pick', () => {
    const w = createWorld(siege(4, { ...SIEGE_SETUP, first: 5, every: 15, size: 6 }));
    const sg = w.siege!;
    run(w, sg.waves[1].at - w.tick + SIEGE.boonDelay + 1);
    expect(sg.offer?.ids).toHaveLength(3);
    const first = sg.offer!.ids[0];
    run(w, SIEGE.boonOpen + 1);
    expect(sg.boons).toEqual([first]);
    expect(sg.offer).toBeNull();
    // The next offer: pick the third.
    run(w, sg.waves[3].at - w.tick + SIEGE.boonDelay + 1);
    const third = sg.offer!.ids[2];
    const prod = w.factions[0].prodMult;
    step(w, [{ t: 'boon', p: 0, k: 2 }]);
    expect(sg.boons[1]).toBe(third);
    if (third === 'production') expect(w.factions[0].prodMult).toBeCloseTo(prod * 1.2);
  });

  it('replays identically', () => {
    const play = () => {
      const w = createWorld(siege(9));
      run(w, 120 * TICK_HZ);
      return worldHash(w);
    };
    expect(play()).toBe(play());
  });
});

describe('fortress styles', () => {
  it('come in every style, and every capital and wave spawn can walk in', () => {
    const seen = new Set<string>();
    for (const size of ['small', 'medium', 'large'] as const)
      for (let seed = 0; seed < 14; seed++) {
        const m = generateMap({ seed, size, players: 3, terrain: 'standard', events: 'calm', fortress: 1 });
        expect(m.fortress).toBeDefined();
        seen.add(m.fortress!.style);
        const cap = m.nests.find((n) => n.player === 1 && n.capital !== false)!;
        const t = new Terrain(m.terrain, m.width, m.height);
        const from = [...m.nests.filter((n) => n.player >= 0 && n !== cap && n.capital !== false).map((n) => [n.x, n.y]), ...m.events.swarmSpawns];
        for (const [x, y] of from) expect(Number.isFinite(t.pathDist(x, y, cap.x, cap.y, 0))).toBe(true);
      }
    for (const s of FORTRESS_STYLES) expect(seen.has(s)).toBe(true);
  });
});

describe('Hold the line in runs', () => {
  it('appears in runs, never in a domain, the checkpoint or the finale', () => {
    let holds = 0;
    for (let k = 0; k < 20; k++) {
      const r = newRun(`holds-${k}`, 0, 'swarm', 0);
      for (const n of r.nodes.filter((o) => o.kind === 'hold')) {
        holds++;
        expect(n.domain).toBeUndefined();
        expect(n.checkpoint).toBeFalsy();
        expect(n.depth).toBeGreaterThanOrEqual(2);
        const s = nodeSetup(r, n.id);
        expect(s.siege).toBeDefined();
        // Just you and the Bloom.
        expect(s.players).toHaveLength(1);
      }
    }
    expect(holds).toBeGreaterThan(10);
  });

  // #67's done-when, as a sanity check (not tuning, #68): the human proxy can
  // hold the line, and doing nothing loses it.
  it('can be held, and lost', () => {
    const outcomes: string[] = [];
    for (let k = 0; k < 8 && !(outcomes.includes('held') && outcomes.includes('fallen')); k++) {
      const r = newRun(`siege-probe-${k}`, 0, 'swarm', 0);
      const node = r.nodes.find((n) => n.kind === 'hold');
      if (!node) continue;
      for (const b of r.broods) b.size = b.cap = 14;
      const w = createWorld(nodeSetup(r, node.id, r.broods.map((b) => b.id)));
      // Odd seeds: nobody gives an order.
      const proxy = k % 2 ? null : new Proxy(r.color, { skill: 1 });
      while (!w.over && w.tick < 6 * 60 * TICK_HZ) {
        step(w, proxy ? proxy.think(w) : []);
        w.fx = [];
        w.deaths = [];
      }
      outcomes.push(w.winReason);
    }
    expect(outcomes).toContain('held');
    expect(outcomes).toContain('fallen');
  }, 240_000);
});

describe('the Bloom look (#94)', () => {
  it('tags a wild death so it can burst into spores, and nobody else\'s', () => {
    const w = createWorld(siege());
    w.deaths = [];
    const mine = spawnUnit(w, 0, Kind.Dot, 300, 300, 300, 300, 10);
    const wild = spawnUnit(w, NEUTRAL, Kind.Dot, 400, 400, 400, 400, 10);
    w.wild[wild] = WILD_SWARM;
    w.dmg[mine] = w.dmg[wild] = 1e6;
    resolveDamage(w);
    expect(w.deaths.length).toBe(8);
    const flag = (x: number) => w.deaths[w.deaths.findIndex((v, k) => k % 4 === 0 && v === x) + 3];
    expect(flag(300)).toBe(0);
    expect(flag(400)).toBe(1);
  });

  it('grows the siege\'s field nests while the Bloom holds them, and withers them when taken', () => {
    const w = createWorld(siege());
    const mask = bloomNestMask(w);
    const id = w.siege!.bloomNests[0];
    expect(mask[id]).toBe(1);
    expect(growthTarget(w, id, mask)).toBe(1);
    w.nests[id].owner = 0;
    expect(growthTarget(w, id, mask)).toBe(0);
    const other = w.nests.findIndex((n) => !mask[n.id]);
    expect(growthTarget(w, other, mask)).toBe(0);
  });
});

describe('co-op Hold the line (#228)', () => {
  /** `n` humans holding the line together, on one team. */
  function coop(n: number, seed = 4, s: SiegeSetup = SIEGE_SETUP, size: MatchSetup['size'] = 'medium'): MatchSetup {
    return { seed, size, terrain: 'standard', events: 'calm', siege: s, players: Array.from({ length: n }, (_, f) => ({ faction: f, team: 0, human: true })) };
  }
  const fall = (w: World, f: number) => {
    const cap = w.nests[w.siege!.defenders.find((d) => d.f === f)!.capital];
    cap.owner = -1;
    cap.controller = NEUTRAL;
    cap.control = 0;
  };
  const wipe = (w: World, f: number) => {
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === f) w.dmg[i] = 1e9;
    resolveDamage(w);
  };
  /** wall capsules with an end within `r` of (x, y) */
  const wallsNear = (walls: { x1: number; y1: number; x2: number; y2: number }[], x: number, y: number, r: number) =>
    walls.filter((c) => Math.min((c.x1 - x) ** 2 + (c.y1 - y) ** 2, (c.x2 - x) ** 2 + (c.y2 - y) ** 2) < r * r).length;

  it('defenders share a team; a siege across teams is refused', () => {
    expect(() => createWorld(coop(2))).not.toThrow();
    const split = coop(2);
    split.players[1].team = 1;
    expect(() => createWorld(split)).toThrow(/siege/);
  });

  it('walls in every defender, and every spawn and capital can walk to each', () => {
    for (const size of ['small', 'medium', 'large'] as const)
      for (const n of [2, 3, 4])
        for (let seed = 0; seed < 6; seed++) {
          const open = generateMap({ seed, size, players: n, terrain: 'standard', events: 'calm' });
          const m = generateMap({ seed, size, players: n, terrain: 'standard', events: 'calm', fortress: Array.from({ length: n }, (_, i) => i) });
          const t = new Terrain(m.terrain, m.width, m.height);
          const caps = m.nests.filter((x) => x.player >= 0 && x.capital !== false);
          expect(caps).toHaveLength(n);
          for (const cap of caps) {
            const before = open.nests.find((x) => x.player === cap.player && x.capital !== false)!;
            expect(wallsNear(m.terrain.walls, cap.x, cap.y, 280), `${size} ${n} seed ${seed} player ${cap.player}`).toBeGreaterThan(wallsNear(open.terrain.walls, before.x, before.y, 280));
            for (const [x, y] of [...caps.filter((c) => c !== cap).map((c) => [c.x, c.y]), ...m.events.swarmSpawns]) expect(Number.isFinite(t.pathDist(x, y, cap.x, cap.y, 0))).toBe(true);
          }
        }
  });

  it('waves grow and quicken with each defender', () => {
    for (const n of [2, 4]) {
      const w = createWorld(coop(n));
      const sg = w.siege!;
      expect(sg.defenders.map((d) => d.f)).toEqual(Array.from({ length: n }, (_, f) => f));
      const k = n - 1;
      expect(sg.waves[0].size).toBe(Math.round(SIEGE_SETUP.size * (1 + SIEGE.coopSize * k)));
      const gap = (sg.waves[1].at - sg.waves[0].at) / TICK_HZ;
      expect(gap).toBeCloseTo(SIEGE_SETUP.every / (1 + SIEGE.coopPace * k), 0);
      expect(sg.waves.length).toBeGreaterThan(createWorld(siege()).siege!.waves.length);
    }
  });

  it('a wave hunts the nearest defender', () => {
    const w = createWorld(coop(3));
    const sg = w.siege!;
    run(w, sg.waves[0].at + 2);
    const sw = w.events!.swarms.find((s) => s.hunt === 0)!;
    expect(sw).toBeDefined();
    let cx = 0, cy = 0;
    for (const u of sw.uids) (cx += w.x[w.uidToSlot.get(u)!]), (cy += w.y[w.uidToSlot.get(u)!]);
    cx /= sw.uids.length;
    cy /= sw.uids.length;
    const near = [...sg.defenders].map((d) => w.nests[d.capital]).sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2))[0];
    expect([sw.tx, sw.ty]).toEqual([near.x, near.y]);
  });

  // a short siege with no waves: only the clock and the capitals decide it
  const QUIET: SiegeSetup = { ...SIEGE_SETUP, seconds: 40, first: 1000 };

  it('holds when every capital is held at the clock', () => {
    const w = createWorld(coop(2, 4, QUIET));
    run(w, 41 * TICK_HZ);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('held');
    expect(w.winnerTeam).toBe(0);
  });

  it('breaks when one capital is still fallen at the clock', () => {
    const w = createWorld(coop(2, 4, QUIET));
    run(w, 30 * TICK_HZ);
    wipe(w, 1);
    fall(w, 1);
    run(w, 5 * TICK_HZ);
    expect(w.over).toBe(false);
    expect(w.siege!.defenders[1].lostAt).toBeGreaterThan(0);
    run(w, 10 * TICK_HZ);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('fallen');
    expect(w.winnerTeam).toBe(-1);
  });

  it('an ally can retake a fallen capital; one gone for good is not the end while another stands', () => {
    const w = createWorld(coop(2, 4, { ...SIEGE_SETUP, seconds: 300, first: 1000 }));
    wipe(w, 1);
    fall(w, 1);
    run(w, SIEGE.retake + TICK_HZ);
    expect(w.over).toBe(false);
    // the ally takes it back
    const cap = w.nests[w.siege!.defenders[1].capital];
    cap.owner = cap.controller = 0;
    cap.control = 1;
    run(w, TICK_HZ);
    expect(w.siege!.defenders[1].lostAt).toBe(-1);
    // both fall, and stay fallen: the line breaks
    wipe(w, 0);
    fall(w, 0);
    fall(w, 1);
    run(w, SIEGE.retake + TICK_HZ);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('fallen');
  });

  it('drops a boon outside each defender\'s walls; whoever captures one gets it', () => {
    const w = createWorld(coop(2, 4, { ...SIEGE_SETUP, first: 5, every: 15, size: 6 }));
    const sg = w.siege!;
    expect(sg.defenders.every((d) => d.drop)).toBe(true);
    run(w, sg.waves[1].at - w.tick + SIEGE.boonDelay + 1);
    expect(sg.offer).toBeNull();
    expect(sg.drops).toHaveLength(2);
    const d = sg.drops.find((x) => x.x === sg.defenders[1].drop![0])!;
    // defender 1 sends units onto its drop
    for (let k = 0; k < 15; k++) spawnUnit(w, 1, Kind.Dot, d.x + (k % 5) * 4 - 8, d.y + Math.floor(k / 5) * 4 - 4, d.x, d.y, 10);
    const energy = w.factions[1].energy;
    const prod = w.factions[1].prodMult;
    const levels = w.nests.filter((n) => n.owner === 1).reduce((a, n) => a + n.level, 0);
    run(w, SIEGE.dropTelegraph + 8 * TICK_HZ);
    expect(sg.drops.includes(d)).toBe(false);
    expect(sg.boons).toContain(d.id);
    const changed = w.factions[1].energy !== energy || w.factions[1].prodMult !== prod || w.nests.filter((n) => n.owner === 1).reduce((a, n) => a + n.level, 0) !== levels || w.unitCount[1] > 15;
    expect(changed).toBe(true);
    // the solo boon command does nothing in co-op
    step(w, [{ t: 'boon', p: 0, k: 0 }]);
    expect(sg.offer).toBeNull();
  });

  it('replays identically, with proxies defending', () => {
    const play = () => {
      const w = createWorld(coop(3, 11));
      const ps = [0, 1, 2].map((f) => new Proxy(f, { skill: 1 }));
      while (w.tick < 150 * TICK_HZ && !w.over) {
        step(w, ps.flatMap((p) => p.think(w)));
        w.fx = [];
        w.deaths = [];
      }
      return worldHash(w);
    };
    expect(play()).toBe(play());
  });
});
