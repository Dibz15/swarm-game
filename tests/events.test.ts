import { describe, expect, it } from 'vitest';
import { ENERGY, EVENTS, Kind, NEUTRAL, NestType, TICK_HZ } from '../src/sim/constants';
import { initEvents } from '../src/sim/events';
import { worldHash } from '../src/sim/hash';
import { EVENT_PRESETS, type EventParams } from '../src/sim/mapgen';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { spawnUnit, WILD_COLOSSUS, WILD_SWARM, World } from '../src/sim/world';
import { botMatch } from './helpers';

const NONE: EventParams = { swarm: null, drop: null, colossus: [], regrow: 0 };
const TICK1 = 1 / TICK_HZ; // fires on the first step

function arena(params: Partial<EventParams>): World {
  const w = new World(3, 800, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  initEvents(w, {
    params: { ...NONE, ...params },
    swarmSpawns: [[400, 470]],
    dropSpots: [[400, 250]],
    colossusPaths: [[[60, 250], [400, 250], [740, 250]]],
  });
  return w;
}

function nest(w: World, type: number, owner: number, x: number, y: number) {
  w.nests.push({
    id: w.nests.length, x, y, r: 26, type, owner, level: 1, control: owner < 0 ? 0 : 1, controller: owner, spawnAcc: 0,
    rallyX: x, rallyY: y, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0,
  });
  return w.nests[w.nests.length - 1];
}

function blob(w: World, f: number, kind: number, n: number, x: number, y: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(spawnUnit(w, f, kind, x + (k % 6) * 6, y + Math.floor(k / 6) * 6, x, y, 30));
  return out;
}

describe('living map', () => {
  it('Off means no events and no wild units', () => {
    const w = createWorld({ ...botMatch(21), events: 'off' });
    expect(w.events).toBeNull();
    for (let t = 0; t < 4 * 60 * TICK_HZ; t++) step(w, []);
    for (let i = 0; i < w.n; i++) expect(w.wild[i]).toBe(0);
  });

  it('Wild events on heavy terrain replay identically', () => {
    const run = () => {
      const w = createWorld({ ...botMatch(808), terrain: 'heavy', events: 'wild' });
      let swarms = 0;
      for (let t = 0; t < 4 * 60 * TICK_HZ && !w.over; t++) {
        step(w, []);
        swarms += w.fx.filter((e) => e.type === 'swarmSpawn').length;
        w.fx = [];
      }
      return { h: worldHash(w), swarms };
    };
    const a = run(), b = run();
    expect(a.h).toBe(b.h);
    expect(a.swarms).toBeGreaterThan(0);
  });

  it('a wild swarm hunts the bigger army', () => {
    const w = arena({ swarm: { first: TICK1, every: 999, size: 12 } });
    blob(w, 0, Kind.Dot, 30, 150, 250);
    blob(w, 1, Kind.Dot, 6, 650, 250);
    step(w, []);
    const sw = w.events!.swarms[0];
    expect(sw.uids.length).toBe(12);
    expect(sw.tx).toBeLessThan(300);
    expect(w.wild[w.uidToSlot.get(sw.uids[0])!]).toBe(WILD_SWARM);
  });

  it('a supply drop pays energy and an upgrade to its sole holder (not the army leader)', () => {
    const w = arena({ drop: { first: TICK1, every: 999 } });
    const n = nest(w, NestType.Hive, 0, 100, 100);
    blob(w, 0, Kind.Dot, 8, 390, 245);
    blob(w, 1, Kind.Dot, 50, 680, 420); // the bigger army, far away
    let taken = false;
    for (let t = 0; t < EVENTS.dropTelegraph + 25 * TICK_HZ && !taken; t++) {
      step(w, []);
      taken = w.fx.some((e) => e.type === 'dropTaken');
      w.fx = [];
    }
    expect(taken).toBe(true);
    expect(n.level).toBe(2);
    expect(w.factions[0].energy).toBeGreaterThan(EVENTS.dropEnergy);
    expect(w.events!.drops.length).toBe(0);
  });

  it('nobody scores a drop while it is contested', () => {
    const w = arena({ drop: { first: TICK1, every: 999 } });
    // Tanks barely hurt each other in this window; both stand on the drop.
    blob(w, 0, Kind.Tank, 4, 380, 250);
    blob(w, 1, Kind.Tank, 4, 410, 250);
    for (let t = 0; t < EVENTS.dropTelegraph + 4 * TICK_HZ; t++) step(w, []);
    expect(w.events!.drops[0].progress).toBe(0);
  });

  it('the Colossus rewards whoever lands the killing blow', () => {
    const w = arena({ colossus: [TICK1] });
    const n = nest(w, NestType.Hive, 0, 100, 450);
    blob(w, 1, Kind.Dot, 4, 700, 60); // keep the match alive
    step(w, []);
    const c = w.events!.colossi[0];
    const s = w.uidToSlot.get(c.uid)!;
    expect(w.wild[s]).toBe(WILD_COLOSSUS);
    w.hp[s] = 5;
    blob(w, 0, Kind.Lancer, 6, w.x[s] + 30, w.y[s]);
    let down = false;
    for (let t = 0; t < 5 * TICK_HZ && !down; t++) {
      step(w, []);
      down = w.fx.some((e) => e.type === 'colossusDown' && e.f === 0);
      w.fx = [];
    }
    expect(down).toBe(true);
    expect(w.factions[0].energy).toBeGreaterThan(ENERGY.max - 5);
    expect(n.level).toBe(2);
  });

  it('neutral nests regrow their guards, and abandoned nests go wild', () => {
    const w = arena({ regrow: 1 });
    blob(w, 0, Kind.Dot, 2, 700, 60);
    blob(w, 1, Kind.Dot, 2, 700, 440);
    const guarded = nest(w, NestType.Hive, NEUTRAL, 200, 250);
    guarded.garrison = 5;
    const empty = nest(w, NestType.Spire, -1, 550, 250);
    for (let t = 0; t < 8 * TICK_HZ; t++) step(w, []);
    let guards = 0;
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === NEUTRAL && Math.hypot(w.x[i] - 200, w.y[i] - 250) < 60) guards++;
    expect(guards).toBe(5);
    expect(empty.owner).toBe(-1);
    for (let t = 0; t < EVENTS.revertAfter; t++) step(w, []);
    expect(empty.owner).toBe(NEUTRAL);
  });

  it('presets order from calm to wild', () => {
    expect(EVENT_PRESETS.calm.swarm!.every).toBeGreaterThan(EVENT_PRESETS.normal.swarm!.every);
    expect(EVENT_PRESETS.normal.swarm!.every).toBeGreaterThan(EVENT_PRESETS.wild.swarm!.every);
    expect(EVENT_PRESETS.wild.colossus.length).toBeGreaterThan(EVENT_PRESETS.normal.colossus.length);
  });
});
