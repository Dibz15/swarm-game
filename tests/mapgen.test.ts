import { describe, expect, it } from 'vitest';
import { NEST_RADIUS } from '../src/sim/constants';
import { Terrain } from '../src/sim/terrain';
import { expansionSpread, generateMap, MAP_FORMS, MAP_LAYOUTS, type MapForm, type MapSize } from '../src/sim/mapgen';
import { fbm, ridged, vnoise } from '../src/sim/mathx';

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
    const m = generateMap({ seed: 3, size: 'medium', players: 4, layout: 'open', terrain: 'standard', form: 'classic' });
    expect(m.nests.some((n) => n.x === m.width / 2 && n.y === m.height / 2)).toBe(false);
    expect(m.terrain.crystals.some((c) => c.x === m.width / 2 && c.y === m.height / 2)).toBe(true);
  });
});

describe('map forms (#98)', () => {
  it('every form keeps nests apart, clear of walls, reachable, and fair, at every player count', () => {
    for (const form of MAP_FORMS) {
      for (const size of ['small', 'medium', 'large'] as MapSize[]) {
        for (const players of [2, 3, 5]) {
          for (const alt of [0, 1, 2]) {
            const m = generateMap({ seed: 70 + players + alt * 131, size, players, form, terrain: 'standard' });
            expect(m.form).toBe(form);
            const t = new Terrain(m.terrain, m.width, m.height);
            expect(t.connected(m.nests.map((n) => [n.x, n.y])), `${form} ${size} ${players}p alt ${alt}`).toBe(true);
            for (const n of m.nests) {
              expect(t.clearance(n.x, n.y)).toBeGreaterThan(NEST_RADIUS[n.type]);
              for (const o of m.nests) if (o !== n) expect((n.x - o.x) ** 2 + (n.y - o.y) ** 2).toBeGreaterThan(60 * 60);
            }
            expect(m.nests.length % players).toBeLessThanOrEqual(1);
            if (players > 2) expect(expansionSpread(m.nests, players)).toBeLessThan(1.35);
          }
        }
      }
    }
  });

  it('the seed picks a form that suits the map: open forms on open ground, cave forms in full caves', () => {
    const seen = (caves: 'off' | 'full') => {
      const out = new Set<MapForm>();
      for (let s = 0; s < 120; s++) out.add(generateMap({ seed: s, size: 'medium', players: 2, terrain: 'standard', caves }).form!);
      return [...out].sort();
    };
    expect(seen('off')).toEqual(['classic', 'river', 'ring', 'spiral'].sort());
    expect(seen('full')).toEqual(['caves', 'islands', 'regions', 'warrens'].sort());
    // No terrain at all: nothing to build a ring or river from.
    for (let s = 0; s < 40; s++) expect(['classic', 'spiral']).toContain(generateMap({ seed: s, size: 'medium', players: 2 }).form);
  });

  it('regions come in every topology', () => {
    const tops = new Set<string>();
    for (let s = 0; s < 60; s++) tops.add(generateMap({ seed: s, size: 'medium', players: 3, form: 'regions' }).topology!);
    expect([...tops].sort()).toEqual(['chain', 'hub', 'ring', 'tree']);
  });

  it('a ring keeps its middle empty', () => {
    for (let s = 0; s < 20; s++) {
      const m = generateMap({ seed: s, size: 'medium', players: 3, form: 'ring', terrain: 'standard' });
      const t = new Terrain(m.terrain, m.width, m.height);
      expect(t.clearance(m.width / 2, m.height / 2) < 0 || m.terrain.fields.some((f) => f.x1 === m.width / 2 && f.y1 === m.height / 2)).toBe(true);
    }
  });
});

describe('noise terrain (#98)', () => {
  it('noise is deterministic and in range', () => {
    // Pinned values: the noise must never drift between builds or browsers.
    expect(vnoise(1.25, 3.5, 7)).toBe(vnoise(1.25, 3.5, 7));
    expect(vnoise(0, 0, 1)).toMatchInlineSnapshot(`0.5421679092105478`);
    for (let k = 0; k < 200; k++) {
      const x = k * 0.37, y = k * 0.91;
      for (const v of [vnoise(x, y, 3), fbm(x, y, 3), ridged(x, y, 3)]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('noise fill works with every open form: connected, nests clear, every sector alike', () => {
    for (const form of ['classic', 'ring', 'river', 'spiral'] as const) {
      for (const players of [2, 3, 5]) {
        for (const alt of [0, 1]) {
          const m = generateMap({ seed: 11 + players + alt * 53, size: 'medium', players, form, fill: 'noise', terrain: 'standard' });
          expect(m.fill).toBe('noise');
          const t = new Terrain(m.terrain, m.width, m.height);
          expect(t.connected(m.nests.map((n) => [n.x, n.y])), `${form} ${players}p`).toBe(true);
          for (const n of m.nests) expect(t.clearance(n.x, n.y)).toBeGreaterThan(NEST_RADIUS[n.type]);
          expect(m.terrain.cave!.zone!.length % players).toBe(0);
        }
      }
    }
  });

  it('the seed mixes fills: some open maps get noise, walled ones only', () => {
    const fills = new Set<string>();
    for (let s = 0; s < 60; s++) fills.add(generateMap({ seed: s, size: 'medium', players: 2, terrain: 'standard' }).fill ?? 'none');
    expect(fills.has('noise') && fills.has('sprinkle')).toBe(true);
    for (let s = 0; s < 30; s++) expect(generateMap({ seed: s, size: 'medium', players: 2, terrain: { walls: 0, nebula: 1, rifts: 1, crystals: 1 } }).fill).not.toBe('noise');
  });

  it('wild swarms, drops and the Colossus can always reach every start, however the rock falls', () => {
    for (const [form, fill] of [['warrens', undefined], ['classic', 'noise'], ['ring', 'noise'], ['islands', undefined]] as const) {
      for (let s = 0; s < 6; s++) {
        const m = generateMap({ seed: 300 + s, size: s % 2 ? 'large' : 'small', players: 3, form, fill, terrain: 'standard', events: 'normal' });
        const t = new Terrain(m.terrain, m.width, m.height);
        const points = [...m.events.swarmSpawns, ...m.events.dropSpots, ...m.events.colossusPaths.flat()];
        for (const cap of m.nests.slice(0, 3)) for (const [x, y] of points) expect(Number.isFinite(t.pathDist(x, y, cap.x, cap.y, 0)), `${form} ${s}`).toBe(true);
      }
    }
  });

  it('generates quickly, even the heaviest forms', () => {
    const t0 = performance.now();
    for (const form of ['warrens', 'regions'] as const) for (let s = 0; s < 4; s++) generateMap({ seed: s, size: 'large', players: 4, form, terrain: 'standard' });
    for (let s = 0; s < 4; s++) generateMap({ seed: s, size: 'large', players: 4, form: 'ring', fill: 'noise', terrain: 'standard' });
    expect((performance.now() - t0) / 12).toBeLessThan(400);
  });
});

