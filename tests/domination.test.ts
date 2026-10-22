import { describe, expect, it } from 'vitest';
import { DOMINATION, Kind, NestType, TICK_HZ } from '../src/sim/constants';
import { dominationStatus, step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

/** Player 0 holds 4 of 5 nests (80% ≥ 70%); player 1 holds 1. */
function dominated(): World {
  const w = new World(4, 900, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  const owners = [0, 0, 0, 0, 1];
  owners.forEach((owner, id) => {
    const x = 100 + id * 170, y = 250;
    w.nests.push({
      id, x, y, r: 26, type: NestType.Hive, owner, level: 1, control: 1, controller: owner, spawnAcc: -1e9,
      rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
    });
  });
  spawnUnit(w, 0, Kind.Dot, 50, 50, 50, 50, 4);
  spawnUnit(w, 1, Kind.Dot, 850, 450, 850, 450, 4);
  return w;
}

describe('domination', () => {
  it('announces itself, counts down, and ends the match by domination', () => {
    const w = dominated();
    let started = false;
    for (let t = 0; t < 20 && !started; t++) {
      step(w, []);
      started = w.fx.some((e) => e.type === 'domStart' && e.f === 0);
      w.fx = [];
    }
    expect(started).toBe(true);
    const ds = dominationStatus(w)!;
    expect(ds.team).toBe(0);
    expect(ds.held).toBe(4);
    expect(ds.need).toBe(Math.ceil(5 * w.domShare));
    expect(ds.toBreak).toBe(1);
    expect(ds.left).toBeLessThan(DOMINATION.ticks);
    for (let t = 0; t < DOMINATION.ticks + 30 && !w.over; t++) step(w, []);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(0);
    expect(w.winReason).toBe('domination');
  });

  it('losing a nest breaks it, with an event', () => {
    const w = dominated();
    for (let t = 0; t < 5 * TICK_HZ; t++) step(w, []);
    expect(dominationStatus(w)).not.toBeNull();
    w.nests[3].owner = 1;
    let broke = false;
    for (let t = 0; t < 20 && !broke; t++) {
      step(w, []);
      broke = w.fx.some((e) => e.type === 'domBreak' && e.f === 0);
      w.fx = [];
    }
    expect(broke).toBe(true);
    expect(dominationStatus(w)).toBeNull();
  });
});
