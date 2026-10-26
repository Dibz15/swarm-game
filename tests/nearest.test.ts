import { describe, expect, it } from 'vitest';
import { nearestNestOrders } from '../src/game/nearest';
import { Kind, NEUTRAL, NestType } from '../src/sim/constants';
import type { TerrainSpec } from '../src/sim/terrain';
import { spawnUnit, World } from '../src/sim/world';

// N: send the selection to the nearest nest you own (#42).

function arena(terrain?: TerrainSpec): World {
  const w = new World(5, 1200, 600, terrain);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  return w;
}

function nest(w: World, owner: number, x: number, y: number) {
  w.nests.push({
    id: w.nests.length, x, y, r: 26, type: NestType.Hive, owner, level: 1, control: 1, controller: owner, spawnAcc: 0,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
  return w.nests[w.nests.length - 1];
}

function blob(w: World, x: number, y: number, n = 6): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(w.uid[spawnUnit(w, 0, Kind.Dot, x + (i % 3) * 6, y + Math.floor(i / 3) * 6, x, y, 0)]);
  return out;
}

describe('nearest nest (#42)', () => {
  it('sends one blob to the closest nest you own, ignoring others', () => {
    const w = arena();
    nest(w, 0, 100, 300);
    const near = nest(w, 0, 500, 300);
    nest(w, 1, 650, 300); // enemy: closer, but not ours
    nest(w, NEUTRAL, 600, 330);
    const units = blob(w, 640, 300);
    expect(nearestNestOrders(w, 0, units)).toEqual([{ units, nest: near.id }]);
  });

  it('measures by walking distance: a wall in the way makes a nest farther', () => {
    // A wall from the top down to y=520 between the blob and the right-hand nest.
    const w = arena({ walls: [{ x1: 700, y1: -20, x2: 700, y2: 520, r: 18 }], fields: [], crystals: [] });
    const left = nest(w, 0, 400, 100);
    nest(w, 0, 800, 100);
    const units = blob(w, 640, 100);
    expect(nearestNestOrders(w, 0, units)[0].nest).toBe(left.id);
  });

  it('splits a spread-out selection: each group goes to its own nearest nest', () => {
    const w = arena();
    const a = nest(w, 0, 100, 300);
    const b = nest(w, 0, 1100, 300);
    const left = blob(w, 200, 300), right = blob(w, 1000, 300);
    const orders = nearestNestOrders(w, 0, [...left, ...right]);
    expect(orders).toEqual([{ units: left, nest: a.id }, { units: right, nest: b.id }]);
  });

  it('does nothing without a nest of your own', () => {
    const w = arena();
    nest(w, 1, 100, 300);
    expect(nearestNestOrders(w, 0, blob(w, 300, 300))).toEqual([]);
  });
});
