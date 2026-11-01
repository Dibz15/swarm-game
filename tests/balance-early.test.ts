import { describe, expect, it } from 'vitest';
import { callOf, lead, playBattle, strength } from '../scripts/balance/battle';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { removeUnit } from '../src/sim/world';

const setup: MatchSetup = {
  seed: 7,
  size: 'small',
  players: [
    { faction: 0, team: 0, human: true },
    { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'expander' } },
  ],
};

describe('balance harness early decision (#68)', () => {
  it('sees an even start, and the survivor once one side is stripped', () => {
    const w = createWorld(setup);
    const s = strength(w);
    expect(s.get(0)).toBeCloseTo(s.get(1)!);
    expect(lead(w).share).toBeCloseTo(0.5);
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 1) removeUnit(w, i);
    for (const n of w.nests) if (n.owner === 1) n.owner = -1;
    expect(lead(w)).toEqual({ team: 0, share: 1 });
  });

  it('calls a battle once one team stays over the share for the whole span', () => {
    const rule = { share: 0.8, secs: 3 };
    const at = (team: number[], share: number[]) => callOf({ team, share }, rule);
    expect(at([0, 0, 0, 0], [90, 90, 90, 90])).toEqual({ team: 0, tick: 4 * TICK_HZ });
    expect(at([0, 0, 0, 0], [90, 90, 70, 90])).toBeUndefined();
    expect(at([0, 0, 1, 1, 1, 1], [90, 90, 90, 90, 90, 90])).toEqual({ team: 1, tick: 6 * TICK_HZ });
  });

  it('ends a battle on its rule only when asked, at the call the played-out trace shows', () => {
    const job = { setup, human: 0, proxy: { skill: 1 }, cap: 10 * 60 * TICK_HZ };
    const rule = { share: 0.6, secs: 20 };
    const full = playBattle(job);
    expect(full.decided).toBe(false);
    const call = callOf(full.trace, rule);
    const early = playBattle({ ...job, early: rule });
    if (call && call.tick < full.ticks) {
      expect(early.decided).toBe(true);
      expect(early.ticks).toBe(call.tick);
      expect(early.won).toBe(call.team === 0);
    } else expect(early).toEqual(full);
  });
});
