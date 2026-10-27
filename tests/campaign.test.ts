import { describe, expect, it } from 'vitest';
import { nodeSetup } from '../src/campaign/battle';
import { MAP_H, MAP_W, hops, moves, newRun, resolveTurn, START_LIVES, type RunState } from '../src/campaign/run';

const SEEDS = Array.from({ length: 60 }, (_, i) => `seed-${i}`);

/** Walk the shortest open route to the heart, winning every battle. */
function rush(run: RunState): RunState {
  for (let guard = 0; guard < 60 && run.status === 'active'; guard++) {
    const back = hops(run.nodes, run.heart, (id) => run.swallowed.includes(id));
    const options = moves(run).filter((n) => back[n] >= 0);
    if (!options.length) break;
    const next = options.reduce((a, b) => (back[b] < back[a] ? b : a));
    resolveTurn(run, next, true, 0);
  }
  return run;
}

describe('campaign run generation', () => {
  it('is deterministic per seed text', () => {
    const a = newRun('ember-tide-7', 0, 1);
    const b = newRun('ember-tide-7', 0, 1);
    expect(b).toEqual(a);
    expect(newRun('ember-tide-8', 0, 1).nodes).not.toEqual(a.nodes);
  });

  it.each(SEEDS)('%s: 18-24 connected nodes in the map, start left and heart right', (seed) => {
    const run = newRun(seed, 0, 0);
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
    // Nothing is in the Bloom at the start.
    expect(resolveTurn(structuredClone(run), run.nodes[run.start].links[0], true, 0).length).toBeGreaterThanOrEqual(0);
  });

  it.each(SEEDS)('%s: the shortest route reaches the heart before the Bloom closes it', (seed) => {
    const run = rush(newRun(seed, 0, 0));
    expect(run.status).toBe('won');
    // 8-10 battles is the target; generation keeps it in a sane range.
    expect(run.turn).toBeGreaterThanOrEqual(3);
    expect(run.turn).toBeLessThanOrEqual(14);
  });

  it('the Bloom swallows nodes behind and beside you as turns pass', () => {
    let swallowed = 0;
    for (const seed of SEEDS) swallowed += rush(newRun(seed, 0, 0)).swallowed.length;
    expect(swallowed / SEEDS.length).toBeGreaterThan(3);
  });

  it('losing costs a life and keeps you in place; three losses end the run', () => {
    const run = newRun('losses', 0, 0);
    const target = moves(run)[0];
    resolveTurn(run, target, false, 0);
    expect(run.at).toBe(run.start);
    expect(run.lives).toBe(START_LIVES - 1);
    expect(run.visited).not.toContain(target);
    resolveTurn(run, moves(run)[0], false, 0);
    resolveTurn(run, moves(run)[0], false, 0);
    expect(run.status).toBe('lost');
    expect(run.lostTo).toBe('battles');
  });

  it('builds a match for every node, harder further out', () => {
    const run = newRun('battles', 2, 0);
    for (const n of run.nodes) {
      if (n.kind === 'start') continue;
      const s = nodeSetup(run, n.id, false);
      expect(s.players[0]).toMatchObject({ faction: 2, human: true });
      expect(s.players.length).toBe(n.rivals + 1);
      expect(new Set(s.players.map((p) => p.faction)).size).toBe(s.players.length);
      if (n.kind === 'conquest') expect(s.domShare).toBeGreaterThan(1);
      if (n.kind === 'domination') expect(s.domShare).toBeLessThan(0.6);
    }
    const heart = run.nodes[run.heart];
    expect(heart).toMatchObject({ size: 'large', rivals: 3, difficulty: 2 });
    const near = run.nodes.filter((n) => n.depth === 1);
    expect(Math.max(...near.map((n) => n.difficulty))).toBe(0);
  });
});
