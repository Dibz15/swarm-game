import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { Kind, NEST_RADIUS, TICK_HZ } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { CAVE_LEVELS, generateMap, type CaveLevel, type MapSize } from '../src/sim/mapgen';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Terrain } from '../src/sim/terrain';
import { spawnUnit, World } from '../src/sim/world';
import { botMatch } from './helpers';

const CAVES = CAVE_LEVELS.filter((c) => c !== 'off') as CaveLevel[];

describe('cave mapgen', () => {
  it('every nest sits in open ground and reaches every other, on all sizes and shapes', () => {
    for (const caves of CAVES) {
      for (const size of ['small', 'medium', 'large'] as MapSize[]) {
        for (const players of [2, 3, 5]) {
          for (const alt of [0, 1]) {
            for (let s = 0; s < 3; s++) {
              const m = generateMap({ seed: 300 + s + alt * 97, size, players, terrain: 'standard', caves });
              const t = new Terrain(m.terrain, m.width, m.height);
              expect(t.connected(m.nests.map((n) => [n.x, n.y]))).toBe(true);
              for (const n of m.nests) expect(t.clearance(n.x, n.y)).toBeGreaterThan(NEST_RADIUS[n.type] + 10);
              for (const c of m.terrain.crystals) expect(t.rockDist(c.x, c.y)).toBeGreaterThan(c.r);
            }
          }
        }
      }
    }
  });

  it('full caves are mostly rock; the belt leaves the rim open', () => {
    const share = (caves: CaveLevel) => {
      const m = generateMap({ seed: 5, size: 'medium', players: 4, caves });
      const t = new Terrain(m.terrain, m.width, m.height);
      let rock = 0, n = 0;
      for (let y = 8; y < m.height; y += 16) for (let x = 8; x < m.width; x += 16, n++) if (t.rockDist(x, y) < 0) rock++;
      return rock / n;
    };
    expect(share('full')).toBeGreaterThan(0.45);
    expect(share('belt')).toBeGreaterThan(0.06);
    expect(share('belt')).toBeLessThan(share('full'));
  });

  // The map is an ellipse, so starts differ in straight-line distance to the
  // center on every map. Caves must not add to that: compare each start's
  // detour (walking over straight-line distance).
  it('is fair: every start detours about as much to reach the center', () => {
    for (const caves of CAVES) {
      for (const players of [2, 3, 4, 6]) {
        for (const size of ['small', 'medium', 'large'] as MapSize[]) {
          const m = generateMap({ seed: 11 + players, size, players, caves });
          const t = new Terrain(m.terrain, m.width, m.height);
          // The middle of the map (a center nest, or open ground on crystal-center layouts).
          const c = { x: m.width / 2, y: m.height / 2 };
          const d = m.nests.slice(0, players).map((n) => t.pathDist(n.x, n.y, c.x, c.y, 0) / Math.hypot(n.x - c.x, n.y - c.y));
          expect(Math.max(...d) / Math.min(...d)).toBeLessThan(1.25);
        }
      }
    }
  });

  it('caves do not reshuffle the nests', () => {
    const a = generateMap({ seed: 31, size: 'large', players: 4 });
    const b = generateMap({ seed: 31, size: 'large', players: 4, caves: 'full' });
    expect(b.nests).toEqual(a.nests);
  });
});

describe('fighting in caves', () => {
  it('units stay out of rock and get through tunnels', () => {
    const m = generateMap({ seed: 77, size: 'small', players: 2, caves: 'full', layout: 'classic' });
    const w = new World(1, m.width, m.height, m.terrain);
    for (const f of [0, 1]) {
      w.factions[f].active = true;
      w.setTeam(f, f);
    }
    const [a, b] = m.nests;
    const uids: number[] = [];
    for (let k = 0; k < 12; k++) uids.push(w.uid[spawnUnit(w, 0, Kind.Dot, a.x + (k % 4) * 6, a.y + Math.floor(k / 4) * 6, a.x, a.y, 10)]);
    spawnUnit(w, 1, Kind.Dot, b.x, b.y, b.x, b.y, 4); // keep the match alive
    w.grid.build(w);
    const c = m.nests[2]; // the center
    applyCommand(w, { t: 'move', p: 0, units: uids, x: c.x, y: c.y, nest: -1 });
    for (let t = 0; t < 40 * TICK_HZ; t++) {
      step(w, []);
      for (const u of uids) {
        const s = w.uidToSlot.get(u);
        if (s !== undefined) expect(w.terrain.rockDist(w.x[s], w.y[s])).toBeGreaterThan(-1);
      }
    }
    let arrived = 0;
    for (const u of uids) {
      const s = w.uidToSlot.get(u)!;
      if (Math.hypot(w.x[s] - c.x, w.y[s] - c.y) < 90) arrived++;
    }
    expect(arrived).toBe(uids.length);
  });

  it('rock blocks line of fire and movement between parallel tunnels', () => {
    // Two tunnels 100px apart, joined at the left end; 50px of rock between them.
    const cave = {
      carves: [
        { x1: 60, y1: 100, x2: 740, y2: 100, r: 25 },
        { x1: 60, y1: 200, x2: 740, y2: 200, r: 25 },
        { x1: 60, y1: 100, x2: 60, y2: 200, r: 25 },
      ],
      zone: null,
    };
    const t = new Terrain({ walls: [], fields: [], crystals: [], cave }, 800, 300);
    expect(t.los(400, 100, 400, 200)).toBe(false);
    expect(t.los(150, 100, 700, 100)).toBe(true);
    expect(t.rockDist(400, 150)).toBeLessThan(-20);
    // A unit pushed into the rock comes back out to the nearer tunnel.
    t.collide(400, 130, 3);
    expect(t.oy).toBeLessThan(130);
    expect(t.rockDist(t.ox, t.oy)).toBeGreaterThan(2);
    // Walking from one tunnel to the other goes around through the joint.
    expect(t.pathDist(400, 100, 400, 200, 0)).toBeGreaterThan(600);
  });

  it('bot match in full caves replays identically', () => {
    const run = () => {
      const w = createWorld({ ...botMatch(4242), terrain: 'standard', caves: 'full', events: 'normal' });
      for (let t = 0; t < 60 * TICK_HZ; t++) step(w, []);
      return w;
    };
    const a = run(), b = run();
    expect(worldHash(a)).toBe(worldHash(b));
    expect(a.count).toBeGreaterThan(0);
  });
});
