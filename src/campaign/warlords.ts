/**
 * Warlords (#66): named rivals who hold domains of nodes around a stronghold.
 * In a domain battle the warlord takes one of the rival slots and fights with
 * its trait. Taking the stronghold breaks the domain and earns its trophy, a
 * milder copy of the trait; the Bloom eating domain nodes weakens it, and
 * eating the stronghold ends it. Pure and seeded: no DOM.
 *
 * PROVISIONAL: every number here waits for the balance pass (#68).
 */

import { Kind } from '../sim/constants';
import type { FactionMods } from '../sim/mods';
import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import { Rng, hashString } from '../sim/rng';

export type TraitId = 'ironhide' | 'swarmlord' | 'raider-king' | 'longspine' | 'stormcaller' | 'broodmother';

export interface Trait {
  name: string;
  /** what it does, as the node card and the battle announce it */
  text: string;
  apply: (m: FactionMods) => void;
  /** production multiplier on top of the bot difficulty's */
  prod?: number;
  /** the warlord casts no powers */
  noPowers?: boolean;
  /** the trophy for breaking its stronghold: a run perk, about half the trait */
  trophy: { name: string; text: string; apply: (m: FactionMods) => void };
}

export const TRAITS: Record<TraitId, Trait> = {
  ironhide: {
    name: 'Ironhide',
    text: 'Shields have +50% HP',
    apply: (m) => void (m.kind[Kind.Tank].hp *= 1.5),
    trophy: { name: 'Ironhide hide', text: 'Your Shields have +25% HP', apply: (m) => void (m.kind[Kind.Tank].hp *= 1.25) },
  },
  swarmlord: {
    name: 'Swarmlord',
    text: 'Spawns 25% faster, but casts no powers',
    apply: () => {},
    prod: 1.25,
    noPowers: true,
    trophy: { name: "Swarmlord's brood", text: '+1 supply per nest you hold', apply: (m) => void (m.supplyPerNest += 1) },
  },
  'raider-king': {
    name: 'Raider-king',
    text: 'Raiders capture 50% faster and run 15% faster',
    apply: (m) => {
      m.kind[Kind.Swift].capture *= 1.5;
      m.kind[Kind.Swift].speed *= 1.15;
    },
    trophy: { name: "Raider-king's spurs", text: 'Your Raiders capture 25% faster', apply: (m) => void (m.kind[Kind.Swift].capture *= 1.25) },
  },
  longspine: {
    name: 'Longspine',
    text: 'Spears reach 20% further',
    apply: (m) => void (m.kind[Kind.Lancer].range *= 1.2),
    trophy: { name: 'Longspine quills', text: 'Your Spears reach 10% further', apply: (m) => void (m.kind[Kind.Lancer].range *= 1.1) },
  },
  stormcaller: {
    name: 'Stormcaller',
    text: 'Gains energy 40% faster: more powers',
    apply: (m) => void (m.energyRate *= 1.4),
    trophy: { name: "Stormcaller's spark", text: 'You gain energy 20% faster', apply: (m) => void (m.energyRate *= 1.2) },
  },
  broodmother: {
    name: 'Broodmother',
    text: 'Starts with a bigger capital and +2 supply per nest',
    apply: (m) => {
      m.capitalLevel += 1;
      m.supplyPerNest += 2;
    },
    trophy: { name: "Broodmother's egg", text: 'Your capital starts a level higher', apply: (m) => void (m.capitalLevel += 1) },
  },
};
export const TRAIT_IDS = Object.keys(TRAITS) as TraitId[];

/** Trophy perks are stored in the run's perks as this prefix plus the trait id. */
export const TROPHY = 'trophy:';
export const trophyOf = (perk: string): Trait['trophy'] | undefined =>
  perk.startsWith(TROPHY) ? TRAITS[perk.slice(TROPHY.length) as TraitId]?.trophy : undefined;

export interface Warlord {
  id: number;
  faction: number;
  name: string;
  trait: TraitId;
  personality: Personality;
  stronghold: number;
  /** every node of its domain, the stronghold included */
  nodes: number[];
  /** its stronghold was taken */
  broken: boolean;
}

/** Each domain node the Bloom swallows costs the warlord this share of its production... */
export const EROSION = 0.1;
/** ...down to this floor. */
export const EROSION_FLOOR = 0.5;
/** domain rewards: biomass multipliers and rescue odds */
export const DOMAIN_REWARD = 1.3;
export const STRONGHOLD_REWARD = 2;
export const DOMAIN_RESCUE = 0.5;
/** reward offer weights after winning in a domain, and at a stronghold */
export const DOMAIN_WEIGHT = { common: 45, uncommon: 35, rare: 20 };
export const STRONGHOLD_WEIGHT = { common: 20, uncommon: 40, rare: 40 };

const TITLES = ['Vex', 'Mordra', 'Skarn', 'Ilith', 'Grask', 'Oru', 'Thessa', 'Kael', 'Nyx', 'Brakka', 'Zul', 'Varro'];

/** What placement needs to know about a node (kept narrow so run.ts can import this). */
interface PlaceNode {
  id: number;
  links: number[];
  depth: number;
  kind: string;
  checkpoint?: boolean;
}

/**
 * Place 2-4 warlords: strongholds spread out (at least 3 hops apart) in the
 * middle of the map, each with 1-3 linked neighbours as its domain. Its own
 * seeded stream, so the rest of the run's generation is untouched.
 */
export function placeWarlords(
  seed: number,
  nodes: PlaceNode[],
  far: number,
  playerColor: number,
  hops: (from: number) => number[],
): Warlord[] {
  const rng = new Rng(hashString(`${seed}:warlords`));
  const battle = (n: PlaceNode) => n.kind !== 'start' && n.kind !== 'finale' && !n.checkpoint;
  const pool = nodes.filter((n) => battle(n) && n.depth >= 2 && n.depth <= far - 1).map((n) => n.id);
  const want = 2 + rng.int(3);
  const strongholds: number[] = [];
  while (strongholds.length < want && pool.length) {
    const k = rng.int(pool.length);
    const id = pool.splice(k, 1)[0];
    const d = hops(id);
    if (strongholds.some((s) => d[s] < 3)) continue;
    strongholds.push(id);
  }
  const taken = new Set(strongholds);
  const colors = [0, 1, 2, 3, 4, 5].filter((c) => c !== playerColor);
  const traits = [...TRAIT_IDS];
  const names = [...TITLES];
  return strongholds.map((s, id) => {
    const domain = [s];
    const near = nodes[s].links.filter((l) => !taken.has(l) && battle(nodes[l]));
    const size = 1 + rng.int(3);
    while (domain.length <= size && near.length) {
      const l = near.splice(rng.int(near.length), 1)[0];
      domain.push(l);
      taken.add(l);
    }
    const faction = colors.splice(rng.int(colors.length), 1)[0];
    const trait = traits.splice(rng.int(traits.length), 1)[0];
    const name = `${names.splice(rng.int(names.length), 1)[0]} the ${TRAITS[trait].name}`;
    return { id, faction, name, trait, personality: rng.pick(PERSONALITIES), stronghold: s, nodes: domain, broken: false };
  });
}
