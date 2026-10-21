import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { worldHash } from '../src/sim/hash';
import { queryRadius } from '../src/sim/spatial';
import { applyCommand } from '../src/sim/commands';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import { spawnUnit, World } from '../src/sim/world';
import { botMatch } from './helpers';

function run(seed: number, ticks: number) {
  const w = createWorld(botMatch(seed));
  for (let t = 0; t < ticks; t++) step(w, []);
  return w;
}

describe('determinism', () => {
  it('same seed + inputs give identical state', () => {
    const a = run(1234, 90 * TICK_HZ);
    const b = run(1234, 90 * TICK_HZ);
    expect(worldHash(a)).toBe(worldHash(b));
    expect(a.count).toBeGreaterThan(0);
  });

  it('different seeds diverge', () => {
    expect(worldHash(run(1, 300))).not.toBe(worldHash(run(2, 300)));
  });
});

describe('spatial grid', () => {
  it('queryRadius matches brute force', () => {
    const w = createWorld(botMatch(7));
    for (let t = 0; t < 200; t++) step(w, []);
    w.grid.build(w);
    const out: number[] = [];
    for (const [x, y, r] of [[300, 300, 80], [950, 600, 150], [10, 10, 40]] as const) {
      queryRadius(w, x, y, r, out);
      const brute: number[] = [];
      for (let i = 0; i < w.n; i++) {
        if (w.alive[i] && (w.x[i] - x) ** 2 + (w.y[i] - y) ** 2 <= r * r) brute.push(i);
      }
      expect([...out].sort((p, q) => p - q)).toEqual(brute);
    }
  });
});

describe('nests', () => {
  function emptyWorld() {
    const w = new World(5, 600, 400);
    // Two live factions so the match does not end immediately.
    w.factions[0].active = true;
    w.factions[1].active = true;
    w.setTeam(1, 1);
    spawnUnit(w, 1, 0, 580, 380, 580, 380, 4);
    w.nests.push({
      id: 0, x: 300, y: 200, r: 26, type: 0, owner: NEUTRAL, level: 1, control: 1, controller: NEUTRAL,
      spawnAcc: 0, rallyX: 300, rallyY: 200, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0,
    });
    return w;
  }

  it('an uncontested army captures a neutral nest', () => {
    const w = emptyWorld();
    for (let k = 0; k < 12; k++) spawnUnit(w, 0, 0, 300 + (k % 4) * 4, 200 + Math.floor(k / 4) * 4, 300, 200, 20);
    for (let t = 0; t < 12 * TICK_HZ && w.nests[0].owner !== 0; t++) step(w, []);
    expect(w.nests[0].owner).toBe(0);
    expect(w.fx.some((f) => f.type === 'capture')).toBe(true);
  });

  it('a garrison blocks capture', () => {
    const w = emptyWorld();
    for (let k = 0; k < 40; k++) spawnUnit(w, NEUTRAL, 1, 300, 200, 300, 200, 4);
    spawnUnit(w, 0, 0, 300, 200, 300, 200, 4);
    for (let t = 0; t < 60; t++) step(w, []);
    expect(w.nests[0].owner).toBe(NEUTRAL);
  });

  it('feeding dots upgrades the nest', () => {
    const w = emptyWorld();
    w.nests[0].owner = 0;
    w.nests[0].controller = 0;
    const uids: number[] = [];
    for (let k = 0; k < 25; k++) uids.push(w.uid[spawnUnit(w, 0, 0, 200 + k * 3, 150, 200, 150, 30)]);
    w.grid.build(w);
    applyCommand(w, { t: 'upgrade', p: 0, nest: 0 });
    expect(w.nests[0].feedIncoming).toBe(20);
    for (let t = 0; t < 10 * TICK_HZ; t++) step(w, []);
    expect(w.nests[0].level).toBe(2);
    expect(w.nests[0].feedIncoming).toBe(0);
  });
});
