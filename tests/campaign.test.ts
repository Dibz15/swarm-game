import { describe, expect, it } from 'vitest';
import { armyFor, nodeSetup } from '../src/campaign/battle';
import { COST, MILITIA, MIN_SIZE, settleBroods, type BattleReport, type Brood } from '../src/campaign/broods';
import { MAP_H, MAP_W, grow, heal, hops, moves, newRun, resolveTurn, unlock, unlocked, type RunState } from '../src/campaign/run';
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

const brood = (o: Partial<Brood>): Brood => ({ id: 0, name: 'Test', kind: Kind.Dot, size: 12, cap: 16, wins: 0, wounded: 0, grows: 0, ...o });

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
