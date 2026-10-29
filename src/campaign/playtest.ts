/**
 * Playtest scenarios (`?playtest`): throwaway runs set up to show one feature
 * straight away, so a review doesn't need a whole campaign. Pure: main.ts
 * starts them. Their ids start with PLAYTEST, and the store never saves them.
 */

import { newRun, type RunState } from './run';
import type { TraitId, Warlord } from './warlords';

export const PLAYTEST = 'playtest-';

export type Scene =
  | { kind: 'map'; run: RunState }
  | { kind: 'battle'; run: RunState; node: number; extra?: 'gates' | 'fall' };

export interface Playtest {
  id: string;
  group: string;
  title: string;
  text: string;
  make: (color: number) => Scene;
}

/** A throwaway run: its id marks it unsaved, and its broods are big enough to fight with. */
function run(seed: string, color: number): RunState {
  const r = newRun(seed, color, 'swarm', Date.now());
  r.id = PLAYTEST + seed;
  // About a mid-run army, just under the starting supply cap.
  for (const b of r.broods) b.size = b.cap = 16;
  return r;
}

/** The first seeded run with a warlord of this trait (whose domain has at least `nodes` nodes). */
function withTrait(trait: TraitId, color: number, nodes = 1): [RunState, Warlord] {
  for (let k = 0; k < 400; k++) {
    const r = run(`${trait}-${k}`, color);
    const w = r.warlords?.find((o) => o.trait === trait && o.nodes.length >= nodes);
    if (w) return [r, w];
  }
  throw new Error(`no run with a ${trait} warlord`);
}

/** A battle scene at a fixed, fair setting: Normal bots, at most two rivals. */
function fight(r: RunState, node: number, extra?: 'gates' | 'fall'): Scene {
  const n = r.nodes[node];
  n.difficulty = 1;
  n.rivals = Math.min(n.rivals, 2);
  return { kind: 'battle', run: r, node, extra };
}

/** Stand next to `target` (off it), with only the start and that node taken. */
function standBy(r: RunState, target: number, avoid: number[] = []): void {
  const links = r.nodes[target].links.filter((l) => r.nodes[l].kind !== 'finale');
  r.at = links.find((l) => !avoid.includes(l)) ?? links[0];
  r.visited = [r.start, r.at];
}

const TRAIT_NAMES: Record<TraitId, string> = {
  ironhide: 'Ironhide',
  swarmlord: 'Swarmlord',
  'raider-king': 'Raider-king',
  longspine: 'Longspine',
  stormcaller: 'Stormcaller',
  broodmother: 'Broodmother',
};
const TRAIT_LOOK: Record<TraitId, string> = {
  ironhide: 'plated Shields',
  swarmlord: 'Swarmers pulsing together',
  'raider-king': 'long Raider streaks',
  longspine: 'spiked Spears',
  stormcaller: 'sparks on its units',
  broodmother: 'a throbbing capital',
};
const TRAIT_IDS = Object.keys(TRAIT_NAMES) as TraitId[];

export const PLAYTESTS: Playtest[] = [
  {
    id: 'map-domains',
    group: 'Run map',
    title: 'Next to a stronghold',
    text: 'Domains washed in their warlord’s colour, a walled and named stronghold, crowned domain nodes. Tap the stronghold for its card.',
    make: (c) => {
      const [r, w] = withTrait('ironhide', c, 2);
      standBy(r, w.stronghold, w.nodes);
      return { kind: 'map', run: r };
    },
  },
  {
    id: 'map-eroded',
    group: 'Run map',
    title: 'A domain the Bloom is eating',
    text: 'Two domain nodes swallowed: the stronghold’s card says “weakened ×2”.',
    make: (c) => {
      const [r, w] = withTrait('raider-king', c, 3);
      r.swallowed = w.nodes.slice(1, 3);
      standBy(r, w.stronghold, w.nodes);
      return { kind: 'map', run: r };
    },
  },
  {
    id: 'map-broken',
    group: 'Run map',
    title: 'A domain you broke',
    text: 'The domain fades to grey and loses its crowns; the trophy is in the camp’s Rewards tab (tap your swarm).',
    make: (c) => {
      const [r, w] = withTrait('longspine', c, 2);
      w.broken = true;
      r.perks.push(`trophy:${w.trait}`);
      r.at = w.stronghold;
      r.visited = [r.start, w.stronghold];
      return { kind: 'map', run: r };
    },
  },
  ...TRAIT_IDS.map(
    (t): Playtest => ({
      id: `hold-${t}`,
      group: 'Stronghold battles',
      title: `${TRAIT_NAMES[t]} stronghold`,
      text: `Walls, gates, the crowned citadel and the HUD objective; the warlord’s units show ${TRAIT_LOOK[t]}. Take the citadel to win.`,
      make: (c) => {
        const [r, w] = withTrait(t, c);
        standBy(r, w.stronghold, w.nodes);
        return fight(r, w.stronghold);
      },
    }),
  ),
  {
    id: 'hold-gates',
    group: 'Stronghold battles',
    title: 'At the gates',
    text: 'Your army starts just outside the citadel’s main gate: the breach horn, the capture bar, and a quick try at taking it.',
    make: (c) => {
      const [r, w] = withTrait('ironhide', c);
      standBy(r, w.stronghold, w.nodes);
      return fight(r, w.stronghold, 'gates');
    },
  },
  {
    id: 'hold-fall',
    group: 'Stronghold battles',
    title: 'The citadel falls',
    text: 'The citadel changes hands a few seconds in: the fanfare, the citadel win, the debrief with the trophy, and the broken domain on the map after.',
    make: (c) => {
      const [r, w] = withTrait('stormcaller', c);
      standBy(r, w.stronghold, w.nodes);
      return fight(r, w.stronghold, 'fall');
    },
  },
  ...TRAIT_IDS.map(
    (t): Playtest => ({
      id: `domain-${t}`,
      group: 'Domain battles (no walls)',
      title: `${TRAIT_NAMES[t]} domain`,
      text: `The warlord in an ordinary domain battle: the sting, trait toast and HUD chip, its crowned capital, and ${TRAIT_LOOK[t]}.`,
      make: (c) => {
        const [r, w] = withTrait(t, c, 2);
        const node = w.nodes[1];
        standBy(r, node, w.nodes);
        return fight(r, node);
      },
    }),
  ),
  {
    id: 'finale-lords',
    group: 'Finale',
    title: 'The heart, with warlords',
    text: 'Two living warlords bordering the heart join the finale with their traits.',
    make: (c) => {
      const r = run('finale-lords', c);
      const near = r.nodes[r.heart].links;
      r.warlords!.slice(0, 2).forEach((w, k) => {
        const l = near[k % near.length];
        if (!w.nodes.includes(l)) w.nodes.push(l);
      });
      r.at = near[0];
      r.visited = [r.start, r.at];
      return { kind: 'battle', run: r, node: r.heart };
    },
  },
];
