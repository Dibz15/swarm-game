import { describe, expect, it } from 'vitest';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { isAlly, possessive, sideOf, teamLayout, teamName, verb } from '../src/ui/teams';

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
    expect(teamName(w, 0, 2)).toEqual({ name: 'Your team', plural: false });
    expect(teamName(w, 0, 3)).toEqual({ name: 'Magenta + Amber', plural: true });
    expect(teamName(w, 0, 4)).toEqual({ name: 'Violet', plural: false });
  });

  it('words a team in a sentence by its size, not its name', () => {
    const w = createWorld(setup(true));
    const say = (f: number) => {
      const t = teamName(w, 0, f);
      return `${t.name} ${verb(t, 'is', 'are')} dominating · ${possessive(t)} domination is broken`;
    };
    expect(say(0)).toBe("Your team is dominating · Your team's domination is broken");
    expect(say(1)).toBe("Magenta + Amber are dominating · Magenta + Amber's domination is broken");
    expect(say(4)).toBe("Violet is dominating · Violet's domination is broken");
    const ffa = createWorld(setup(false));
    const you = teamName(ffa, 0, 0);
    expect(`${you.name} ${verb(you, 'is', 'are')} dominating · ${possessive(you)} domination`).toBe('You are dominating · Your domination');
  });

  it('orders the strip by team, you first, and sides every faction', () => {
    const w = createWorld(setup(true));
    expect(teamLayout(w, 0).groups.flatMap((g) => g.members)).toEqual([0, 2, 1, 3, 4]);
    expect([0, 1, 2, 4, -1, 6].map((f) => sideOf(w, 0, f))).toEqual(['you', 'enemy', 'ally', 'enemy', null, null]);
  });

  it('reads free-for-all as no teams', () => {
    const w = createWorld(setup(false));
    expect(teamLayout(w, 0).team).toBe(false);
    expect(teamName(w, 0, 0)).toEqual({ name: 'You', plural: true });
    expect(teamName(w, 0, 1)).toEqual({ name: 'Magenta', plural: false });
  });
});
