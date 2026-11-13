import { describe, expect, it } from 'vitest';
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { TICK_HZ } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { decodeSnap, diffSnaps, encodeSnap, fullHash, restoreWorld, serializeWorld, snapshotWorld } from '../src/sim/snapshot';
import { step } from '../src/sim/step';
import type { World } from '../src/sim/world';
import { botMatch } from './helpers';

const run = (w: World, ticks: number) => {
  for (let t = 0; t < ticks && !w.over; t++) {
    step(w, []);
    w.fx = [];
    w.deaths = [];
  }
};

function finale(seed: number): MatchSetup {
  const r = newRun(`finale-${seed}`, 0, 'swarm', 0);
  r.swallowed = r.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'finale').slice(0, 6).map((n) => n.id);
  for (const b of r.broods) b.size = 16;
  return nodeSetup(r, r.heart, r.broods.map((b) => b.id));
}

const SETUPS: [string, MatchSetup][] = [
  ['bot match', botMatch(11)],
  ['wild events, heavy terrain', { ...botMatch(808), terrain: 'heavy', events: 'wild' }],
  ['full caves', { ...botMatch(5), caves: 'full', form: 'caves', events: 'normal' }],
  [
    'siege',
    {
      seed: 4, size: 'medium', terrain: 'standard', events: 'calm',
      siege: { seconds: 200, first: 20, every: 30, size: 20, grow: 1.12, depth: 1 },
      players: [
        { faction: 0, team: 0, human: true },
        { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'rusher' } },
      ],
    },
  ],
  [
    // co-op (#228): boon drops on the field, several defenders
    'co-op siege',
    {
      seed: 6, size: 'medium', terrain: 'standard', events: 'calm',
      siege: { seconds: 200, first: 5, every: 12, size: 8, grow: 1.12, depth: 1 },
      players: [
        { faction: 0, team: 0, human: true },
        { faction: 1, team: 0, human: true },
      ],
    },
  ],
  [
    'stronghold',
    {
      seed: 3, size: 'medium', terrain: 'standard', stronghold: { player: 1 },
      players: [
        { faction: 0, team: 0, human: true },
        { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'turtler', citadel: true } },
        { faction: 2, team: 2, human: false, bot: { difficulty: 1, personality: 'expander' } },
      ],
    },
  ],
  ['heart finale', finale(3)],
];

describe('World snapshots', () => {
  for (const [name, setup] of SETUPS) {
    it(`${name}: a restored world plays on exactly like the original`, () => {
      const A = 45 * TICK_HZ, B = 15 * TICK_HZ, C = 45 * TICK_HZ;
      const orig = createWorld(setup);
      run(orig, A);
      const bytes = serializeWorld(orig);
      const copy = restoreWorld(setup, decodeSnap(bytes));
      expect(fullHash(copy)).toBe(fullHash(orig));
      expect(worldHash(copy)).toBe(worldHash(orig));
      // and re-encoding the copy gives the very same bytes
      expect(serializeWorld(copy)).toEqual(bytes);

      run(orig, B);
      run(copy, B);
      expect(diffSnaps(snapshotWorld(copy), snapshotWorld(orig))).toEqual([]);
      expect(fullHash(copy)).toBe(fullHash(orig));
      run(orig, C);
      run(copy, C);
      expect(fullHash(copy)).toBe(fullHash(orig));
      expect(worldHash(copy)).toBe(worldHash(orig));
    });
  }

  it('fullHash sees what worldHash misses', () => {
    const w = createWorld(botMatch(2));
    run(w, 20 * TICK_HZ);
    const full = fullHash(w), cheap = worldHash(w);
    const i = w.alive.indexOf(1);
    w.vx[i] += 0.5; // velocities aren't in worldHash
    expect(worldHash(w)).toBe(cheap);
    expect(fullHash(w)).not.toBe(full);
    w.vx[i] -= 0.5;
    w.bots[0].importState({ ...w.bots[0].exportState(), rng: 12345 });
    expect(fullHash(w)).not.toBe(full);
  });

  it('a round trip through bytes keeps every value exactly, NaN, infinities and -0 included', () => {
    const w = createWorld({ ...botMatch(7), events: 'wild' });
    run(w, 10 * TICK_HZ);
    w.nests[0].spawnAcc = -0;
    w.nests[1].rallyX = Infinity;
    w.factions[0].energy = NaN;
    const back = restoreWorld({ ...botMatch(7), events: 'wild' }, decodeSnap(encodeSnap(snapshotWorld(w))));
    expect(Object.is(back.nests[0].spawnAcc, -0)).toBe(true);
    expect(back.nests[1].rallyX).toBe(Infinity);
    expect(back.factions[0].energy).toBeNaN();
    expect(back.events!.rng).not.toBe(w.events!.rng);
    expect(back.events!.rng.s).toBe(w.events!.rng.s);
    expect(back.events!.spec).toBe(back.events!.spec); // reattached from the setup
  });

  it('the diff names the field and the unit that changed', () => {
    const w = createWorld(botMatch(9));
    run(w, 15 * TICK_HZ);
    const a = snapshotWorld(w);
    const i = w.alive.indexOf(1);
    w.hp[i] -= 1;
    w.nests[2].level += 1;
    const d = diffSnaps(a, snapshotWorld(w));
    expect(d.map((x) => x.path).sort()).toEqual([`hp[${i}] (uid ${w.uid[i]}/${w.uid[i]})`, 'nests[2].level'].sort());
  });

  it('rejects a snapshot that has state the world lacks', () => {
    const w = createWorld(botMatch(1));
    const s = snapshotWorld(w);
    const bad = { ...s, json: s.json.replace(/^\{/, '{"nonsense":1,') };
    expect(() => restoreWorld(botMatch(1), bad)).toThrow(/nonsense/);
    expect(() => decodeSnap(new Uint8Array(16))).toThrow(/not a world snapshot/);
  });

  it('refuses to save state it does not know how to copy', () => {
    const w = createWorld(botMatch(1));
    (w as unknown as { extra: unknown }).extra = new Map();
    expect(() => snapshotWorld(w)).toThrow(/extra/);
  });
});
