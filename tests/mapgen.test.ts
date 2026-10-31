import { describe, expect, it } from 'vitest';
import { NEST_RADIUS } from '../src/sim/constants';
import { Terrain, capsuleDist, segDist2, type FieldSpec } from '../src/sim/terrain';
import { expansionSpread, generateMap, groundHeight, MAP_FORMS, MAP_LAYOUTS, type MapForm, type MapSize, type MapSpec } from '../src/sim/mapgen';
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
    expect(seen('off')).toEqual(['classic', 'islands', 'river', 'ring', 'spiral'].sort());
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
      for (const v of [vnoise(x, y, 3), fbm(x, y, 3)]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
      expect(ridged(x, y, 3)).toBeGreaterThanOrEqual(0);
      expect(ridged(x, y, 3)).toBeLessThanOrEqual(1);
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
          // The rock grows the same in every sector (the fill for cut-off ground is per tile).
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

  it('leaves no open ground cut off by the rock, on every shape', () => {
    for (const [form, fill] of [['warrens', undefined], ['classic', 'noise'], ['river', 'noise']] as const) {
      for (let s = 0; s < 8; s++) {
        const m = generateMap({ seed: 500 + s, size: s % 2 ? 'large' : 'medium', players: 2 + (s % 3), form, fill, terrain: 'standard' });
        const t = new Terrain({ walls: [], fields: [], crystals: [], cave: m.terrain.cave }, m.width, m.height);
        expect(t.cutOff(m.nests[0].x, m.nests[0].y), `${form} ${s} ${m.aspect!.toFixed(1)}:1`).toEqual([]);
      }
    }
  });

  it('islands: off caves, a rift sea with dry bridges joining every nest; in caves, rock', () => {
    for (let s = 0; s < 8; s++) {
      const players = 2 + (s % 3);
      const m = generateMap({ seed: 600 + s, size: s % 2 ? 'large' : 'medium', players, form: 'islands', terrain: 'standard' });
      expect(m.terrain.cave).toBeFalsy();
      const rifts = m.terrain.fields.filter((f) => f.kind === 'rift');
      expect(rifts.length).toBeGreaterThan(20);
      for (const n of m.nests) for (const c of rifts) expect(capsuleDist(c, n.x, n.y)).toBeGreaterThan(NEST_RADIUS[n.type]);
      // Treat the sea as rock: the bridges alone still join every nest.
      const dry = new Terrain({ ...m.terrain, walls: [...m.terrain.walls, ...rifts], fields: [] }, m.width, m.height);
      expect(dry.connected(m.nests.map((n) => [n.x, n.y])), `seed ${600 + s}`).toBe(true);
    }
    const c = generateMap({ seed: 600, size: 'medium', players: 2, form: 'islands', caves: 'full', terrain: 'standard' });
    expect(c.terrain.cave).toBeTruthy();
    // A couple of shaped rifts (a few capsules each, #114), not a sea.
    expect(c.terrain.fields.filter((f) => f.kind === 'rift').length).toBeLessThan(30);
  });

  it('warrens spread their nests out through the caverns, not just the middle', () => {
    let outer = 0, all = 0;
    for (let s = 0; s < 8; s++) {
      const m = generateMap({ seed: 700 + s, size: 'medium', players: 2, form: 'warrens', terrain: 'standard' });
      for (const n of m.nests) {
        all++;
        if (((n.x - m.width / 2) / (0.44 * m.width)) ** 2 + ((n.y - m.height / 2) / (0.42 * m.height)) ** 2 > 0.8 ** 2) outer++;
      }
    }
    expect(outer / all).toBeGreaterThan(0.3);
  });

  it('an asked-for fill applies to any open form, even over a cave belt', () => {
    const m = generateMap({ seed: 3, size: 'medium', players: 2, form: 'classic', fill: 'noise', caves: 'belt', terrain: 'standard' });
    expect(m.fill).toBe('noise');
    expect(m.terrain.cave!.zone!.length).toBeGreaterThan(0);
    expect(generateMap({ seed: 3, size: 'medium', players: 2, form: 'warrens', fill: 'noise', terrain: 'standard' }).fill).toBeUndefined();
  });

  it('generates quickly, even the heaviest forms', () => {
    const t0 = performance.now();
    for (const form of ['warrens', 'regions'] as const) for (let s = 0; s < 4; s++) generateMap({ seed: s, size: 'large', players: 4, form, terrain: 'standard' });
    for (let s = 0; s < 4; s++) generateMap({ seed: s, size: 'large', players: 4, form: 'ring', fill: 'noise', terrain: 'standard' });
    expect((performance.now() - t0) / 12).toBeLessThan(400);
  });
});

