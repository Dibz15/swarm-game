import { describe, expect, it } from 'vitest';
import { hasPower } from '../src/sim/commands';
import { ALL_NEST_TYPES, Kind, NestType, TICK_HZ } from '../src/sim/constants';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';

const setup = (human: Partial<MatchSetup['players'][number]>): MatchSetup => ({
  seed: 77,
  size: 'small',
  players: [
    { faction: 0, team: 0, human: true, ...human },
    { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'turtler' } },
  ],
});

const count = (w: ReturnType<typeof createWorld>, owner: number, kind: number) => {
  let n = 0;
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === owner && w.kind[i] === kind) n++;
  return n;
};

describe('campaign battle rules', () => {
  it('a starting army replaces the default Swarmers, with veterans', () => {
    const w = createWorld(setup({ army: [{ kind: Kind.Dot, count: 7 }, { kind: Kind.Tank, count: 5, vet: true }] }));
    expect(count(w, 0, Kind.Dot)).toBe(7);
    expect(count(w, 0, Kind.Tank)).toBe(5);
    let vets = 0;
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 0 && w.vet[i]) vets++;
    expect(vets).toBe(5);
    // The rival keeps the default army.
    expect(count(w, 1, Kind.Dot)).toBe(10);
  });

  it('a locked nest type spawns Swarmers and grants no power', () => {
    const w = createWorld(setup({ nestTypes: 1 << NestType.Hive }));
    expect(w.factions[0].nestTypes).toBe(1 << NestType.Hive);
    expect(w.factions[1].nestTypes).toBe(ALL_NEST_TYPES);
    // Hand the human a Forge and let it produce.
    const forge = w.nests.find((n) => n.type === NestType.Forge)!;
    expect(forge).toBeDefined();
    Object.assign(forge, { owner: 0, controller: 0, control: 1, garrison: 0 });
    expect(hasPower(w, 0, 'fortify')).toBe(false);
    const tanks = count(w, 0, Kind.Tank);
    for (let t = 0; t < 12 * TICK_HZ; t++) step(w, []);
    expect(count(w, 0, Kind.Tank)).toBe(tanks);
    w.factions[0].nestTypes = ALL_NEST_TYPES;
    if (forge.owner === 0) expect(hasPower(w, 0, 'fortify')).toBe(true);
  });
});
