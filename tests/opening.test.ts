import { describe, expect, it } from 'vitest';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { worldHash } from '../src/sim/hash';
import { OPENING_TICKS, TICK_HZ } from '../src/sim/constants';
import { buildSetup, loadPrefs } from '../src/game/matchSetup';
import { botMatch } from './helpers';

/** The opening (#235): the world waits for GO, then plays as it would have from tick 0. */
describe('opening', () => {
  it('nothing moves, spawns or acts until the opening ends', () => {
    const w = createWorld({ ...botMatch(5), opening: OPENING_TICKS });
    const count = w.count;
    const xs = Array.from(w.x.subarray(0, w.n));
    const energy = w.factions.map((f) => f.energy);
    const units = [];
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 0) units.push(w.uid[i]);
    const far = w.nests.find((n) => n.owner !== 0)!;
    for (let t = 0; t < OPENING_TICKS; t++) step(w, [{ t: 'move', p: 0, units, x: far.x, y: far.y, nest: far.id }]);
    expect(w.tick).toBe(OPENING_TICKS);
    expect(w.count).toBe(count);
    expect(Array.from(w.x.subarray(0, w.n))).toEqual(xs);
    expect(w.factions.map((f) => f.energy)).toEqual(energy);
  });

  it('after it, the world comes alive', () => {
    const w = createWorld({ ...botMatch(9), opening: OPENING_TICKS });
    for (let t = 0; t < OPENING_TICKS; t++) step(w, []);
    const h = worldHash(w);
    const count = w.count;
    for (let t = 0; t < 10 * TICK_HZ; t++) step(w, []);
    expect(worldHash(w)).not.toBe(h);
    expect(w.count).toBeGreaterThan(count);
  });

  it('skirmish setups have one; a setup refuses a long one', () => {
    expect(buildSetup(loadPrefs(), 'x').opening).toBe(OPENING_TICKS);
    const s: MatchSetup = { ...botMatch(1), opening: 60 * TICK_HZ };
    expect(() => createWorld(s)).toThrow(/opening/);
  });
});
