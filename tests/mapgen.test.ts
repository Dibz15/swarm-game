import { describe, expect, it } from 'vitest';
import { NEST_RADIUS } from '../src/sim/constants';
import { Terrain } from '../src/sim/terrain';
import { expansionSpread, generateMap, MAP_LAYOUTS, type MapSize } from '../src/sim/mapgen';

describe('map layouts (#38)', () => {
  it('every layout keeps nests apart, on the map, and reachable, with terrain and caves', () => {
    for (const layout of MAP_LAYOUTS) {
      for (const size of ['small', 'medium', 'large'] as MapSize[]) {
        for (const players of [2, 3, 5]) {
          for (const alt of [0, 1]) {
            for (const caves of ['off', 'full'] as const) {
              const m = generateMap({ seed: 40 + players + alt * 97, size, players, layout, caves, terrain: 'heavy' });
              expect(m.layout).toBe(layout);
              for (const n of m.nests) {
                expect(n.x).toBeGreaterThan(NEST_RADIUS[n.type]);
                expect(n.x).toBeLessThan(m.width - NEST_RADIUS[n.type]);
                expect(n.y).toBeGreaterThan(NEST_RADIUS[n.type]);
                expect(n.y).toBeLessThan(m.height - NEST_RADIUS[n.type]);
                for (const o of m.nests) if (o !== n) expect((n.x - o.x) ** 2 + (n.y - o.y) ** 2).toBeGreaterThan(60 * 60);
              }
              const t = new Terrain(m.terrain, m.width, m.height);
              expect(t.connected(m.nests.map((n) => [n.x, n.y]))).toBe(true);
              // Every sector gets the same nests, plus at most one in the middle.
              expect(m.nests.length % players).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it('is deterministic per seed', () => {
    for (let s = 0; s < 10; s++) {
      expect(generateMap({ seed: s, size: 'medium', players: 4, terrain: 'standard' })).toEqual(
        generateMap({ seed: s, size: 'medium', players: 4, terrain: 'standard' }),
      );
    }
  });

  it('random seeds give every layout and varied nest counts and starts', () => {
    const layouts = new Set<string>(), counts = new Set<number>(), starts = new Set<number>();
    for (let s = 0; s < 60; s++) {
      const m = generateMap({ seed: s, size: 'medium', players: 4 });
      layouts.add(m.layout!);
      counts.add(m.nests.length);
      starts.add(Math.round(Math.sqrt((m.nests[0].x - m.width / 2) ** 2 + (m.nests[0].y - m.height / 2) ** 2) / 20));
    }
    expect(layouts.size).toBe(MAP_LAYOUTS.length);
    expect(counts.size).toBeGreaterThanOrEqual(4);
    expect(starts.size).toBeGreaterThanOrEqual(4);
  });

  it('the seed picks the shape and density (#98): every aspect comes up, density spans its range', () => {
    for (const [players, want] of [[2, [1, 1.3, 1.6, 2]], [4, [1, 1.3, 1.6]], [6, [1, 1.3]]] as [number, number[]][]) {
      const aspects = new Set<number>(), dens: number[] = [];
      for (let s = 0; s < 60; s++) {
        const m = generateMap({ seed: s, size: 'medium', players });
        // Always laid out wide: the camera turns it to the screen.
        expect(m.width).toBeGreaterThanOrEqual(m.height);
        aspects.add(Math.round(m.aspect! * 10) / 10);
        dens.push(m.density!);
      }
      expect([...aspects].sort()).toEqual(want);
      expect(Math.min(...dens)).toBeLessThan(0.15);
      expect(Math.max(...dens)).toBeGreaterThan(0.85);
    }
  });

  it('sparse maps are bigger with fewer nests than packed ones', () => {
    const maps = Array.from({ length: 80 }, (_, s) => generateMap({ seed: s, size: 'medium', players: 4 }));
    const sparse = maps.filter((m) => m.density! < 0.25), packed = maps.filter((m) => m.density! > 0.75);
    const mean = (ms: typeof maps, f: (m: (typeof maps)[0]) => number) => ms.reduce((t, m) => t + f(m), 0) / ms.length;
    expect(mean(sparse, (m) => m.width * m.height)).toBeGreaterThan(mean(packed, (m) => m.width * m.height) * 1.3);
    expect(mean(sparse, (m) => m.nests.length)).toBeLessThan(mean(packed, (m) => m.nests.length));
  });

  it('1v1 maps are never sparser than the old fixed count', () => {
    const floor: Record<MapSize, number> = { small: 9, medium: 11, large: 13 };
    for (const size of ['small', 'medium', 'large'] as MapSize[]) {
      for (let s = 0; s < 60; s++) expect(generateMap({ seed: s, size, players: 2 }).nests.length).toBeGreaterThanOrEqual(floor[size]);
    }
  });

  it('keeps starts fair: nearest expansions are about as close for everyone', () => {
    for (const players of [3, 4, 6]) {
      for (let s = 0; s < 30; s++) {
        const m = generateMap({ seed: 700 + s, size: players === 6 ? 'large' : 'medium', players });
        expect(expansionSpread(m.nests, players)).toBeLessThan(1.35);
      }
    }
  });

  it('open-center maps put a crystal in the middle when the map has crystals', () => {
    const m = generateMap({ seed: 3, size: 'medium', players: 4, layout: 'open', terrain: 'standard' });
    expect(m.nests.some((n) => n.x === m.width / 2 && n.y === m.height / 2)).toBe(false);
    expect(m.terrain.crystals.some((c) => c.x === m.width / 2 && c.y === m.height / 2)).toBe(true);
  });
});
