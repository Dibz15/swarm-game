import { describe, expect, it } from 'vitest';
import { MISSIONS } from '../src/game/tutorial';
import { Bot } from '../src/sim/ai/bot';
import { applyCommand, barrageLaunch } from '../src/sim/commands';
import { Kind, NestType, POWER } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

// Barrage balance (#41): launched from a nest in range, damage budget, bots dodge.

function arena(): World {
  const w = new World(11, 1400, 600);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  return w;
}

function nest(w: World, type: number, owner: number, x: number, y: number) {
  w.nests.push({
    id: w.nests.length, x, y, r: 26, type, owner, level: 1, control: 1, controller: owner, spawnAcc: -1e9,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
  return w.nests[w.nests.length - 1];
}

/** A packed blob of side-1 Swarmers at (x, y); returns their slots. */
function blob(w: World, n: number, x: number, y: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(spawnUnit(w, 1, Kind.Dot, x + (i % 8) * 6 - 21, y + Math.floor(i / 8) * 6 - 21, x, y, 0));
  return out;
}

function strike(w: World, x: number, y: number): number {
  const before = w.unitCount[1];
  w.factions[0].energy = 100;
  w.grid.build(w);
  applyCommand(w, { t: 'barrage', p: 0, x, y });
  const impact = w.barrages[0]?.impact ?? w.tick;
  while (w.tick < impact + 2) step(w, []);
  return before - w.unitCount[1];
}

describe('Barrage (#41)', () => {
  it('is refused out of range of every nest you own, and costs nothing', () => {
    const w = arena();
    nest(w, NestType.Spire, 0, 100, 300);
    w.factions[0].energy = 100;
    applyCommand(w, { t: 'barrage', p: 0, x: 100 + POWER.barrageRange + 20, y: 300 });
    expect(w.barrages.length).toBe(0);
    expect(w.factions[0].energy).toBe(100);
  });

  it('launches from the nearest nest you own, any type', () => {
    const w = arena();
    nest(w, NestType.Spire, 0, 100, 300);
    const hive = nest(w, NestType.Hive, 0, 700, 300);
    nest(w, NestType.Hive, 1, 1000, 300); // an enemy nest never counts
    w.factions[0].energy = 100;
    expect(barrageLaunch(w, 0, 1000, 300)).toBe(hive);
    applyCommand(w, { t: 'barrage', p: 0, x: 1000, y: 300 });
    expect(w.barrages[0]).toMatchObject({ x0: 700, y0: 300 });
  });

  it('flies at a fixed speed: a longer shot gives more warning', () => {
    const w = arena();
    nest(w, NestType.Spire, 0, 100, 300);
    w.factions[0].energy = 100;
    applyCommand(w, { t: 'barrage', p: 0, x: 150, y: 300 });
    applyCommand(w, { t: 'barrage', p: 0, x: 500, y: 300 });
    const [near, far] = w.barrages.map((b) => b.impact - b.t0);
    expect(far - near).toBe(Math.round((350 / POWER.barrageSpeed) * 30));
  });

  it('still wipes a small group, but only takes a slice of a packed blob', () => {
    const small = arena();
    nest(small, NestType.Spire, 0, 300, 300);
    spawnUnit(small, 0, Kind.Dot, 50, 50, 50, 50, 0); // keep side 0 alive
    blob(small, 8, 600, 300);
    expect(strike(small, 600, 300)).toBe(8);

    const big = arena();
    nest(big, NestType.Spire, 0, 300, 300);
    spawnUnit(big, 0, Kind.Dot, 50, 50, 50, 50, 0);
    blob(big, 60, 600, 300);
    const killed = strike(big, 600, 300);
    expect(killed).toBeGreaterThan(8);
    expect(killed).toBeLessThan(POWER.barrageBudget / (POWER.barrageDamage * 0.6) + 1);
  });

  it('Hard bots move out from under it; Easy bots do not', () => {
    const run = (difficulty: number) => {
      const w = arena();
      nest(w, NestType.Spire, 0, 300, 300);
      nest(w, NestType.Hive, 1, 1300, 300);
      spawnUnit(w, 0, Kind.Dot, 50, 50, 50, 50, 0);
      w.bots.push(new Bot(1, { difficulty, personality: 'turtler' }, 7));
      blob(w, 12, 600, 300);
      return strike(w, 600, 300);
    };
    expect(run(0)).toBe(12);
    expect(run(3)).toBeLessThan(4);
  });

  it('tutorial mission 4: the Bastion is in reach of the Spire', () => {
    const m = MISSIONS.find((x) => x.id === 'powers')!;
    const w = createWorld(m.setup());
    const bastion = w.nests.find((n) => n.type === NestType.Bastion)!;
    expect(barrageLaunch(w, 0, bastion.x, bastion.y)).not.toBeNull();
  });
});
