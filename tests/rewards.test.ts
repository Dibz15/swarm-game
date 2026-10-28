import { describe, expect, it } from 'vitest';
import { REWARD, REWARDS } from '../src/campaign/rewards';
import { resolveDamage } from '../src/sim/combat';
import { applyCommand, novaRadius } from '../src/sim/commands';
import { Kind, NestType, POWER, TRAITS, UNIT_STATS } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { bastionRange, supplyCap } from '../src/sim/nests';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { World, spawnUnit, type Nest } from '../src/sim/world';

/** An empty field with the human (0) against one rival (1), no nests. */
function arena(reward?: string): World {
  const w = new World(5, 1600, 1600);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  if (reward) REWARD[reward].apply(w.factions[0].mods);
  return w;
}

const put = (w: World, owner: number, kind: number, x: number, y: number, tough = false) => {
  const i = spawnUnit(w, owner, kind, x, y, x, y, 6);
  if (tough) w.hp[i] = 1e6;
  return i;
};
const freeze = (w: World) => w.factions.forEach((f) => f.mods.kind.forEach((k) => (k.speed = 0)));
const run = (w: World, ticks: number) => {
  for (let t = 0; t < ticks; t++) step(w, []);
};

/** A stand-in nest (enough for powers, lockdown and the Bastion range). */
const fakeNest = (o: Partial<Nest>): Nest =>
  ({ id: 0, x: 0, y: 0, r: 30, type: NestType.Hive, owner: 0, level: 1, control: 1, controller: 0, lockedUntil: 0, capital: false, ...o }) as Nest;

/** A real map with two humans (no bots), units cleared. */
function mapWorld(reward?: string): World {
  const setup: MatchSetup = {
    seed: 21,
    size: 'small',
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: 1, human: true },
    ],
  };
  const w = createWorld(setup);
  if (reward) REWARD[reward].apply(w.factions[0].mods);
  return w;
}

// Probes: one number each, measured with and without the reward.
const hp = (kind: number) => (w: World) => w.hp[put(w, 0, kind, 800, 800)];
const speed = (kind: number) => (w: World) => {
  const i = spawnUnit(w, 0, kind, 200, 800, 1400, 800, 6);
  run(w, 20);
  return w.x[i] - 200;
};
/** Damage a frozen attacker deals a tough target `at` × its range away, over a second. */
const damage = (kind: number, at = 0.8) => (w: World) => {
  freeze(w);
  put(w, 0, kind, 800, 800, true);
  const t = put(w, 1, Kind.Tank, 800 + UNIT_STATS[kind].range * at, 800, true);
  run(w, 20);
  return 1e6 - w.hp[t];
};

