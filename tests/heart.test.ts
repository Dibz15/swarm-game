import { describe, expect, it } from 'vitest';
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { Kind, NEUTRAL, NestType, TICK_HZ } from '../src/sim/constants';
import { resolveDamage } from '../src/sim/combat';
import { initEvents } from '../src/sim/events';
import { worldHash } from '../src/sim/hash';
import { HEART, heartSlot, heartWard, initHeart, standingNests } from '../src/sim/heart';
import type { EventParams } from '../src/sim/mapgen';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Proxy } from '../src/proxy/proxy';
import { spawnUnit, World, type HeartRule } from '../src/sim/world';

// Events must be on for the heart; nothing else should fire during a test.
const QUIET: EventParams = { swarm: null, drop: { first: 1e6, every: 1e6 }, colossus: [], regrow: 0 };

/** Faction 0 (human) and 1 (bot) on a 1200 × 900 field, two neutral nests near the middle. */
function arena(rule: HeartRule = 'heart', strength = 0): World {
  const w = new World(5, 1200, 900);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  w.factions[0].human = true;
  for (const [x, y, owner] of [[400, 450, NEUTRAL], [800, 450, NEUTRAL], [100, 100, 0], [1100, 800, 1]]) {
    w.nests.push({
      id: w.nests.length, x, y, r: 26, type: NestType.Hive, owner, level: 1, control: 1, controller: owner, spawnAcc: 0,
      rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
    });
  }
  initEvents(w, { params: QUIET, swarmSpawns: [[600, 880]], dropSpots: [], colossusPaths: [] });
  initHeart(w, strength, rule);
  return w;
}

function units(w: World, f: number, kind: number, n: number, x: number, y: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(spawnUnit(w, f, kind, x + (k % 4) * 7, y + Math.floor(k / 4) * 7, x, y, 30));
  return out;
}

