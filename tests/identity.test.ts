import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { Kind, NEUTRAL, NestType, POWER, TICK_HZ } from '../src/sim/constants';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

function arena(): World {
  const w = new World(11, 800, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  return w;
}

function nest(w: World, type: number, owner: number, x = 400, y = 250) {
  w.nests.push({
    id: w.nests.length, x, y, r: 26, type, owner, level: 1, control: 1, controller: owner, spawnAcc: 0,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
  return w.nests[w.nests.length - 1];
}

function captureTicks(kind: number): number {
  const w = arena();
  const n = nest(w, NestType.Hive, NEUTRAL);
  spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 4); // keep the match alive
  for (let k = 0; k < 6; k++) spawnUnit(w, 0, kind, 400 + k, 250, 400, 250, 10);
  let t = 0;
  while (n.owner !== 0 && t < 60 * TICK_HZ) {
    step(w, []);
    t++;
  }
  return t;
}

describe('unit identity', () => {
  it('Swifts capture nests much faster than Dots', () => {
    expect(captureTicks(Kind.Swift)).toBeLessThan(captureTicks(Kind.Dot) * 0.6);
  });

  it('units shot from out of their sight turn and fight (retaliation)', () => {
    const w = arena();
    for (let k = 0; k < 30; k++) spawnUnit(w, 0, Kind.Dot, 300 + (k % 6) * 6, 220 + Math.floor(k / 6) * 10, 320, 250, 30);
    for (let k = 0; k < 10; k++) spawnUnit(w, 1, Kind.Lancer, 370 + (k % 3) * 5, 230 + k * 4, 372, 250, 10);
    for (let t = 0; t < 20 * TICK_HZ && w.unitCount[1] > 0 && w.unitCount[0] > 0; t++) step(w, []);
    expect(w.unitCount[1]).toBe(0); // the Dots reached and beat the Lancers
  });
});

describe('nest powers', () => {
  it('powers need the matching nest and energy', () => {
    const w = arena();
    spawnUnit(w, 1, Kind.Dot, 790, 490, 790, 490, 4);
    w.factions[0].energy = 100;
    w.grid.build(w);
    applyCommand(w, { t: 'barrage', p: 0, x: 400, y: 250 });
    expect(w.barrages.length).toBe(0); // no Spire held
    nest(w, NestType.Spire, 0, 100, 100);
    applyCommand(w, { t: 'barrage', p: 0, x: 400, y: 250 });
    expect(w.barrages.length).toBe(1);
    expect(w.factions[0].energy).toBe(100 - POWER.barrageCost);
  });

  it('Barrage lands after its delay and only hurts enemies', () => {
    const w = arena();
    nest(w, NestType.Spire, 0, 300, 275);
    w.factions[0].energy = 100;
    // 50 apart: both inside the blast, but beyond each other's notice range.
    const enemy = spawnUnit(w, 1, Kind.Tank, 600, 250, 600, 250, 4);
    const friend = spawnUnit(w, 0, Kind.Tank, 600, 300, 600, 300, 4);
    const hp0 = w.hp[enemy], friendHp = w.hp[friend];
    w.grid.build(w);
    applyCommand(w, { t: 'barrage', p: 0, x: 600, y: 275 });
    for (let t = 0; t < POWER.barrageDelay - 2; t++) step(w, []);
    expect(w.hp[enemy]).toBe(hp0); // telegraph only
    for (let t = 0; t < 4; t++) step(w, []);
    expect(w.hp[enemy]).toBeLessThan(hp0 - POWER.barrageDamage * 0.5);
    expect(w.hp[friend]).toBe(friendHp);
  });

  it('Lockdown stops an enemy nest from spawning', () => {
    const w = arena();
    nest(w, NestType.Bastion, 0, 100, 100);
    const target = nest(w, NestType.Hive, 1, 600, 250);
    w.factions[0].energy = 100;
    w.grid.build(w);
    applyCommand(w, { t: 'lockdown', p: 0, nest: target.id });
    const before = w.unitCount[1];
    for (let t = 0; t < POWER.lockdownTicks - 5; t++) step(w, []);
    expect(w.unitCount[1]).toBe(before);
    for (let t = 0; t < 4 * TICK_HZ; t++) step(w, []);
    expect(w.unitCount[1]).toBeGreaterThan(before);
  });
});