const PROBES: Record<string, [string, (w: World) => number, 'more' | 'less'][]> = {
  frenzy: [
    [
      'pack damage',
      (w) => {
        freeze(w);
        for (let k = 0; k < 6; k++) put(w, 0, Kind.Dot, 800 + (k % 3) * 5, 800 + Math.floor(k / 3) * 5, true);
        const t = put(w, 1, Kind.Tank, 820, 803, true);
        run(w, 20);
        return 1e6 - w.hp[t];
      },
      'more',
    ],
  ],
  lean: [
    ['speed', speed(Kind.Dot), 'more'],
    ['HP', hp(Kind.Dot), 'less'],
  ],
  'thick-hide': [
    ['HP', hp(Kind.Dot), 'more'],
    ['speed', speed(Kind.Dot), 'less'],
  ],
  plated: [['HP', hp(Kind.Tank), 'more']],
  bulwark: [
    [
      'draws fire',
      (w) => {
        freeze(w);
        const a = put(w, 1, Kind.Dot, 800, 800, true);
        // Default: the closer Swarmer is the better target; Bulwark tips it to the Shield.
        put(w, 0, Kind.Dot, 815, 800, true);
        const shield = put(w, 0, Kind.Tank, 800 - Math.sqrt(225 / 0.8 / (TRAITS.taunt * TRAITS.taunt)), 800, true);
        run(w, 8);
        return w.tgt[a] === shield ? 1 : 0;
      },
      'more',
    ],
  ],
  barbed: [
    [
      'splash reach',
      (w) => {
        freeze(w);
        const r = UNIT_STATS[Kind.Lancer].range;
        put(w, 0, Kind.Lancer, 800, 800, true);
        put(w, 1, Kind.Tank, 800 + r * 0.8, 800, true);
        const s = put(w, 1, Kind.Tank, 800 + r * 0.8 + TRAITS.pierce.radius * 1.2, 800, true);
        run(w, 20);
        return 1e6 - w.hp[s];
      },
      'more',
    ],
  ],
  longshot: [
    ['damage beyond base range', damage(Kind.Lancer, 1.1), 'more'],
    ['damage in range', damage(Kind.Lancer), 'less'],
  ],
  quickdraw: [['damage', damage(Kind.Lancer), 'more']],
  saboteur: [['Raider capture', (w) => capture(w, Kind.Swift), 'more']],
  fleet: [['speed', speed(Kind.Swift), 'more']],
  'heavy-shell': [
    [
      'Barrage damage',
      (w) => {
        const ts: number[] = [];
        for (let k = 0; k < 30; k++) ts.push(put(w, 1, Kind.Tank, 790 + (k % 6) * 4, 790 + Math.floor(k / 6) * 4, true));
        w.barrages.push({ x: 800, y: 800, owner: 0, impact: w.tick + 1, r: POWER.barrageRadius, x0: 600, y0: 600, t0: w.tick });
        run(w, 2);
        return ts.reduce((s, t) => s + 1e6 - w.hp[t], 0);
      },
      'more',
    ],
  ],
  wide: [
    ['Nova reach', (w) => nova(w, 1.1), 'more'],
    ['Nova damage', (w) => nova(w, 0.2), 'less'],
  ],
  overdrive: [
    [
      'Surge duration',
      (w) => {
        const s = surge(w);
        return w.surge[s] - w.tick;
      },
      'more',
    ],
    [
      'Surge cost',
      (w) => {
        surge(w);
        return 100 - w.factions[0].energy;
      },
      'less',
    ],
  ],
  'long-jump': [
    [
      'Blink distance',
      (w) => {
        w.nests.push(fakeNest({ type: NestType.Swift }));
        w.factions[0].energy = 100;
        const i = put(w, 0, Kind.Dot, 200, 800);
        w.grid.build(w);
        applyCommand(w, { t: 'blink', p: 0, units: [w.uid[i]], x: 1500, y: 800 } as never);
        return w.x[i] - 200;
      },
      'more',
    ],
  ],
  root: [
    [
      'fortified movement',
      (w) => {
        const i = spawnUnit(w, 0, Kind.Dot, 200, 800, 1400, 800, 6);
        w.fortify[i] = 1e9;
        run(w, 20);
        return w.x[i] - 200;
      },
      'less',
    ],
    [
      'fortified damage taken',
      (w) => {
        const i = put(w, 0, Kind.Tank, 800, 800);
        w.fortify[i] = 1e9;
        w.dmg[i] = 10;
        resolveDamage(w);
        return UNIT_STATS[Kind.Tank].hp - w.hp[i];
      },
      'less',
    ],
  ],
  long: [
    [
      'Lockdown duration',
      (w) => {
        w.nests.push(fakeNest({ id: 0, type: NestType.Bastion }), fakeNest({ id: 1, owner: 1, controller: 1, x: 900, y: 900 }));
        w.factions[0].energy = 100;
        applyCommand(w, { t: 'lockdown', p: 0, nest: 1 } as never);
        return w.nests[1].lockedUntil - w.tick;
      },
      'more',
    ],
  ],
  capital: [
    [
      'capital level',
      (w) => {
        const mods = w.factions[0].mods;
        const s = createWorld({ seed: 9, size: 'small', players: [{ faction: 0, team: 0, human: true, mods }, { faction: 1, team: 1, human: true }] });
        return s.nests.find((n) => n.owner === 0 && n.capital)!.level;
      },
      'more',
    ],
  ],
  'bastion-range': [['Bastion range', (w) => bastionRange(w, fakeNest({ type: NestType.Bastion })), 'more']],
  supply: [['supply cap', (w) => (w.nests.length ? supplyCap(w, 0) : 0), 'more']],
  crystals: [
    [
      'crystal energy',
      (w) => {
        w.crystals.push({ x: 800, y: 800, r: 30, holder: -1, last: -1 });
        put(w, 0, Kind.Dot, 800, 800, true);
        put(w, 1, Kind.Dot, 200, 200, true);
        run(w, 60);
        return w.factions[0].energy;
      },
      'more',
    ],
  ],
  energy: [
    [
      'energy income',
      (w) => {
        put(w, 0, Kind.Dot, 800, 800, true);
        put(w, 1, Kind.Dot, 200, 200, true);
        run(w, 60);
        return w.factions[0].energy;
      },
      'more',
    ],
  ],
  capture: [['capture', (w) => capture(w, Kind.Dot), 'more']],
  glass: [
    ['HP', hp(Kind.Dot), 'less'],
    ['damage', damage(Kind.Dot), 'more'],
  ],
};

