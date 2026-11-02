import { describe, expect, it } from 'vitest';
import { keyNests, nodeSetup } from '../src/campaign/battle';
import { newRun, type RunState } from '../src/campaign/run';
import { KEYS, Kind, NEUTRAL, SURGE, TICK_HZ } from '../src/sim/constants';
import { generateMap } from '../src/sim/mapgen';
import { createWorld, mapParamsOf } from '../src/sim/setup';
import { dominationStatus, step } from '../src/sim/step';
import { removeUnit, spawnUnit, type World } from '../src/sim/world';

// Conquest and Domination play differently (#87): key nests, and a late Bloom surge.

function nodeOf(kind: 'domination' | 'conquest'): [RunState, number] {
  for (let k = 0; ; k++) {
    const run = newRun(`objectives-${k}`, 0, 'swarm', 0);
    const n = run.nodes.find((o) => o.kind === kind && o.domain === undefined && o.rivals >= 2);
    if (n) return [run, n.id];
  }
}

/** Clear every unit, so only what the test does moves the nests. */
function empty(w: World): void {
  for (let i = w.n - 1; i >= 0; i--) if (w.alive[i]) removeUnit(w, i);
}

function run(w: World, ticks: number): void {
  for (let t = 0; t < ticks && !w.over; t++) {
    step(w, []);
    w.fx = [];
  }
}

describe('key nests (#87)', () => {
  it('a Domination node has two or three key nests: neutral, apart, away from the starts, with doubled guards', () => {
    const [r, id] = nodeOf('domination');
    const setup = nodeSetup(r, id);
    expect(setup.keys).toBe(keyNests(r.nodes[id].rivals));
    const map = generateMap(mapParamsOf(setup));
    const plain = generateMap({ ...mapParamsOf(setup), keys: undefined });
    const keys = map.nests.map((n, i) => ({ n, i })).filter((k) => k.n.key);
    expect(keys.length).toBe(setup.keys);
    const caps = map.nests.filter((n) => n.player >= 0);
    for (const { n, i } of keys) {
      expect(n.player).toBe(-1);
      expect(n.garrison).toBe(Math.round(plain.nests[i].garrison * KEYS.garrison));
      for (const o of keys) if (o.n !== n) expect(Math.hypot(o.n.x - n.x, o.n.y - n.y)).toBeGreaterThanOrEqual(KEYS.apart);
    }
    // Further from the starts than the typical neutral nest.
    const fromStarts = (n: { x: number; y: number }) => Math.min(...caps.map((c) => Math.hypot(c.x - n.x, c.y - n.y)));
    const neutrals = map.nests.filter((n) => n.player < 0 && !n.key).map(fromStarts).sort((a, b) => a - b);
    for (const { n } of keys) expect(fromStarts(n)).toBeGreaterThan(neutrals[neutrals.length >> 1]);
    expect(nodeSetup(...nodeOf('conquest')).keys).toBeUndefined();
  });

  it('a key nest is sealed at the start: an army on it takes nothing until the seal opens', () => {
    const [r, id] = nodeOf('domination');
    const w = createWorld(nodeSetup(r, id));
    const key = w.nests[w.keys[0]];
    empty(w);
    // Park a player-0 army on it.
    const me = w.factions.findIndex((f) => f.human);
    for (let k = 0; k < 30; k++) spawnUnit(w, me, Kind.Dot, key.x + (k % 6) * 4 - 10, key.y + Math.floor(k / 6) * 4 - 10, key.x, key.y, 0);
    expect(w.keySealUntil).toBe(KEYS.seal);
    run(w, KEYS.seal - 10);
    expect(key.owner === me && key.control > 0).toBe(false);
  });

  it('holding every key nest counts down to a win, pauses while one is contested, and resets if one falls', () => {
    const [r, id] = nodeOf('domination');
    const w = createWorld(nodeSetup(r, id));
    const me = w.factions.findIndex((f) => f.human);
    empty(w);
    w.keySealUntil = 0;
    const keys = w.keys.map((k) => w.nests[k]);
    for (const n of keys) Object.assign(n, { owner: me, controller: me, control: 1 });
    run(w, 5 * TICK_HZ);
    const ds = dominationStatus(w)!;
    expect(ds).toMatchObject({ team: w.teamOf[me], keys: true, need: keys.length, toBreak: 1 });
    expect(ds.left).toBeLessThan(KEYS.ticks);
    expect(ds.paused).toBe(false);
    // A rival on a key nest contests it: the countdown pauses.
    const rival = w.factions.findIndex((f, i) => f.active && i !== me && i !== NEUTRAL);
    for (let k = 0; k < 6; k++) spawnUnit(w, rival, Kind.Dot, keys[0].x + k * 3, keys[0].y, keys[0].x, keys[0].y, 0);
    for (let k = 0; k < 6; k++) spawnUnit(w, me, Kind.Dot, keys[0].x - k * 3, keys[0].y, keys[0].x, keys[0].y, 0);
    run(w, 15);
    const held = w.domTicks[w.teamOf[me]];
    run(w, 2 * TICK_HZ);
    if (keys[0].contested) {
      expect(dominationStatus(w)!.paused).toBe(true);
      expect(w.domTicks[w.teamOf[me]]).toBe(held);
    }
    empty(w);
    // One falls: reset.
    Object.assign(keys[0], { owner: -1, control: 0 });
    run(w, 30);
    expect(w.domTicks[w.teamOf[me]]).toBe(0);
    // Hold again, uncontested, for the whole countdown: a win.
    Object.assign(keys[0], { owner: me, control: 1 });
    run(w, KEYS.ticks + 30);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(w.teamOf[me]);
    expect(w.winReason).toBe('domination');
  });
});

describe("Conquest's late Bloom surge (#87)", () => {
  it('warns, then sends growing waves of Bloom swarms from the edges, every SURGE.every seconds', () => {
    const [r, id] = nodeOf('conquest');
    const setup = nodeSetup(r, id);
    expect(setup.surge).toBeDefined();
    const w = createWorld(setup);
    const s = w.bloomSurge!;
    expect(s.next).toBe(SURGE.after * TICK_HZ);
    let warned = 0;
    const waves: number[] = [];
    const watch = (ticks: number) => {
      for (let t = 0; t < ticks; t++) {
        step(w, []);
        for (const e of w.fx) {
          if (e.type === 'surgeWarn') warned = w.tick;
          if (e.type === 'bloomSurge') waves.push(e.r);
        }
        w.fx = [];
      }
    };
    // Keep the battle going: nobody wins in the meantime.
    w.domShare = 2;
    watch(s.next + 1 - w.tick);
    expect(warned).toBeGreaterThan(0);
    expect(SURGE.after * TICK_HZ - warned).toBeGreaterThanOrEqual(SURGE.warn * TICK_HZ - 1);
    expect(waves.length).toBe(SURGE.swarms);
    watch(SURGE.every * TICK_HZ);
    expect(waves.length).toBe(2 * SURGE.swarms);
    expect(waves[SURGE.swarms]).toBeGreaterThan(waves[0]);
  });
});
