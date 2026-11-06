import { describe, expect, it } from 'vitest';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { isAlly, teamLayout, teamName } from '../src/ui/teams';

/** You (Cyan, 0) and Lime (2) against Magenta (1) and Amber (3), and Violet (4) alone. */
const setup = (teams: boolean): MatchSetup => ({
  seed: 7,
  size: 'medium',
  terrain: 'standard',
  events: 'calm',
  players: [
    { faction: 0, team: 0, human: true },
    { faction: 1, team: teams ? 1 : 1, human: false, bot: { difficulty: 0, personality: 'rusher' } },
    { faction: 2, team: teams ? 0 : 2, human: false, bot: { difficulty: 0, personality: 'rusher' } },
    { faction: 3, team: teams ? 1 : 3, human: false, bot: { difficulty: 0, personality: 'rusher' } },
    { faction: 4, team: 4, human: false, bot: { difficulty: 0, personality: 'rusher' } },
  ],
});

describe('teams (#74)', () => {
  it('groups by team with yours first, lettered A, you leading it', () => {
    const w = createWorld(setup(true));
    const l = teamLayout(w, 0);
    expect(l.team).toBe(true);
    expect(l.groups.map((g) => [g.letter, g.mine, g.members])).toEqual([
      ['A', true, [0, 2]],
      ['B', false, [1, 3]],
      ['C', false, [4]],
    ]);
    expect(isAlly(w, 0, 2)).toBe(true);
    expect(isAlly(w, 0, 0)).toBe(false);
    expect(isAlly(w, 0, 1)).toBe(false);
  });

  it('names teams: yours, a pair, and one standing alone', () => {
    const w = createWorld(setup(true));
    expect(teamName(w, 0, 2)).toBe('Your team');
    expect(teamName(w, 0, 3)).toBe('Magenta + Amber');
    expect(teamName(w, 0, 4)).toBe('Violet');
  });

  it('reads free-for-all as no teams', () => {
    const w = createWorld(setup(false));
    expect(teamLayout(w, 0).team).toBe(false);
    expect(teamName(w, 0, 0)).toBe('Cyan');
    expect(teamName(w, 0, 1)).toBe('Magenta');
  });
});