describe("the Bloom's heart", () => {
  it('roots near the centre, scales with strength and wakes the nearest neutral nests', () => {
    const w = arena('heart', 10);
    const h = w.heart!;
    expect(Math.abs(h.x - 600)).toBeLessThan(150);
    expect(h.maxHp).toBeCloseTo(HEART.hp * (1 + HEART.hpPerStrength * 10));
    expect(h.nests).toEqual([0, 1]);
    // A crowd shoving at it doesn't move it.
    units(w, 0, Kind.Tank, 24, h.x - 30, h.y - 30);
    for (let t = 0; t < 3 * TICK_HZ; t++) step(w, []);
    const s = heartSlot(w);
    expect([w.x[s], w.y[s]]).toEqual([h.x, h.y]);
  });

  it('is warded by every Bloom nest the Bloom still holds', () => {
    const w = arena();
    const s = heartSlot(w);
    expect(standingNests(w)).toBe(2);
    expect(heartWard(w)).toBeCloseTo(1 - 2 * HEART.ward);
    const hp = w.hp[s];
    w.dmg[s] = 100;
    resolveDamage(w);
    expect(hp - w.hp[s]).toBeCloseTo(100 * (1 - 2 * HEART.ward));
    w.nests[0].owner = 0;
    expect(heartWard(w)).toBeCloseTo(1 - HEART.ward);
    // A nest the players took stays lost to the Bloom, even if it goes wild again.
    step(w, []);
    w.nests[0].owner = NEUTRAL;
    expect(standingNests(w)).toBe(1);
  });

  it('telegraphs its pulse, which hits what is inside its ring and nothing else', () => {
    const w = arena();
    const h = w.heart!;
    const inside = units(w, 0, Kind.Tank, 4, h.x + 90, h.y);
    const outside = units(w, 1, Kind.Tank, 4, h.x - 560, h.y + 300);
    const fx: string[] = [];
    for (let t = 0; t < (HEART.pulseEvery[0] + 2) * TICK_HZ && !fx.includes('heartPulse'); t++) {
      step(w, []);
      for (const e of w.fx) fx.push(e.type);
      w.fx = [];
    }
    expect(fx.indexOf('heartWindup')).toBeGreaterThanOrEqual(0);
    expect(fx.indexOf('heartWindup')).toBeLessThan(fx.indexOf('heartPulse'));
    for (const i of inside) expect(w.hp[i]).toBeLessThan(34);
    for (const i of outside) expect(w.hp[i]).toBe(34);
  });

  it('rages at two thirds and one third of its health, and its swarms rally to it', () => {
    const w = arena();
    const s = heartSlot(w);
    const h = w.heart!;
    w.hp[s] = h.maxHp * 0.6;
    step(w, []);
    expect(h.phase).toBe(1);
    expect(w.fx.some((e) => e.type === 'heartPhase')).toBe(true);
    expect(h.recall).toBeGreaterThan(w.tick);
    expect(w.events!.swarms.length).toBeGreaterThan(0);
    w.hp[s] = h.maxHp * 0.3;
    step(w, []);
    expect(h.phase).toBe(2);
  });

  it('regrows when left alone, but never past a phase it lost', () => {
    const w = arena();
    const s = heartSlot(w);
    const h = w.heart!;
    w.hp[s] = h.maxHp * 0.5;
    for (let t = 0; t < 90 * TICK_HZ; t++) step(w, []);
    expect(w.hp[s]).toBeGreaterThan(h.maxHp * 0.5);
    expect(w.hp[s]).toBeLessThanOrEqual(h.maxHp * (2 / 3) + 1e-6);
  });

  const kill = (w: World, by: number) => {
    const s = heartSlot(w);
    w.hp[s] = 1;
    w.dmg[s] = 1e6;
    w.lastHit[s] = by;
    resolveDamage(w);
  };

  it("under the 'heart' rule, a human's killing blow wins the match", () => {
    const w = arena('heart');
    kill(w, 0);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(w.teamOf[0]);
    expect(w.winReason).toBe('heart');
  });

  it("if a rival kills it, or under 'heart+rivals', the players fight it out", () => {
    for (const [rule, by] of [['heart', 1], ['heart+rivals', 0]] as const) {
      const w = arena(rule);
      units(w, 0, Kind.Dot, 5, 100, 100);
      units(w, 1, Kind.Dot, 5, 1100, 800);
      kill(w, by);
      expect(w.heart!.slain).toBe(true);
      expect(w.over).toBe(false);
      for (let t = 0; t < 30; t++) step(w, []);
      expect(w.over).toBe(false);
    }
  });

  it('while it lives, wiping out the rivals is not a win', () => {
    const w = arena();
    units(w, 0, Kind.Dot, 5, 100, 100);
    w.nests[3].owner = -1;
    for (let t = 0; t < 30; t++) step(w, []);
    expect(w.factions[1].eliminated).toBe(true);
    expect(w.over).toBe(false);
  });
});

describe('the finale', () => {
  const finale = (seed: number, strength: number) => {
    const run = newRun(`finale-${seed}`, 0, 'swarm', 0);
    run.swallowed = run.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'finale').slice(0, strength).map((n) => n.id);
    for (const b of run.broods) b.size = 16;
    return { run, setup: nodeSetup(run, run.heart, run.broods.map((b) => b.id)) };
  };

  it('replays identically with the heart awake', () => {
    const play = () => {
      const w = createWorld(finale(3, 6).setup);
      const fx = new Set<string>();
      for (let t = 0; t < 150 * TICK_HZ && !w.over; t++) {
        step(w, []);
        for (const e of w.fx) fx.add(e.type);
        w.fx = [];
      }
      return { h: worldHash(w), fx: [...fx].sort() };
    };
    const a = play();
    expect(a.fx).toEqual(expect.arrayContaining(['heartWindup', 'heartPulse', 'bloomSwarm']));
    expect(play()).toEqual(a);
  });

  // A sanity check, not tuning (#68): the human proxy, in the real finale
  // (rivals and warlords and all), can kill the heart at low and high strength
  // on some seed. Stops at the first win.
  it.each([0, 10])('the heart can be beaten at strength %i', (strength) => {
    const win = [0, 1, 2, 3, 4, 5].find((seed) => {
      const { run, setup } = finale(seed, strength);
      const w = createWorld(setup);
      const proxy = new Proxy(run.color, { skill: 1 });
      while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
        step(w, proxy.think(w));
        w.fx = [];
        w.deaths = [];
      }
      return w.winReason === 'heart' && w.winnerTeam === w.teamOf[run.color];
    });
    expect(win).toBeDefined();
  }, 240_000);
});
