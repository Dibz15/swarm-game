/**
 * Multiplayer characters (#162): who you play as in a room, made like the
 * campaign's broods. A seed gives a name ("Gloamfang"), a temperament word and
 * a creature portrait drawn in your colour, so only the seed travels and
 * nobody types a name.
 */

import { creature, type Creature } from '../art/creature';
import { broodName } from '../campaign/broods';
import { TEMPER_WORDS } from '../campaign/character';
import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import { Rng } from '../sim/rng';

export interface Character {
  seed: number;
  name: string;
  temper: Personality;
  /** "restless", "cunning"… agrees with the portrait's look */
  word: string;
}

/** Seeds are u32s, as they travel in `hello` and `pick`. */
export const charSeed = (n: number): number => n >>> 0;

export function playerCharacter(seed: number): Character {
  seed = charSeed(seed);
  const rng = new Rng(seed ^ 0x6a7e);
  const temper = rng.pick(PERSONALITIES);
  return { seed, name: broodName(seed, []), temper, word: rng.pick(TEMPER_WORDS[temper]) };
}

export function characterCreature(ch: Character, color: number): Creature {
  return creature(ch.seed, color, { temper: ch.temper, tier: 1 });
}

/** `n` fresh characters with names unlike each other and unlike `taken`. */
export function characterChoices(n: number, taken: readonly string[] = [], random: () => number = Math.random): Character[] {
  const out: Character[] = [];
  for (let k = 0; out.length < n && k < n * 20; k++) {
    const c = playerCharacter(Math.floor(random() * 0x100000000));
    if (!taken.includes(c.name) && !out.some((o) => o.name === c.name)) out.push(c);
  }
  return out;
}

const KEY = 'swarm.character';

/** The character last played as, if any. */
export function loadCharacter(): Character | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === null || !/^\d+$/.test(v) ? null : playerCharacter(Number(v));
  } catch {
    return null;
  }
}

export function saveCharacter(c: Character): void {
  try {
    localStorage.setItem(KEY, String(c.seed));
  } catch {
    /* ignore */
  }
}
