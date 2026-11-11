import { DOMINATION, KEYS, SURGE, TICK_HZ } from '../sim/constants';
import { SIEGE } from '../sim/siege';
import { CONQUEST_SHARE } from './battle';
import type { RunNode } from './run';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const HOLD_S = DOMINATION.ticks / TICK_HZ;
const EVERY = SIEGE.boonEvery === 2 ? 'other wave' : `${SIEGE.boonEvery} waves`;

/** What each battle kind asks of you, in words: the node card and the battle briefings (#218) share it. */
export const KIND_TEXT: Record<RunNode['kind'], string> = {
  start: 'Where the run began.',
  conquest: `Wipe out every rival, or hold ${pct(CONQUEST_SHARE)} of the nests for ${HOLD_S} seconds. Past ${SURGE.after / 60} minutes, the Bloom surges in, every wave bigger.`,
  domination: `Score on the key nests: hold them all for ${KEYS.points / TICK_HZ} seconds, or fewer for longer. Or wipe out every rival.`,
  hold: `Dug in behind your own walls: keep your capital until the clock runs out, against the Bloom's waves. Its nests in the field feed them; sally out to take them. Every ${EVERY}, pick a boon. Lose the capital and you have ${SIEGE.retake / TICK_HZ} seconds to take it back.`,
  finale: "The final battle: a large map, the Bloom's heart and the rivals around it. Win it to end the run.",
};
/** A stronghold's Conquest or Domination keeps the plain share rules (#87: no key nests, no surge). */
export const FORT_TEXT: Partial<Record<RunNode['kind'], string>> = {
  conquest: `Wipe out every rival, or hold ${pct(CONQUEST_SHARE)} of the nests for ${HOLD_S} seconds.`,
  // A stronghold's Domination is played to the Conquest share (nodeSetup's domShare).
  domination: `Wipe out every rival, or hold ${pct(CONQUEST_SHARE)} of the nests for ${HOLD_S} seconds.`,
};
