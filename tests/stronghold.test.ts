import { describe, expect, it } from 'vitest';
import { nodeSetup } from '../src/campaign/battle';
import { newRun, type RunState } from '../src/campaign/run';
import { MAX_LEVEL, TICK_HZ } from '../src/sim/constants';
import { resolveDamage } from '../src/sim/combat';
import { worldHash } from '../src/sim/hash';
import { generateMap, type MapSize } from '../src/sim/mapgen';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Terrain } from '../src/sim/terrain';
import { Proxy } from '../src/proxy/proxy';

const SIZES: MapSize[] = ['small', 'medium', 'large'];

describe('a fortified map', () => {
  it('walls the warlord in: a max-level citadel, two inner works, and gates every capital can walk through', () => {
    for (const size of SIZES)
      for (let seed = 0; seed < 8; seed++) {
        const base = generateMap({ seed, size, players: 3, terrain: 'standard' });
        const m = generateMap({ seed, size, players: 3, terrain: 'standard', stronghold: 1 });
        const citadel = m.nests.find((n) => n.player === 1 && n.capital !== false)!;
        expect(citadel.level).toBe(MAX_LEVEL);
        expect(m.nests.filter((n) => n.player === 1 && n.capital === false)).toHaveLength(2);
        expect(m.terrain.walls.length).toBeGreaterThan(0);
        const t = new Terrain(m.terrain, m.width, m.height);
        for (const c of m.nests.filter((n) => n.player >= 0 && n.player !== 1 && n.capital !== false)) {
          expect(Number.isFinite(t.pathDist(c.x, c.y, citadel.x, citadel.y, 0))).toBe(true);
        }
        // The rest of the map is the map it would have been.
        for (const n of m.nests) {
          if (n.player === 1) continue;
          expect(base.nests.some((b) => b.x === n.x && b.y === n.y && b.type === n.type)).toBe(true);
        }
      }
  });

  it('is seeded', () => {
    const p = { seed: 4, size: 'medium' as const, players: 3, terrain: 'standard' as const, stronghold: 1 };
    expect(generateMap(p)).toEqual(generateMap(p));
  });
});

/** Human (0), the warlord (1) and a plain rival (2) on a stronghold map. */
function holdSetup(seed = 3): MatchSetup {
  return {
    seed,
    size: 'medium',
    terrain: 'standard',
    stronghold: { player: 1 },
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'turtler', citadel: true } },
      { faction: 2, team: 2, human: false, bot: { difficulty: 1, personality: 'expander' } },
    ],
  };
}

describe('the citadel', () => {
  it('wins the battle for a human who takes it, with rivals still standing', () => {
    const w = createWorld(holdSetup());
    expect(w.citadel).toBeGreaterThanOrEqual(0);
    expect(w.nests[w.citadel].owner).toBe(1);
    // Its guards gone, the citadel changes hands.
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 1) w.dmg[i] = 1e9;
    resolveDamage(w);
    w.nests[w.citadel].owner = 0;
    w.nests[w.citadel].control = 1;
    for (let t = 0; t < TICK_HZ && !w.over; t++) step(w, []);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('citadel');
    expect(w.winnerTeam).toBe(w.teamOf[0]);
  });

  it('a rival taking it wins nothing', () => {
    const w = createWorld(holdSetup());
    w.nests[w.citadel].owner = 2;
    w.nests[w.citadel].control = 1;
    for (let t = 0; t < TICK_HZ; t++) step(w, []);
    expect(w.over).toBe(false);
  });

  it('replays identically', () => {
    const play = () => {
      const w = createWorld(holdSetup(7));
      for (let t = 0; t < 90 * TICK_HZ && !w.over; t++) {
        step(w, []);
        w.fx = [];
        w.deaths = [];
      }
      return worldHash(w);
    };
    expect(play()).toBe(play());
  });
});

describe('stronghold nodes', () => {
  /** A run and one of its standing strongholds. */
  const hold = (k: number): [RunState, number] => {
    const run = newRun(`hold-${k}`, 0, 'swarm', 0);
    return [run, run.warlords![0].stronghold];
  };

  it('are fortresses with the warlord guarding its citadel; other domain nodes are not', () => {
    const [run, id] = hold(1);
    const s = nodeSetup(run, id, false);
    expect(s.stronghold).toEqual({ player: 1 });
    expect(s.caves).toBe('off');
    expect(s.players[1].bot!.citadel).toBe(true);
    for (const other of run.warlords![0].nodes.slice(1)) {
      const o = nodeSetup(run, other, false);
      expect(o.stronghold).toBeUndefined();
      expect(o.players[1].bot!.citadel).toBeUndefined();
    }
  });

  // A sanity check, not tuning (#68): the human proxy can take a Normal
  // stronghold's citadel on some seed. Stops at the first win.
  it('can be taken', () => {
    const win = [0, 1, 2, 3, 4, 5].find((k) => {
      const [run, id] = hold(k);
      run.nodes[id].difficulty = 1;
      for (const b of run.broods) b.size = 16;
      const w = createWorld(nodeSetup(run, id, false, run.broods.map((b) => b.id)));
      const proxy = new Proxy(run.color, { skill: 1 });
      while (!w.over && w.tick < 12 * 60 * TICK_HZ) {
        step(w, proxy.think(w));
        w.fx = [];
        w.deaths = [];
      }
      return w.over && w.winnerTeam === w.teamOf[run.color];
    });
    expect(win).toBeDefined();
  }, 240_000);
});
