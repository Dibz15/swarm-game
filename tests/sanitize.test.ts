import { describe, expect, it } from 'vitest';
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { LocalSession } from '../src/game/session';
import { applyCommand, type Command } from '../src/sim/commands';
import { FACTION_UNIT_CAP, POWER_NEST } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { POWER_LOCK } from '../src/sim/mods';
import { Rng } from '../src/sim/rng';
import { quantizeCommand, sanitizeCommand } from '../src/sim/sanitize';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { inArmy, type World } from '../src/sim/world';
import { botMatch } from './helpers';

const TYPES = ['move', 'rally', 'upgrade', 'surge', 'nova', 'fortify', 'barrage', 'blink', 'lockdown', 'summon', 'boon'];

/** p's army slots. */
const army = (w: World, p: number) => {
  const out: number[] = [];
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === p && inArmy(w, i)) out.push(i);
  return out;
};

/** Give p every nest power: a fully held nest of each power's type. */
function grantPowers(w: World, p: number): void {
  const types = Object.values(POWER_NEST);
  let k = 0;
  for (const n of w.nests) {
    if (n.capital || k >= types.length) continue;
    n.type = types[k++];
    n.owner = p;
    n.control = 1;
  }
}

/** Something a hostile or broken peer might send. */
function garbage(w: World, rng: Rng): unknown {
  const uids = () => {
    const live: number[] = [];
    for (let i = 0; i < w.n; i++) if (w.alive[i]) live.push(w.uid[i]);
    return live;
  };
  const num = (): unknown =>
    rng.pick<unknown>([NaN, Infinity, -Infinity, 1e308, -1e308, -5, 0.5, 2.5, '__proto__', null, undefined, {}, [], '12', w.width + 999, rng.range(0, w.width), rng.range(0, w.height)]);
  const list = (): unknown => {
    const live = uids();
    const some = () => Array.from({ length: 1 + rng.int(40) }, () => live[rng.int(live.length)] ?? 0);
    switch (rng.int(7)) {
      case 0:
        return rng.pick<unknown>([5, 'abc', null, undefined, { length: 3, 0: 1 }, NaN]);
      case 1: // huge, repeating
        return Array.from({ length: FACTION_UNIT_CAP * 5 }, (_, k) => live[k % Math.max(1, live.length)] ?? k);
      case 2: {
        const s = some();
        return [...s, ...s, ...s];
      }
      case 3:
        return [...some(), NaN, Infinity, -1, 1.5, '7', null, {}, -0];
      case 4:
        return live; // everyone, every faction's units
      default:
        return some();
    }
  };
  const nest = (): unknown => rng.pick<unknown>([-1, -100, w.nests.length, w.nests.length + 5, 1.5, NaN, '0', null, rng.int(w.nests.length)]);
  const c: Record<string, unknown> = {
    t: rng.pick<unknown>([...TYPES, ...TYPES, 'nuke', '__proto__', 'toString', undefined, 7]),
    p: rng.pick<unknown>([0, 1, 2, 3, 0, 1, 6, 6, -1, 1.5, NaN, '0', 7, undefined]),
    units: list(),
    nests: rng.int(4) ? Array.from({ length: rng.int(5) }, nest) : list(),
    nest: nest(),
    x: num(),
    y: num(),
    secs: num(),
    k: rng.pick<unknown>([0, 1, 2, 3, -1, 0.5, NaN, '__proto__', 'constructor', 'length', null]),
  };
  if (rng.int(10) === 0) return rng.pick<unknown>([null, undefined, 5, 'move', [], { t: 'move' }]);
  return c;
}

