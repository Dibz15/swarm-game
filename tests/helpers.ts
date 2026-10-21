import type { MatchSetup } from '../src/sim/setup';

export function botMatch(seed: number, n = 4, size: MatchSetup['size'] = 'medium'): MatchSetup {
  const pers = ['rusher', 'turtler', 'expander', 'opportunist'] as const;
  return {
    seed,
    size,
    players: Array.from({ length: n }, (_, i) => ({
      faction: i,
      team: i,
      human: false,
      bot: { difficulty: 2, personality: pers[i % 4] },
    })),
  };
}
