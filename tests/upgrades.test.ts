import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { Kind, LEVEL, NEUTRAL, NestType, POWER, TICK_HZ, UNIT_STATS, UPGRADE_COST } from '../src/sim/constants';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

function arena(): World {
  const w = new World(9, 800, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  return w;
}

function nest(w: World, type: number, owner: number, level: number, x = 400, y = 250) {
  w.nests.push({
    id: w.nests.length, x, y, r: 26, type, owner, level, control: 1, controller: owner, spawnAcc: 0,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
  return w.nests[w.nests.length - 1];
}

describe('nest levels', () => {
  it('level 2 nests get a turret; level 1 nests do not', () => {
    for (const level of [1, 2]) {
      const w = arena();
      nest(w, NestType.Hive, 0, level, 100, 100);
      const e = spawnUnit(w, 1, Kind.Tank, 100 + LEVEL.turret.range - 10, 100, 100 + LEVEL.turret.range - 10, 100, 4);
      w.nests[0].spawnAcc = -1e9; // no spawns: only the turret can shoot
      for (let t = 0; t < 30; t++) step(w, []);
      if (level === 1) expect(w.hp[e]).toBe(UNIT_STATS[Kind.Tank].hp);
      else expect(w.hp[e]).toBeLessThan(UNIT_STATS[Kind.Tank].hp - LEVEL.turret.dps * 0.5);
    }
  });

  it('level 3 nests spawn veterans with extra HP', () => {
    const w = arena();
    nest(w, NestType.Hive, 0, 3, 100, 100);
    spawnUnit(w, 1, Kind.Dot, 780, 480, 780, 480, 4);
    for (let t = 0; t < 2 * TICK_HZ; t++) step(w, []);
    let vets = 0;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== 0) continue;
      expect(w.vet[i]).toBe(1);
      expect(w.hp[i]).toBeCloseTo(UNIT_STATS[Kind.Dot].hp * LEVEL.veteranHp);
      vets++;
    }
    expect(vets).toBeGreaterThan(0);
  });

  it('a level-3 Spire makes Barrage wider', () => {
    const radius = (level: number) => {
      const w = arena();
      nest(w, NestType.Spire, 0, level, 100, 100);
      w.factions[0].energy = 100;
      applyCommand(w, { t: 'barrage', p: 0, x: 400, y: 250 });
      return w.barrages[0].r;
    };
    expect(radius(2)).toBe(POWER.barrageRadius);
    expect(radius(3)).toBeCloseTo(POWER.barrageRadius * LEVEL.powerBoost);
  });

  it('captured nests keep their level', () => {
    const w = arena();
    const n = nest(w, NestType.Hive, 1, 3);
    spawnUnit(w, 1, Kind.Dot, 780, 480, 780, 480, 4);
    n.spawnAcc = -1e9;
    for (let k = 0; k < 20; k++) spawnUnit(w, 0, Kind.Swift, 400 + (k % 5) * 3, 250 + Math.floor(k / 5) * 3, 400, 250, 10);
    for (let t = 0; t < 40 * TICK_HZ && n.owner !== 0; t++) step(w, []);
    expect(n.owner).toBe(0);
    expect(n.level).toBe(3);
  });

  it('feeding a damaged nest repairs its control before levelling it', () => {
    const w = arena();
    const n = nest(w, NestType.Hive, 0, 1);
    n.control = 0.5;
    n.spawnAcc = -1e9;
    spawnUnit(w, 1, Kind.Dot, 780, 480, 780, 480, 4);
    const uids: number[] = [];
    for (let k = 0; k < 30; k++) uids.push(w.uid[spawnUnit(w, 0, Kind.Dot, 330 + (k % 6) * 5, 200 + Math.floor(k / 6) * 5, 330, 200, 30)]);
    w.grid.build(w);
    applyCommand(w, { t: 'upgrade', p: 0, nest: n.id });
    expect(n.feedIncoming).toBe(5 + UPGRADE_COST[1]);
    for (let t = 0; t < 12 * TICK_HZ; t++) step(w, []);
    expect(n.control).toBe(1);
    expect(n.level).toBe(2);
  });

  it('neutral level-2 nests have no turret (they stay fair to capture)', () => {
    const w = arena();
    nest(w, NestType.Hive, NEUTRAL, 2, 100, 100);
    const e = spawnUnit(w, 0, Kind.Tank, 150, 100, 150, 100, 4);
    spawnUnit(w, 1, Kind.Dot, 780, 480, 780, 480, 4);
    for (let t = 0; t < 30; t++) step(w, []);
    expect(w.hp[e]).toBe(UNIT_STATS[Kind.Tank].hp);
  });
});
