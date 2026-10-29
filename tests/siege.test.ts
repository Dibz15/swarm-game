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
    expect(sg.capital).toBe(w.nests.find((n) => n.capital && n.owner === 0)!.id);
    const first = sg.waves[0];
    run(w, first.at + 2);
    const sw = w.events!.swarms.find((s) => s.hunt === 0)!;
    expect(sw).toBeDefined();
    expect([sw.tx, sw.ty]).toEqual([w.nests[sg.capital].x, w.nests[sg.capital].y]);
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
      const cap = w.nests[w.siege!.capital];
      cap.owner = -1;
      cap.controller = NEUTRAL;
      cap.control = 0;
    };
    const w = createWorld(siege(4, { ...SIEGE_SETUP, first: 1000 }));
    fall(w);
    run(w, SIEGE.retake - TICK_HZ);
    expect(w.over).toBe(false);
    const cap = w.nests[w.siege!.capital];
    cap.owner = cap.controller = 0;
    cap.control = 1;
    run(w, 2 * TICK_HZ);
    expect(w.siege!.lostAt).toBe(-1);
    // This time nobody's left to take it back.
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 0) w.dmg[i] = 1e9;
    resolveDamage(w);
    fall(w);
    run(w, SIEGE.retake + TICK_HZ);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('fallen');
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
        const s = nodeSetup(r, n.id, false);
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
      const w = createWorld(nodeSetup(r, node.id, false, r.broods.map((b) => b.id)));
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