/** Probes that need a real map (nests). */
const NEEDS_MAP = new Set(['saboteur', 'capture', 'supply']);

function modsOf(id: string) {
  const w = arena(id);
  return w.factions[0].mods;
}

/** Control a lone unit of `kind` builds on an empty, unowned nest in a second. */
function capture(w: World, kind: number): number {
  for (let i = 0; i < w.n; i++) w.alive[i] = 0;
  w.free.length = 0;
  w.n = 0;
  const n = w.nests.find((o) => !o.capital)!;
  Object.assign(n, { owner: -1, controller: -1, control: 0, garrison: 0 });
  freeze(w);
  put(w, 0, kind, n.x, n.y, true);
  run(w, 30);
  return n.controller === 0 || n.owner === 0 ? n.control : 0;
}

function nova(w: World, at: number): number {
  w.factions[0].energy = 100;
  const us = [0, 1, 2, 3, 4, 5].map((k) => put(w, 0, Kind.Dot, 800 + k, 800));
  const t = put(w, 1, Kind.Tank, 800 + novaRadius(6) * at, 800, true);
  w.grid.build(w);
  applyCommand(w, { t: 'nova', p: 0, units: us.map((i) => w.uid[i]) } as never);
  return w.dmg[t];
}

function surge(w: World): number {
  w.factions[0].energy = 100;
  const i = put(w, 0, Kind.Dot, 800, 800);
  w.grid.build(w);
  applyCommand(w, { t: 'surge', p: 0, units: [w.uid[i]] } as never);
  return i;
}

describe('rewards change the sim (#64)', () => {
  it('every reward with a sim effect has a probe', () => {
    const runLevel = ['hunger', 'lone-wolf'];
    expect(REWARDS.length).toBe(25);
    expect(REWARDS.map((r) => r.id).filter((id) => !runLevel.includes(id)).sort()).toEqual(Object.keys(PROBES).sort());
  });

  for (const [id, probes] of Object.entries(PROBES)) {
    for (const [what, probe, dir] of probes) {
      it(`${REWARD[id].name}: ${what} goes ${dir === 'more' ? 'up' : 'down'}`, () => {
        const make = NEEDS_MAP.has(id) ? mapWorld : arena;
        const base = probe(make());
        const withIt = probe(make(id));
        if (dir === 'more') expect(withIt).toBeGreaterThan(base);
        else expect(withIt).toBeLessThan(base);
      });
    }
  }

  it('a match with rewards is deterministic', () => {
    const setup = (): MatchSetup => ({
      seed: 33,
      size: 'small',
      players: [
        { faction: 0, team: 0, human: false, bot: { difficulty: 2, personality: 'rusher' }, mods: modsOf('glass') },
        { faction: 1, team: 1, human: false, bot: { difficulty: 2, personality: 'expander' } },
      ],
    });
    const a = createWorld(setup());
    const b = createWorld(setup());
    run(a, 600);
    run(b, 600);
    expect(worldHash(a)).toBe(worldHash(b));
  });
});
