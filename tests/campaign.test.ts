import { describe, expect, it } from 'vitest';
import { CONQUEST_SHARE, armyFor, nodeSetup } from '../src/campaign/battle';
import { COST, MILITIA, MIN_SIZE, settleBroods, type BattleReport, type Brood } from '../src/campaign/broods';
import { MAP_H, MAP_W, grow, heal, hops, maxFielded, moves, newRun, rerollCost, rerollOffer, resolveTurn, skipReward, takeReward, unlock, unlocked, type RunState } from '../src/campaign/run';
import { REWARD, modsFor, rollOffer } from '../src/campaign/rewards';
import { Kind, NestType } from '../src/sim/constants';

const SEEDS = Array.from({ length: 60 }, (_, i) => `seed-${i}`);
const WIN: BattleReport = { won: true, survivors: [30, 12, 12, 12], nests: 6, seconds: 200 };
const LOSS: BattleReport = { won: false, survivors: [0, 0, 0, 0], nests: 0, seconds: 300 };

/** Walk the shortest open route to the heart, winning every battle. */
function rush(run: RunState): RunState {
  for (let guard = 0; guard < 60 && run.status === 'active'; guard++) {
    const back = hops(run.nodes, run.heart, (id) => run.swallowed.includes(id));
    const options = moves(run).filter((n) => back[n] >= 0);
    if (!options.length) break;
    const next = options.reduce((a, b) => (back[b] < back[a] ? b : a));
    resolveTurn(run, next, run.visited.includes(next) ? null : WIN, run.broods.map((b) => b.id), 0);
  }
  return run;
}

const brood = (o: Partial<Brood>): Brood => ({ id: 0, name: 'Test', kind: Kind.Dot, size: 12, cap: 16, wins: 0, wounded: 0, grows: 0, strains: [], ...o });

describe('campaign run generation', () => {
  it('is deterministic per seed text', () => {
    const a = newRun('ember-tide-7', 0, 'swarm', 1);
    const b = newRun('ember-tide-7', 0, 'swarm', 1);
    expect(b).toEqual(a);
    expect(newRun('ember-tide-8', 0, 'swarm', 1).nodes).not.toEqual(a.nodes);
  });

  it.each(SEEDS)('%s: 18-24 connected nodes in the map, start left and heart right', (seed) => {
    const run = newRun(seed, 0, 'swarm', 0);
    expect(run.nodes.length).toBeGreaterThanOrEqual(18);
    expect(run.nodes.length).toBeLessThanOrEqual(24);
    expect(hops(run.nodes, run.start).every((d) => d >= 0)).toBe(true);
    for (const n of run.nodes) {
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(MAP_W);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(MAP_H);
      for (const l of n.links) expect(run.nodes[l].links).toContain(n.id);
    }
    expect(run.nodes[run.start].kind).toBe('start');
    expect(run.nodes[run.heart].kind).toBe('finale');
    expect(run.nodes.filter((n) => n.checkpoint).length).toBeLessThanOrEqual(1);
  });

  it.each(SEEDS)('%s: the shortest route reaches the heart before the Bloom closes it', (seed) => {
    const run = rush(newRun(seed, 0, 'swarm', 0));
    expect(run.status).toBe('won');
    expect(run.turn).toBeGreaterThanOrEqual(3);
    expect(run.turn).toBeLessThanOrEqual(14);
  });

  it('places a checkpoint on most maps and rescues on some nodes', () => {
    const runs = SEEDS.map((s) => newRun(s, 0, 'swarm', 0));
    expect(runs.filter((r) => r.nodes.some((n) => n.checkpoint)).length).toBeGreaterThan(SEEDS.length * 0.8);
    const rescues = runs.flatMap((r) => r.nodes.filter((n) => n.rescue !== undefined));
    expect(rescues.length / runs.length).toBeGreaterThan(2);
  });
});

