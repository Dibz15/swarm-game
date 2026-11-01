/**
 * Brood characters (#76): each brood's creature portrait (#72) and
 * temperament, derived from the run's seed and the brood's id, so nothing new
 * is saved and a brood keeps its face for life. The look follows its state:
 * veterans get plating and more menace, wounded broods look hurt, and strains
 * pass through as marks (#82).
 */

import { creature, type Creature } from '../art/creature';
import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import { Rng, hashString } from '../sim/rng';
import { veteran, type Brood } from './broods';
import type { RunState } from './run';

/** Temperament words per personality family: the word and the look always agree. */
export const TEMPER_WORDS: Record<Personality, readonly string[]> = {
  rusher: ['reckless', 'hungry', 'fierce'],
  turtler: ['steadfast', 'stubborn', 'patient'],
  expander: ['restless', 'roaming', 'curious'],
  opportunist: ['cunning', 'watchful', 'sly'],
};

export const broodSeed = (run: RunState, b: Brood): number => hashString(`brood:${run.seed}:${b.id}`);

export function broodTemper(run: RunState, b: Brood): { temper: Personality; word: string } {
  const rng = new Rng(broodSeed(run, b) ^ 0x7e3);
  const temper = rng.pick(PERSONALITIES);
  return { temper, word: rng.pick(TEMPER_WORDS[temper]) };
}

export function broodCreature(run: RunState, b: Brood): Creature {
  const vet = veteran(b);
  return creature(broodSeed(run, b), run.color, {
    temper: broodTemper(run, b).temper,
    focus: b.kind,
    tier: vet ? (b.wins >= 4 ? 2 : 1) : 0,
    plating: vet ? 0.6 : 0,
    wounded: b.wounded > 0,
    marks: b.strains,
  });
}
