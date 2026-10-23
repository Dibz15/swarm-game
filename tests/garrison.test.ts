import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { Kind, NestType, TICK_HZ } from '../src/sim/constants';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

const NX = 300, NY = 250, NR = 26;

function arena(withNest: boolean): World {
  const w = new World(9, 800, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  // Faction 1 holds a far nest and a far unit, so nobody wins or dominates mid-test.
  if (withNest) nest(w, 0, NX, NY);
  nest(w, 1, 760, 40);
  spawnUnit(w, 1, Kind.Tank, 780, 480, 780, 480, 4);
  return w;
}

function nest(w: World, owner: number, x: number, y: number) {
  w.nests.push({
    id: w.nests.length, x, y, r: NR, type: NestType.Hive, owner, level: 1, control: 1, controller: owner, spawnAcc: -1e9,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
}

/** Park 14 Swarmers at the nest point, then march Shields past just outside the ring. */
function passBy(withNest: boolean, passY: number) {
  const w = arena(withNest);
  const uids: number[] = [];
  for (let k = 0; k < 14; k++) uids.push(w.uid[spawnUnit(w, 0, Kind.Dot, NX - 15 + (k % 5) * 7, NY - 10 + Math.floor(k / 5) * 7, NX, NY, 20)]);
  w.grid.build(w);
  applyCommand(w, { t: 'move', p: 0, units: uids, x: NX, y: NY, nest: withNest ? 0 : -1 });
  for (let t = 0; t < 3 * TICK_HZ; t++) step(w, []);
  const foes: number[] = [];
  for (let k = 0; k < 3; k++) foes.push(w.uid[spawnUnit(w, 1, Kind.Tank, 120 - k * 12, passY, 520, passY, 10)]);
  let farthest = 0;
  for (let t = 0; t < 14 * TICK_HZ; t++) {
    step(w, []);
    for (const u of uids) {
      const s = w.uidToSlot.get(u);
      if (s !== undefined) farthest = Math.max(farthest, Math.hypot(w.x[s] - NX, w.y[s] - NY));
    }
  }
  return { w, farthest, foes };
}

describe('holding a nest', () => {
  it('defenders stay in the ring while enemies pass just outside', () => {
    const { farthest } = passBy(true, NY + 50);
    expect(farthest).toBeLessThan(NR + 6);
  });

  it('the same blob in the open field still chases', () => {
    const { farthest } = passBy(false, NY + 50);
    expect(farthest).toBeGreaterThan(NR + 12);
  });

  it('defenders still fight anything that steps into the ring', () => {
    const w = arena(true);
    const uids: number[] = [];
    for (let k = 0; k < 14; k++) uids.push(w.uid[spawnUnit(w, 0, Kind.Dot, NX - 15 + (k % 5) * 7, NY - 10 + Math.floor(k / 5) * 7, NX, NY, 20)]);
    w.grid.build(w);
    applyCommand(w, { t: 'move', p: 0, units: uids, x: NX, y: NY, nest: 0 });
    for (let t = 0; t < 2 * TICK_HZ; t++) step(w, []);
    // A Raider runs across the ring.
    const r = w.uid[spawnUnit(w, 1, Kind.Swift, NX - 120, NY + 20, NX + 300, NY + 20, 10)];
    for (let t = 0; t < 8 * TICK_HZ; t++) step(w, []);
    expect(w.uidToSlot.has(r)).toBe(false);
  });
});
