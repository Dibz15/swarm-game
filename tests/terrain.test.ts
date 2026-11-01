import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { Kind, TERRAIN, TICK_HZ } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { generateMap, TERRAIN_LEVELS, type MapSize } from '../src/sim/mapgen';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { capsuleDist, riftDps, Terrain, type TerrainSpec } from '../src/sim/terrain';
import { spawnUnit, World } from '../src/sim/world';
import { botMatch } from './helpers';

/** 800x500 arena with a vertical wall down the middle, open at the bottom. */
function walled(extra: Partial<TerrainSpec> = {}): World {
  const w = new World(5, 800, 500, {
    walls: [{ x1: 400, y1: -20, x2: 400, y2: 360, r: 18 }],
    fields: [],
    crystals: [],
    ...extra,
  });
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  return w;
}

function insideWall(w: World, i: number): boolean {
  return w.terrain.spec.walls.some((c) => capsuleDist(c, w.x[i], w.y[i]) < 0);
}

describe('walls', () => {
  it('units route around a wall instead of piling into it', () => {
    const w = walled();
    spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 4); // keep the match alive
    const uids: number[] = [];
    for (let k = 0; k < 12; k++) uids.push(w.uid[spawnUnit(w, 0, Kind.Dot, 150 + (k % 4) * 8, 150 + Math.floor(k / 4) * 8, 150, 150, 10)]);
    w.grid.build(w);
    applyCommand(w, { t: 'move', p: 0, units: uids, x: 650, y: 150, nest: -1 });
    let crossed = 0;
    for (let t = 0; t < 30 * TICK_HZ; t++) {
      step(w, []);
      for (const u of uids) expect(insideWall(w, w.uidToSlot.get(u)!)).toBe(false);
    }
    for (const u of uids) if (w.x[w.uidToSlot.get(u)!] > 560) crossed++;
    expect(crossed).toBe(uids.length);
  });

  it('walls block line of fire', () => {
    const w = walled();
    // 50px apart, well within range, but the wall is between them.
    const a = spawnUnit(w, 0, Kind.Lancer, 375, 100, 375, 100, 4);
    const b = spawnUnit(w, 1, Kind.Lancer, 425, 100, 425, 100, 4);
    for (let t = 0; t < 3 * TICK_HZ; t++) step(w, []);
    expect(w.hp[a]).toBe(w.hp[b]);
    expect(w.beamCount).toBe(0);
    expect(w.terrain.los(375, 100, 425, 100)).toBe(false);
    expect(w.terrain.los(375, 450, 425, 450)).toBe(true);
  });

  it('move orders into a wall are pushed out to open ground', () => {
    const w = walled();
    const s = spawnUnit(w, 0, Kind.Dot, 100, 100, 100, 100, 4);
    spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 4);
    w.grid.build(w);
    applyCommand(w, { t: 'move', p: 0, units: [w.uid[s]], x: 400, y: 100, nest: -1 });
    expect(capsuleDist(w.terrain.spec.walls[0], w.ox[s], w.oy[s])).toBeGreaterThan(0);
  });

  it('flow-field distance goes around the wall', () => {
    const t = new Terrain({ walls: [{ x1: 400, y1: -20, x2: 400, y2: 360, r: 18 }], fields: [], crystals: [] }, 800, 500);
    const d = t.pathDist(150, 150, 650, 150, 0);
    expect(d).toBeGreaterThan(500 + 200); // has to dip below y = 360 and back
    expect(t.pathDist(150, 450, 650, 450, 0)).toBeLessThan(540);
  });
});

