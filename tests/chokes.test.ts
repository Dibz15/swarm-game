import { describe, expect, it } from 'vitest';
import { Bot } from '../src/sim/ai/bot';
import { nestMouths } from '../src/sim/ai/chokes';
import { Kind, NestType } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

// Bots play chokepoints (#25).

/** Two chambers joined by one straight tunnel 56 px wide; side 0 holds the west one, side 1 the east. */
function tunnel(): World {
  const w = new World(11, 1000, 600, {
    walls: [], fields: [], crystals: [],
    cave: {
      zone: null,
      carves: [
        { x1: 200, y1: 300, x2: 200, y2: 300, r: 100 },
        { x1: 290, y1: 300, x2: 710, y2: 300, r: 28 },
        { x1: 800, y1: 300, x2: 800, y2: 300, r: 100 },
      ],
    },
  });
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  for (const [x, owner] of [[200, 0], [800, 1]]) {
    w.nests.push({
      id: w.nests.length, x, y: 300, r: 26, type: NestType.Hive, owner, level: 1, control: 1, controller: owner, spawnAcc: -1e9,
      rallyX: x, rallyY: 300, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
    });
  }
  return w;
}

function dots(w: World, f: number, n: number, x: number, y: number) {
  for (let i = 0; i < n; i++) spawnUnit(w, f, Kind.Dot, x + (i % 6) * 7 - 18, y + Math.floor(i / 6) * 7 - 18, x, y, 0);
}

describe('choke map (#25)', () => {
  it('finds the tunnel mouth of each chamber, with a guard post inside and a staging point out in the tunnel', () => {
    const [west, east] = nestMouths(tunnel());
    expect(west.length).toBe(1);
    expect(east.length).toBe(1);
    const m = west[0];
    expect(m.from).toEqual([1]);
    expect(m.x).toBeGreaterThan(260);
    expect(m.x).toBeLessThan(340);
    expect(Math.abs(m.y - 300)).toBeLessThan(10);
    expect(m.width).toBeGreaterThan(40);
    expect(m.width).toBeLessThan(70);
    expect(m.gx).toBeLessThan(m.x);
    expect(m.sx).toBeGreaterThan(m.x + 100);
    expect(east[0].x).toBeGreaterThan(660);
  });

  it('open maps have no mouths', () => {
    const w = createWorld({ seed: 3, size: 'small', players: [0, 1].map((f) => ({ faction: f, team: f, human: false })) });
    expect(nestMouths(w).every((ms) => ms.length === 0)).toBe(true);
  });

  it('every start in a full cave has a mouth, and the map is the same every time', () => {
    const make = () => createWorld({ seed: 21, size: 'medium', caves: 'full', players: [0, 1, 2, 3].map((f) => ({ faction: f, team: f, human: false })) });
    const a = make(), b = make();
    const ma = nestMouths(a);
    for (const n of a.nests) if (n.capital) expect(ma[n.id].length).toBeGreaterThan(0);
    expect(JSON.stringify(nestMouths(b))).toBe(JSON.stringify(ma));
  });
});

describe('choke bots (#25)', () => {
  it('Hard bots meet attackers at the mouth they come through; Easy bots wait on the nest', () => {
    const firstDefense = (difficulty: number) => {
      const w = tunnel();
      w.tick = 3000;
      dots(w, 0, 12, 135, 300); // at the back of the chamber, not yet fighting
      dots(w, 1, 30, 290, 300); // coming out of the mouth 
      const bot = new Bot(0, { difficulty, personality: 'turtler' }, 5);
      const orders: { x: number; y: number }[] = [];
      (bot as unknown as { issue: (w: World, c: { t: string; x: number; y: number }) => void }).issue = (_w, c) => {
        if (c.t === 'move' && c.x < 400) orders.push(c); // not the staged counterattack
      };
      w.bots.push(bot);
      while (!orders.length && w.tick < 3200) step(w, []);
      return { order: orders[0], mouth: nestMouths(w)[0][0] };
    };
    const hard = firstDefense(2);
    expect([hard.order.x, hard.order.y]).toEqual([hard.mouth.gx, hard.mouth.gy]);
    const easy = firstDefense(0);
    expect([easy.order.x, easy.order.y]).toEqual([200, 300]);
  });

  it('Hard bots gather outside the mouth before pushing into a held chamber', () => {
    const w = tunnel();
    w.tick = 3000;
    dots(w, 0, 50, 200, 300);
    dots(w, 1, 8, 800, 300);
    const bot = new Bot(0, { difficulty: 2, personality: 'rusher' }, 5);
    w.bots.push(bot);
    const staged = () => (bot as unknown as { staged: { x: number }[] }).staged;
    let stagedAt = -1;
    for (let t = 0; t < 600 && stagedAt < 0; t++) {
      step(w, []);
      if (staged().length) stagedAt = staged()[0].x;
    }
    const east = nestMouths(w)[1][0];
    expect(stagedAt).toBe(east.sx);
    // It pushes in once gathered: the stage empties and the attack wipes out the defenders.
    for (let t = 0; t < 60 * 30 && !w.over; t++) step(w, []);
    expect(staged().length).toBe(0);
    expect(w.unitCount[1]).toBe(0);
  });

  it('open maps play out exactly as without choke play', () => {
    const play = (choke: number | undefined) => {
      const w = createWorld({ seed: 77, size: 'small', players: [0, 1].map((f) => ({ faction: f, team: f, human: false, bot: { difficulty: 2, personality: 'expander' as const, choke } })) });
      while (w.tick < 3000) step(w, []);
      return worldHash(w);
    };
    expect(play(undefined)).toBe(play(0));
  });
});
