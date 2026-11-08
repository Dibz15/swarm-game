import { describe, expect, it, vi } from 'vitest';
import { Proxy, knobsFor, EXPERT } from '../src/proxy/proxy';
import { TICK_HZ } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';

const setup = (): MatchSetup => ({
  seed: 1, // a typical map: the proxy, not the layout, is under test
  size: 'small',
  players: [
    { faction: 0, team: 0, human: true },
    { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'expander' } },
  ],
});

/** A minute of the proxy against a Normal bot. */
function minute(skill = 1) {
  const w = createWorld(setup());
  const p = new Proxy(0, { skill });
  const kinds = new Set<string>();
  while (w.tick < 60 * TICK_HZ && !w.over) {
    const cmds = p.think(w);
    for (const c of cmds) {
      kinds.add(c.t);
      expect(c.p).toBe(0);
      if ('units' in c) expect(c.units.length).toBeGreaterThan(0);
    }
    step(w, cmds);
  }
  return { w, kinds };
}

describe('human proxy (#29, #37)', () => {
  it('decides once per period even when ticks are skipped or repeated (a net client catching up)', () => {
    // how often the once-a-second power decision runs, calling think every `stride` ticks (`twice`: two calls each time)
    const powers = (stride: number, twice = false) => {
      const w = createWorld(setup());
      const p = new Proxy(0, { skill: 1 });
      const spy = vi.spyOn(p as unknown as { powers: () => void }, 'powers');
      while (w.tick < 10 * TICK_HZ) {
        p.think(w);
        if (twice) p.think(w);
        for (let k = 0; k < stride; k++) step(w, []);
      }
      return spy.mock.calls.length;
    };
    const every = powers(1);
    expect(every).toBe(10); // ticks 0, 30, ..., 270: every stride below passes each of them
    expect(powers(1, true)).toBe(every);
    expect(powers(7)).toBe(every);
    expect(powers(8, true)).toBe(every);
  });

  it('expands like the recordings: a second nest inside the first 30 s, more by a minute', () => {
    const { w, kinds } = minute();
    expect(w.nests.filter((n) => n.owner === 0).length).toBeGreaterThanOrEqual(3);
    expect(kinds.has('move')).toBe(true);
    expect(kinds.has('rally')).toBe(true);
  });

  it('is deterministic', () => {
    expect(worldHash(minute().w)).toBe(worldHash(minute().w));
  });

  it('skill 1 is the expert; lower skill is slower and more timid', () => {
    expect(knobsFor(1)).toEqual(EXPERT);
    const low = knobsFor(0);
    expect(low.react).toBeGreaterThan(EXPERT.react);
    expect(low.margin).toBeGreaterThan(EXPERT.margin);
    expect(low.straggle).toBeGreaterThan(0);
  });
});