describe('fields', () => {
  it('nebula slows', () => {
    const w = walled({ walls: [], fields: [{ kind: 'nebula', x1: 200, y1: 250, x2: 200, y2: 250, r: 60 }] });
    const slow = spawnUnit(w, 0, Kind.Dot, 200, 250, 260, 250, 2);
    const fast = spawnUnit(w, 0, Kind.Dot, 200, 420, 260, 420, 2);
    spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 2);
    for (let t = 0; t < 15; t++) step(w, []);
    expect(w.x[slow] - 200).toBeLessThan((w.x[fast] - 200) * (TERRAIN.nebulaSlow + 0.1));
  });

  // #58: a dash across costs a scratch; standing in it kills.
  it('a rift burns hotter the longer a unit stays, and cools once it leaves', () => {
    const w = walled({ walls: [], fields: [{ kind: 'rift', x1: 400, y1: 100, x2: 400, y2: 400, r: 13 }] });
    spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 2);
    const dash = spawnUnit(w, 0, Kind.Dot, 360, 200, 360, 200, 2);
    const stay = spawnUnit(w, 0, Kind.Tank, 400, 300, 400, 300, 2);
    w.grid.build(w);
    applyCommand(w, { t: 'move', p: 0, units: [w.uid[dash]], x: 440, y: 200, nest: -1 });
    for (let t = 0; t < 3 * TICK_HZ; t++) step(w, []);
    expect(w.x[dash]).toBeGreaterThan(420);
    expect(10 - w.hp[dash]).toBeLessThan(1.5);
    expect(w.heat[dash]).toBe(0);
    expect(34 - w.hp[stay]).toBeGreaterThan(9);
    expect(riftDps(TERRAIN.rift.heatTicks)).toBe(TERRAIN.rift.maxDps);
    expect(riftDps(0)).toBe(TERRAIN.rift.minDps);
  });

  it('units cut across a thin rift line, but go round a wide one when the way round is short', () => {
    const thin = new Terrain({ walls: [], fields: [{ kind: 'rift', x1: 400, y1: -20, x2: 400, y2: 440, r: 13 }], crystals: [] }, 800, 500);
    // The way round is ~2x longer; crossing costs a little more than straight.
    expect(thin.pathDist(200, 150, 600, 150, 0)).toBeLessThan(470);
    // A pool as wide as the widest the maps make: the path skirts it, even where
    // the tiles round it cost no more than the straight line (#58).
    const pool = new Terrain({ walls: [], fields: [{ kind: 'rift', x1: 400, y1: 150, x2: 400, y2: 150, r: 30 }], crystals: [] }, 800, 500);
    const t = pool.trace(200, 150, 600, 150, 0);
    for (let k = 0; k < t.length; k += 2) expect(Math.hypot(t[k] - 400, t[k + 1] - 150)).toBeGreaterThan(26);
  });

  it('a crystal charges energy only for an uncontested holder', () => {
    const w = walled({ walls: [], crystals: [{ x: 400, y: 250, r: 30 }] });
    spawnUnit(w, 0, Kind.Tank, 400, 250, 400, 250, 2);
    const far = spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 2);
    for (let t = 0; t < 2 * TICK_HZ; t++) step(w, []);
    expect(w.crystals[0].holder).toBe(0);
    expect(w.factions[0].energy).toBeGreaterThan(w.factions[1].energy + TERRAIN.crystalEnergy);
    // An enemy steps on: nobody charges.
    w.x[far] = w.px[far] = 410;
    w.y[far] = w.py[far] = 250;
    w.ox[far] = 410;
    w.oy[far] = 250;
    for (let t = 0; t < 8; t++) step(w, []);
    expect(w.crystals[0].holder).toBe(-1);
  });

  it("a crystal's value scales what it pays (#114)", () => {
    const gain = (value?: number) => {
      const w = walled({ walls: [], crystals: [{ x: 400, y: 250, r: 30, value }] });
      spawnUnit(w, 0, Kind.Tank, 400, 250, 400, 250, 2);
      spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 2);
      for (let t = 0; t < 2 * TICK_HZ; t++) step(w, []);
      return w.factions[0].energy - w.factions[1].energy;
    };
    expect(gain(1.5) / gain()).toBeCloseTo(1.5, 1);
  });
});

describe('terrain mapgen', () => {
  it('keeps every nest reachable and clear of walls, on all sizes and shapes', () => {
    for (const size of ['small', 'medium', 'large'] as MapSize[]) {
      for (const players of [2, 3, 5]) {
        for (const alt of [0, 1]) {
          for (let s = 0; s < 4; s++) {
            const m = generateMap({ seed: 900 + s + alt * 97, size, players, terrain: 'heavy' });
            const t = new Terrain(m.terrain, m.width, m.height);
            expect(t.connected(m.nests.map((n) => [n.x, n.y]))).toBe(true);
            for (const n of m.nests) for (const c of m.terrain.walls) expect(capsuleDist(c, n.x, n.y)).toBeGreaterThan(40);
          }
        }
      }
    }
  });

  it('places terrain symmetrically: each sector gets the same amount', () => {
    const m = generateMap({ seed: 77, size: 'medium', players: 4, terrain: 'standard', layout: 'classic' });
    expect(m.terrain.walls.length % 4).toBe(0);
    expect(m.terrain.fields.length % 4).toBe(0);
    expect(m.terrain.crystals.length % 4).toBe(0);
    expect(m.terrain.walls.length).toBeGreaterThan(0);
  });

  it('presets scale terrain up, and none means none', () => {
    const count = (lvl: (typeof TERRAIN_LEVELS)[number]) => {
      let n = 0;
      for (let s = 0; s < 10; s++) {
        const t = generateMap({ seed: s, size: 'medium', players: 3, terrain: lvl }).terrain;
        n += t.walls.length + t.fields.length;
      }
      return n;
    };
    expect(count('none')).toBe(0);
    expect(count('light')).toBeLessThan(count('standard'));
    expect(count('standard')).toBeLessThan(count('heavy'));
  });

  // The terrain can change which form the seed picks (a ring needs something
  // to build its void from), so hold the form still.
  it('terrain does not reshuffle the nests', () => {
    const a = generateMap({ seed: 31, size: 'large', players: 4, form: 'classic' });
    const b = generateMap({ seed: 31, size: 'large', players: 4, terrain: 'heavy', form: 'classic' });
    expect(b.nests).toEqual(a.nests);
  });
});

describe('determinism with terrain', () => {
  it('bot match on heavy terrain replays identically', () => {
    const run = () => {
      const w = createWorld({ ...botMatch(4242), terrain: 'heavy' });
      for (let t = 0; t < 60 * TICK_HZ; t++) step(w, []);
      return w;
    };
    const a = run(), b = run();
    expect(worldHash(a)).toBe(worldHash(b));
    expect(a.count).toBeGreaterThan(0);
  });
});