/** Bots play while garbage pours in; returns the hash after every tick. */
function fuzz(seed: number, ticks: number): number[] {
  const w = createWorld(botMatch(seed, 4, 'small'));
  w.endless = true; // so summon isn't dropped for that alone, and nobody wins mid-fuzz
  for (let p = 0; p < 4; p++) grantPowers(w, p);
  const rng = new Rng(seed ^ 0x5eed);
  const hashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    for (let p = 0; p < 4; p++) w.factions[p].energy = 100;
    const cmds = Array.from({ length: 1 + rng.int(6) }, () => garbage(w, rng)) as Command[];
    expect(() => step(w, cmds)).not.toThrow();
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i]) continue;
      if (!Number.isFinite(w.x[i] + w.y[i] + w.ox[i] + w.oy[i])) throw new Error(`NaN unit ${i} at tick ${w.tick}`);
    }
    for (const n of w.nests) expect(Number.isFinite(n.rallyX + n.rallyY)).toBe(true);
    expect(Number.isFinite(w.events?.nextSwarm ?? 0)).toBe(true);
    hashes.push(worldHash(w));
  }
  return hashes;
}

describe('untrusted commands (#154)', () => {
  it('garbage never throws, never puts NaN in the world, and replays to the same hash', () => {
    for (const seed of [3, 11]) {
      const a = fuzz(seed, 300);
      expect(fuzz(seed, 300)).toEqual(a);
    }
  });

  it('boon garbage never reaches the siege boons', () => {
    const w = createWorld({
      seed: 4,
      size: 'medium',
      terrain: 'standard',
      events: 'calm',
      siege: { seconds: 200, first: 20, every: 30, size: 20, grow: 1.12, depth: 1 },
      players: [
        { faction: 0, team: 0, human: true },
        { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'rusher' } },
      ],
    });
    const sg = w.siege!;
    for (const k of ['__proto__', 'constructor', NaN, 3, -1, 0.5, null]) {
      sg.offer = { ids: ['energy', 'production', 'levels'], until: w.tick + 1000 };
      applyCommand(w, { t: 'boon', p: 0, k } as never);
      expect(sg.offer).not.toBeNull();
    }
    expect(sg.boons).toEqual([]);
    applyCommand(w, { t: 'boon', p: 0, k: 1 });
    expect(sg.boons).toEqual(['production']);
  });

  it('cleans lists and coordinates, without touching what it was given', () => {
    const w = createWorld(botMatch(5));
    const raw = { t: 'blink', p: 0, units: [3, 1, 3, 2.5, NaN, 1, '4', 2], x: -50, y: w.height + 50, extra: 'x' };
    const before = structuredClone(raw);
    expect(sanitizeCommand(w, raw)).toEqual({ t: 'blink', p: 0, units: [3, 1, 2], x: 0, y: w.height });
    expect(raw).toEqual(before);
    expect(sanitizeCommand(w, { t: 'surge', p: 0, units: Array.from({ length: 5000 }, (_, k) => k) })).toMatchObject({ units: { length: FACTION_UNIT_CAP } });
    expect(sanitizeCommand(w, { t: 'move', p: 0, units: [1], x: 10, y: 10, nest: 999 })).toMatchObject({ nest: -1 });
    expect(sanitizeCommand(w, { t: 'move', p: 0, units: [1], x: NaN, y: 10, nest: 0 })).toBeNull();
    expect(sanitizeCommand(w, { t: 'upgrade', p: 0, nest: 999 })).toBeNull();
    expect(sanitizeCommand(w, { t: 'rally', p: 0, nests: [0, 999], x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand(w, { t: 'surge', p: 6, units: [1] })).toBeNull();
    expect(sanitizeCommand(w, { t: 'summon', p: 0, secs: 3 })).toBeNull(); // not an endless world
    w.endless = true;
    expect(sanitizeCommand(w, { t: 'summon', p: 0, secs: 1e9 })).toEqual({ t: 'summon', p: 0, secs: 600 });
    expect(sanitizeCommand(w, { t: 'summon', p: 0, secs: NaN })).toBeNull();
  });

  it('honest commands keep their meaning', () => {
    const w = createWorld(botMatch(5));
    const cmds: Command[] = [
      { t: 'move', p: 1, units: [4, 5, 6], x: 100.25, y: 200, nest: -1 },
      { t: 'move', p: 1, units: [4], x: 0, y: 0, nest: 2 },
      { t: 'rally', p: 2, nests: [0, 1], x: 5, y: 6 },
      { t: 'upgrade', p: 0, nest: 0 },
      { t: 'nova', p: 3, units: [9, 8, 7, 6] },
      { t: 'barrage', p: 0, x: w.width, y: 0 },
      { t: 'lockdown', p: 0, nest: 1 },
    ];
    for (const c of cmds) expect(sanitizeCommand(w, c)).toEqual(c);
  });

  for (const power of ['nova', 'blink'] as const) {
    it(`a ${power} with every uid sent three times does what the deduped one does`, () => {
      const run = (dup: boolean) => {
        const w = createWorld(botMatch(8, 2, 'small'));
        grantPowers(w, 0);
        for (let t = 0; t < 90; t++) step(w, []);
        w.factions[0].energy = 100;
        const uids = army(w, 0).slice(0, 12).map((s) => w.uid[s]);
        const units = dup ? [...uids, ...uids, ...uids] : uids;
        const s0 = army(w, 0)[0];
        const cmd: Command = power === 'nova' ? { t: 'nova', p: 0, units } : { t: 'blink', p: 0, units, x: w.x[s0] + 400, y: w.y[s0] };
        step(w, [cmd]);
        expect(w.factions[0].energy).toBeLessThan(100); // it was cast
        for (let t = 0; t < 30; t++) step(w, []);
        return worldHash(w);
      };
      expect(run(true)).toBe(run(false));
    });
  }

  it('the sim ignores a locked power', () => {
    const w = createWorld(botMatch(8, 2, 'small'));
    grantPowers(w, 0);
    for (let t = 0; t < 60; t++) step(w, []);
    const f = w.factions[0];
    f.mods.lockedPowers = POWER_LOCK.nova | POWER_LOCK.blink;
    const units = army(w, 0).map((s) => w.uid[s]);
    for (const c of [{ t: 'nova', p: 0, units }, { t: 'blink', p: 0, units, x: 100, y: 100 }] as Command[]) {
      f.energy = 100;
      const n = army(w, 0).length;
      applyCommand(w, c);
      expect(f.energy).toBe(100);
      expect(army(w, 0).length).toBe(n);
      expect(w.fx.some((e) => e.type === c.t)).toBe(false);
    }
    // Unlocked again, the same Nova goes off.
    f.mods.lockedPowers = 0;
    applyCommand(w, { t: 'nova', p: 0, units });
    expect(f.energy).toBeLessThan(100);
  });

  it('a campaign battle locks Nova in the sim until the run unlocks it', () => {
    const run = newRun('sanitize', 0, 'wall', 0);
    const id = run.nodes.findIndex((n, i) => i > 0 && n.kind === 'conquest');
    expect(run.unlocks.nova).toBe(false);
    const human = (s: ReturnType<typeof nodeSetup>) => s.players.find((p) => p.human)!;
    expect(human(nodeSetup(run, id)).mods!.lockedPowers & POWER_LOCK.nova).toBeTruthy();
    run.unlocks.nova = true;
    expect(human(nodeSetup(run, id)).mods!.lockedPowers).toBe(0);
  });
});

describe('quantized at issue time (#154)', () => {
  it('rounds x/y to 1/16 and leaves the rest alone', () => {
    expect(quantizeCommand({ t: 'barrage', p: 0, x: 100.03, y: 7.97 })).toEqual({ t: 'barrage', p: 0, x: 100, y: 8 });
    expect(quantizeCommand({ t: 'move', p: 0, units: [1], x: 1 / 3, y: 2, nest: -1 })).toEqual({ t: 'move', p: 0, units: [1], x: 0.3125, y: 2, nest: -1 });
    const c: Command = { t: 'nova', p: 0, units: [1] };
    expect(quantizeCommand(c)).toBe(c);
  });

  it('LocalSession logs and records the quantized command', () => {
    const s = new LocalSession(botMatch(2, 2, 'small'));
    const seen: Command[] = [];
    s.onIssue = (c) => seen.push(c);
    const order: Command = { t: 'move', p: 0, units: [1], x: 10.01, y: 20.99, nest: -1 };
    s.issue(order);
    s.update(0.05);
    expect(order.x).toBe(10.01);
    expect(seen[0]).toMatchObject({ x: 10, y: 21 });
    expect(s.log[0].cmd).toBe(seen[0]);
  });
});