/** Fields that touch, grouped: one feature each (a rift chain, a nebula cloud). */
function features(fs: FieldSpec[]): FieldSpec[][] {
  const root = fs.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const a = fs[i], b = fs[j];
      const d2 = Math.min(segDist2(a.x1, a.y1, b.x1, b.y1, b.x2, b.y2), segDist2(a.x2, a.y2, b.x1, b.y1, b.x2, b.y2), segDist2(b.x1, b.y1, a.x1, a.y1, a.x2, a.y2), segDist2(b.x2, b.y2, a.x1, a.y1, a.x2, a.y2));
      if (d2 < (a.r + b.r) ** 2) root[find(i)] = find(j);
    }
  }
  const groups = new Map<number, FieldSpec[]>();
  fs.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));
  return [...groups.values()];
}

/** The walking lines from every nest to its two nearest, on the ground alone. */
function routes(m: MapSpec): number[][] {
  const t = new Terrain({ ...m.terrain, fields: [] }, m.width, m.height);
  return m.nests.flatMap((a, i) =>
    m.nests
      .map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 }))
      .filter((o) => o.j !== i)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
      .map(({ j }) => t.trace(a.x, a.y, m.nests[j].x, m.nests[j].y, 0)),
  );
}

describe('feature placement (#114)', () => {
  it("every start's walk to its nearest crystal is about as long", () => {
    const spreads: number[] = [];
    for (const players of [2, 3, 4]) {
      for (const size of ['small', 'medium', 'large'] as MapSize[]) {
        for (let s = 0; s < 12; s++) {
          const m = generateMap({ seed: 900 + s, size, players, terrain: 'standard' });
          // The middle one is everyone's, as far as the shape puts it.
          const own = m.terrain.crystals.filter((c) => c.x !== m.width / 2 || c.y !== m.height / 2);
          expect(own.length, `${s} ${size} ${players}p`).toBeGreaterThanOrEqual(players);
          const t = new Terrain({ ...m.terrain, fields: [] }, m.width, m.height);
          const d = m.nests.slice(0, players).map((n) => Math.min(...own.map((c) => t.pathDist(c.x, c.y, n.x, n.y, 0))));
          spreads.push(Math.max(...d) / Math.min(...d));
        }
      }
    }
    spreads.sort((a, b) => a - b);
    expect(spreads[Math.floor(spreads.length / 2)]).toBeLessThan(1.1);
    expect(spreads[Math.floor(spreads.length * 0.9)]).toBeLessThan(1.25);
    expect(spreads[spreads.length - 1]).toBeLessThan(1.7);
  });

  it('sparse maps have fewer, richer crystals; dense ones a contested and a safe one each', () => {
    let sparse = 0, dense = 0;
    for (let s = 0; s < 40; s++) {
      const m = generateMap({ seed: s, size: 'medium', players: 3, form: 'classic', terrain: 'standard' });
      const own = m.terrain.crystals.filter((c) => c.x !== m.width / 2 || c.y !== m.height / 2);
      if (m.density! < 0.35) {
        sparse++;
        expect(own.length).toBe(3);
        for (const c of own) expect(c.value).toBe(1.5);
      } else if (m.density! > 0.6 && own.length === 6) {
        dense++;
        for (const c of own) expect(c.value).toBe(0.75);
      }
    }
    expect(sparse).toBeGreaterThan(3);
    expect(dense).toBeGreaterThan(3);
  });

  it('many rifts and most nebula lie across the walking lines between nests', () => {
    // On scattered rock: noise maps put some nebula in the valleys instead (tested below).
    const on = { nebula: [0, 0], rift: [0, 0] };
    for (const fill of ['sprinkle'] as const) {
      for (const players of [2, 3, 4]) {
        for (let s = 0; s < 10; s++) {
          const m = generateMap({ seed: 700 + s, size: 'medium', players, form: 'classic', fill, terrain: 'standard' });
          const lines = routes(m);
          for (const kind of ['nebula', 'rift'] as const) {
            for (const f of features(m.terrain.fields.filter((o) => o.kind === kind))) {
              on[kind][1]++;
              // Across a route: its core on the line, not just grazing it.
              if (f.some((c) => lines.some((p) => p.some((_, k) => k % 2 === 0 && capsuleDist(c, p[k], p[k + 1]) < c.r * 0.5)))) on[kind][0]++;
            }
          }
        }
      }
    }
    // Placed at random (before #114) these seeds gave nebula 0.63 and rifts 0.26; now 0.73 and 0.39.
    expect(on.nebula[0] / on.nebula[1]).toBeGreaterThan(0.68);
    expect(on.rift[0] / on.rift[1]).toBeGreaterThan(0.33);
  });

  it('noise and warrens maps put nebula in the valleys and crystals on high ground', () => {
    for (const form of ['classic', 'warrens'] as const) {
      let lower = 0, maps = 0;
      for (const players of [2, 3]) {
        for (let s = 0; s < 8; s++) {
          const m = generateMap({ seed: 800 + s, size: 'medium', players, form, fill: form === 'classic' ? 'noise' : undefined, terrain: 'standard' });
          const H = groundHeight.get(m.terrain)!;
          const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
          const neb = m.terrain.fields.filter((f) => f.kind === 'nebula').map((f) => H(f.x1, f.y1)).filter((v) => v >= 0);
          const cry = m.terrain.crystals.filter((c) => c.x !== m.width / 2 || c.y !== m.height / 2).map((c) => H(c.x, c.y)).filter((v) => v >= 0);
          if (!neb.length || !cry.length) continue;
          maps++;
          if (mean(neb) < mean(cry)) lower++;
        }
      }
      expect(lower / maps, form).toBeGreaterThan(0.85);
    }
  });

  it('rifts come in shapes: curves, forks and pools, not just straight strips', () => {
    let curves = 0, forks = 0, pools = 0;
    for (let s = 0; s < 20; s++) {
      const m = generateMap({ seed: 40 + s, size: 'medium', players: 2, form: 'classic', fill: 'sprinkle', terrain: 'heavy' });
      for (const f of features(m.terrain.fields.filter((o) => o.kind === 'rift'))) {
        if (f.some((c) => c.r > 16)) pools++;
        else if (f.length >= 6) forks++;
        else if (f.length >= 3) {
          // Bent: the pieces don't all point the same way.
          const dir = f.map((c) => [c.x2 - c.x1, c.y2 - c.y1].map((v) => v / Math.max(1e-6, Math.sqrt((c.x2 - c.x1) ** 2 + (c.y2 - c.y1) ** 2))));
          if (dir.some(([x, y]) => Math.abs(x * dir[0][0] + y * dir[0][1]) < 0.97)) curves++;
        }
      }
    }
    expect(curves).toBeGreaterThan(3);
    expect(forks).toBeGreaterThan(0);
    expect(pools).toBeGreaterThan(0);
  });

  it('no rift is ever the only way: treated as rock, the nests still connect, on every form', () => {
    for (const form of MAP_FORMS) {
      for (const players of [2, 3, 4]) {
        const m = generateMap({ seed: 60 + players, size: 'medium', players, form, terrain: 'heavy' });
        const rifts = m.terrain.fields.filter((f) => f.kind === 'rift');
        const dry = new Terrain({ ...m.terrain, walls: [...m.terrain.walls, ...rifts], fields: [] }, m.width, m.height);
        expect(dry.connected(m.nests.map((n) => [n.x, n.y])), `${form} ${players}p`).toBe(true);
      }
    }
  });
});