describe('battle settings', () => {
  it('conquest can also be won by holding most nests, so two rivals cannot stall it', () => {
    const run = newRun('settings', 0, 'swarm', 0);
    const conquest = run.nodes.find((n) => n.kind === 'conquest')!;
    expect(nodeSetup(run, conquest.id, false).domShare).toBe(CONQUEST_SHARE);
  });

  it('difficulty and rival count never step up at the same depth', () => {
    for (const seed of SEEDS) {
      const run = newRun(seed, 0, 'swarm', 0);
      for (const n of run.nodes) if (n.depth === 1 && n.kind !== 'start') expect(n.difficulty).toBe(0);
      // A Normal or Hard node always has company the player has already met at Easy.
      for (const n of run.nodes) if (n.kind === 'conquest' && n.difficulty >= 1) expect(n.rivals).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('broods', () => {
  it('starter packs give two broods and their unlock', () => {
    const swarm = newRun('p', 0, 'swarm', 0);
    expect(swarm.broods.map((b) => b.kind)).toEqual([Kind.Dot, Kind.Dot]);
    expect(swarm.unlocks).toEqual({ nests: 1 << NestType.Hive, nova: true });
    const wall = newRun('p', 0, 'wall', 0);
    expect(wall.broods.map((b) => b.kind)).toEqual([Kind.Dot, Kind.Tank]);
    expect(unlocked(wall, NestType.Forge)).toBe(true);
    expect(unlocked(wall, 'nova')).toBe(false);
    expect(new Set(wall.broods.map((b) => b.name)).size).toBe(2);
  });

  it('a win sizes broods from their share of survivors, clamped to the cap, and counts toward veteran', () => {
    const a = brood({ id: 0, kind: Kind.Dot, wins: 1 });
    const b = brood({ id: 1, kind: Kind.Dot, cap: 30 });
    const c = brood({ id: 2, kind: Kind.Tank });
    const ev = settleBroods([a, b, c], [0, 1, 2], { ...WIN, survivors: [50, 2, 0, 0] });
    expect(a.size).toBe(16); // 25 each, a's cap is 16
    expect(b.size).toBe(25);
    expect(c.size).toBe(MIN_SIZE); // 2 survivors, floored to the minimum
    expect(ev.some((e) => e.what === 'veteran' && e.name === a.name)).toBe(true);
  });

  it('a loss wounds and halves fielded broods and kills small ones; wounds heal by sitting out', () => {
    const big = brood({ id: 0, size: 12 });
    const small = brood({ id: 1, size: 6 });
    const rest = brood({ id: 2, wounded: 1 });
    const roster = [big, small, rest];
    const ev = settleBroods(roster, [0, 1], LOSS);
    expect(big).toMatchObject({ size: 6, wounded: 1 });
    expect(roster).not.toContain(small);
    expect(ev.map((e) => e.what).sort()).toEqual(['died', 'recovered', 'wounded']);
    expect(rest.wounded).toBe(0);
    // Fighting doesn't heal a wound.
    settleBroods(roster, [0], WIN);
    expect(big.wounded).toBe(1);
  });

  it('fields up to three fit broods, or the militia when none are fit', () => {
    const run = newRun('army', 0, 'wall', 0);
    expect(armyFor(run, run.fielded)).toEqual(run.broods.map((b) => ({ kind: b.kind, count: b.size, vet: false })));
    for (const b of run.broods) b.wounded = 1;
    expect(armyFor(run, run.fielded)).toEqual([MILITIA]);
    const s = nodeSetup(run, run.nodes[run.start].links[0], false, run.fielded);
    expect(s.players[0]).toMatchObject({ human: true, nestTypes: run.unlocks.nests, army: [MILITIA] });
  });

  it('only broods that actually fought are settled: wounded ones in the pick sit out', () => {
    const run = newRun('settle', 0, 'swarm', 0);
    const [a, b] = run.broods;
    b.wounded = 2;
    resolveTurn(run, moves(run)[0], LOSS, [a.id, b.id], 0);
    expect(b).toMatchObject({ size: 12, wounded: 1 });
    expect(a.wounded).toBe(1);
    expect(run.fielded).toEqual([a.id]);
  });

  it('winning a rescue node adds a brood, and biomass rewards nests, survivors and speed', () => {
    const run = newRun('rescue', 0, 'swarm', 0);
    const target = moves(run)[0];
    run.nodes[target].rescue = Kind.Lancer;
    const res = resolveTurn(run, target, WIN, run.fielded, 0);
    expect(run.broods.some((b) => b.kind === Kind.Lancer)).toBe(true);
    expect(res.events.some((e) => e.what === 'rescued')).toBe(true);
    expect(res.biomass).toBe(run.nodes[target].reward + 6 + Math.floor(66 / 5) + 2);
    expect(run.biomass).toBe(res.biomass);
  });

  it('losing every brood ends the run, after the checkpoint saves it once', () => {
    const run = newRun('checkpoint', 0, 'swarm', 0);
    const next = moves(run)[0];
    run.nodes[next].checkpoint = true;
    expect(resolveTurn(run, next, WIN, run.fielded, 0).checkpoint).toBe('reached');
    const saved = { at: run.at, broods: run.broods.length };
    // Two losses with small broods wipe the roster.
    for (const b of run.broods) b.size = 5;
    const res = resolveTurn(run, moves(run)[0], LOSS, run.broods.map((b) => b.id), 0);
    expect(res.checkpoint).toBe('restored');
    expect(run).toMatchObject({ status: 'active', at: saved.at, checkpointUsed: true });
    expect(run.broods.length).toBe(saved.broods);
    for (const b of run.broods) b.size = 5;
    resolveTurn(run, moves(run)[0], LOSS, run.broods.map((b) => b.id), 0);
    expect(run).toMatchObject({ status: 'lost', lostTo: 'broods' });
  });
});

describe('camp', () => {
  it('heals, grows and unlocks for biomass, and never overspends', () => {
    const run = newRun('camp', 0, 'swarm', 0);
    const b = run.broods[0];
    b.wounded = 1;
    expect(heal(run, b.id)).toBe(false);
    run.biomass = 100;
    expect(heal(run, b.id)).toBe(true);
    expect(b.wounded).toBe(0);
    expect(heal(run, b.id)).toBe(false); // not wounded any more
    expect(grow(run, b.id)).toBe(true);
    expect(b.cap).toBe(16 + COST.growBy);
    expect(unlock(run, NestType.Spire)).toBe(true);
    expect(unlocked(run, NestType.Spire)).toBe(true);
    expect(unlock(run, NestType.Spire)).toBe(false);
    expect(run.biomass).toBe(100 - COST.heal - 15 - COST.nest);
    run.biomass = 5;
    expect(unlock(run, NestType.Forge)).toBe(false);
    expect(run.biomass).toBe(5);
  });
});

describe('rewards', () => {
  /** A fresh run that has just won its first battle, so an offer is waiting. */
  const afterWin = (seed = 'reward', pack: 'swarm' | 'wall' | 'raid' = 'swarm') => {
    const run = newRun(seed, 0, pack, 0);
    resolveTurn(run, moves(run)[0], WIN, run.fielded, 0);
    return run;
  };
  const offerOf = (run: RunState, ids: string[]) => (run.offer = { ids, rerolls: 0 });

  it('a win brings a seeded offer of three different, usable rewards', () => {
    const a = afterWin();
    const b = afterWin();
    expect(a.offer!.ids).toHaveLength(3);
    expect(new Set(a.offer!.ids).size).toBe(3);
    expect(b.offer).toEqual(a.offer);
    // Only Swarmer broods and only Hive + Nova: no other kind's strains, no locked powers' variants.
    for (let t = 0; t < 40; t++) {
      for (const id of rollOffer({ ...a, turn: t }, 0)) {
        const r = REWARD[id];
        if (r.kind !== undefined) expect(r.kind).toBe(Kind.Dot);
        if (r.power) expect(['surge', 'nova']).toContain(r.power);
      }
    }
    // A loss or a march brings none.
    const lost = newRun('reward', 0, 'swarm', 0);
    resolveTurn(lost, moves(lost)[0], LOSS, lost.fielded, 0);
    expect(lost.offer).toBeUndefined();
  });

  it('strains fill two slots per brood, then replace one', () => {
    const run = afterWin();
    const b = run.broods[0];
    offerOf(run, ['frenzy', 'lean', 'plated']);
    expect(takeReward(run, 'plated', b.id)).toBe(false); // a Shield strain on a Swarmer brood
    expect(takeReward(run, 'frenzy')).toBe(false); // a strain needs a brood
    expect(takeReward(run, 'frenzy', b.id)).toBe(true);
    expect(run.offer).toBeUndefined();
    offerOf(run, ['lean']);
    takeReward(run, 'lean', b.id);
    offerOf(run, ['thick-hide']);
    expect(takeReward(run, 'thick-hide', b.id)).toBe(false); // full: must name one to replace
    expect(takeReward(run, 'thick-hide', b.id, 'frenzy')).toBe(true);
    expect(b.strains).toEqual(['lean', 'thick-hide']);
  });

  it('a power variant replaces the one held for that power', () => {
    const run = afterWin();
    offerOf(run, ['wide']);
    takeReward(run, 'wide');
    offerOf(run, ['overdrive', 'energy']);
    takeReward(run, 'overdrive');
    expect(run.perks).toEqual(['wide', 'overdrive']);
    expect(modsFor(run.perks, []).novaRadius).toBeGreaterThan(1);
    // Another Nova variant would take Wide's place (only Wide exists in v1, so fake the offer).
    run.perks = ['wide'];
    offerOf(run, ['wide']);
    expect(takeReward(run, 'wide')).toBe(false); // already held
  });

  it('rerolls cost 10, then 5 more each time, and never overspend', () => {
    const run = afterWin();
    run.biomass = 24;
    const first = run.offer!.ids;
    expect(rerollCost(run)).toBe(10);
    expect(rerollOffer(run)).toBe(true);
    expect(run.offer!.ids).not.toEqual(first);
    expect(rerollCost(run)).toBe(15);
    expect(rerollOffer(run)).toBe(false);
    expect(run.biomass).toBe(14);
    skipReward(run);
    expect(run.offer).toBeUndefined();
  });

  it('strains apply by the broods that fight; perks always', () => {
    const run = newRun('mods', 0, 'wall', 0);
    const [dots, tanks] = run.broods;
    dots.strains = ['lean'];
    tanks.strains = ['plated'];
    run.perks = ['energy'];
    const both = modsFor(run.perks, [dots, tanks]);
    expect(both.kind[Kind.Dot].speed).toBeCloseTo(1.15);
    expect(both.kind[Kind.Tank].hp).toBeCloseTo(1.3);
    expect(both.energyRate).toBeCloseTo(1.15);
    const onlyDots = modsFor(run.perks, [dots]);
    expect(onlyDots.kind[Kind.Tank].hp).toBe(1);
    // The same strain on two broods of one kind doesn't stack.
    expect(modsFor([], [dots, { ...dots, id: 9 }]).kind[Kind.Dot].speed).toBeCloseTo(1.15);
    const s = nodeSetup(run, run.nodes[run.start].links[0], false, [dots.id]);
    expect(s.players[0].mods!.kind[Kind.Dot].speed).toBeCloseTo(1.15);
  });

  it('Lone wolf fields one brood at double size; Hunger doubles biomass and speeds the Bloom', () => {
    const run = afterWin('pacts');
    offerOf(run, ['lone-wolf']);
    takeReward(run, 'lone-wolf');
    expect(maxFielded(run)).toBe(1);
    expect(run.fielded).toHaveLength(1);
    expect(armyFor(run, run.broods.map((b) => b.id))).toEqual([{ kind: run.broods[0].kind, count: run.broods[0].size * 2, vet: false }]);

    const h = afterWin('pacts');
    const step = h.bloom.step;
    offerOf(h, ['hunger']);
    takeReward(h, 'hunger');
    expect(h.bloom.step).toBeCloseTo(step * 1.25);
    const before = h.biomass;
    const res = resolveTurn(h, moves(h).find((n) => !h.visited.includes(n))!, WIN, h.fielded, 0);
    expect(res.biomass % 2).toBe(0);
    expect(h.biomass - before).toBe(res.biomass);
  });
});

describe('saves', () => {
  it('a run saved before rewards loads with empty perks and strains', async () => {
    const mem = new Map<string, string>();
    const ls = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    const { loadRun, saveRun } = await import('../src/campaign/store');
    const old = newRun('old', 0, 'swarm', 0) as Partial<RunState>;
    delete old.perks;
    for (const b of old.broods!) delete (b as Partial<Brood>).strains;
    saveRun(old as RunState);
    const back = loadRun(old.id!)!;
    expect(back.perks).toEqual([]);
    expect(back.broods.every((b) => Array.isArray(b.strains))).toBe(true);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
