import { NEUTRAL } from '../sim/constants';
import type { World } from '../sim/world';

/** Where a faction finished (#183): place 1 is the winner's. */
export interface Placing {
  place: number;
  of: number;
}

/**
 * A faction just knocked out: it places behind everyone still in. Factions
 * out earlier placed behind it, so its place is one more than those left.
 */
export function placingOf(w: World, f: number): Placing {
  const players = w.factions.filter((x) => x.active && x.id !== NEUTRAL);
  const left = players.filter((x) => x.id !== f && !x.eliminated).length;
  return { place: left + 1, of: players.length };
}

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}
