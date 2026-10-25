import { describe, expect, it } from 'vitest';
import { ESCALATION, Kind, NestType, SUPPLY, TICK_HZ } from '../src/sim/constants';
import { supplyCap } from '../src/sim/nests';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

function arena(): World {
  const w = new World(5, 1200, 800);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  return w;
}

function nest(w: World, owner: number, x: number, y: number, level = 1) {
  w.nests.push({
    id: w.nests.length, x, y, r: 26, type: NestType.Hive, owner, level, control: 1, controller: owner, spawnAcc: 0,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
  return w.nests[w.nests.length - 1];
}

/** Park n dots of faction f in a far corner, out of everyone's way. */
function park(w: World, f: number, n: number, x: number, y: number) {
  for (let k = 0; k < n; k++) spawnUnit(w, f, Kind.Dot, x + (k % 10) * 6, y + Math.floor(k / 10) * 6, x, y, 40);
}

describe('supply', () => {
  it('cap = base + per nest + per upgrade level, and escalation lifts it', () => {
    const w = arena();
    nest(w, 0, 200, 200);
    nest(w, 0, 400, 200, 3);
    expect(supplyCap(w, 0)).toBe(SUPPLY.base + 2 * SUPPLY.perNest + 2 * SUPPLY.perLevel);
    expect(supplyCap(w, 1)).toBe(SUPPLY.base);
    w.tick = ESCALATION.start + ESCALATION.ramp;
    expect(supplyCap(w, 0)).toBe(SUPPLY.base + (2 * SUPPLY.perNest + 2 * SUPPLY.perLevel) * (1 + SUPPLY.escalation));
  });

  it('nests past the first few add less supply', () => {
    const w = arena();
    for (let k = 0; k < SUPPLY.fullNests + 4; k++) nest(w, 0, 100 + k * 90, 300);
    expect(supplyCap(w, 0)).toBe(Math.floor(SUPPLY.base + SUPPLY.perNest * (SUPPLY.fullNests + 4 * SUPPLY.tail)));
  });

  it('upkeep: a nearly capped army produces slower than a small one', () => {
    const grow = (start: number) => {
      const w = arena();
      nest(w, 0, 200, 400);
      nest(w, 0, 500, 400);
      nest(w, 1, 1100, 400);
      park(w, 0, start, 60, 60);
      park(w, 1, 4, 1100, 700);
      for (let t = 0; t < 10 * TICK_HZ; t++) step(w, []);
      return w.unitCount[0] - start;
    };
    expect(grow(SUPPLY.base + 2 * SUPPLY.perNest - 20)).toBeLessThan(grow(4));
  });

  it('nests stop producing at the cap, and a new nest restarts them', () => {
    const w = arena();
    nest(w, 0, 200, 400);
    nest(w, 1, 1100, 400);
    const cap = supplyCap(w, 0);
    park(w, 0, cap, 60, 60);
    park(w, 1, 4, 1100, 700);
    for (let t = 0; t < 20 * TICK_HZ; t++) step(w, []);
    expect(w.unitCount[0]).toBe(cap);
    // A second nest raises the cap: production resumes.
    nest(w, 0, 500, 400);
    for (let t = 0; t < 20 * TICK_HZ; t++) step(w, []);
    expect(w.unitCount[0]).toBeGreaterThan(cap);
    expect(w.unitCount[0]).toBeLessThanOrEqual(supplyCap(w, 0));
  });

  it('losing nests over the cap pauses production but kills nothing', () => {
    const w = arena();
    nest(w, 0, 200, 400);
    const lost = nest(w, 0, 500, 400);
    nest(w, 1, 1100, 400);
    park(w, 0, supplyCap(w, 0), 60, 60);
    park(w, 1, 4, 1100, 700);
    lost.owner = -1;
    lost.control = 0;
    const before = w.unitCount[0];
    expect(before).toBeGreaterThan(supplyCap(w, 0));
    for (let t = 0; t < 15 * TICK_HZ; t++) step(w, []);
    expect(w.unitCount[0]).toBe(before);
  });
});
