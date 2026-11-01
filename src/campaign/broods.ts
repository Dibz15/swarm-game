/**
 * Broods (#63): your persistent squads. Each is one unit kind with a size, a
 * cap and a record. You field up to three as your starting army; afterwards
 * the battle decides their size, wounds and deaths. Also the starter packs and
 * the camp's prices. Pure: no DOM, and nothing here touches the sim.
 */

import { Kind, NestType } from '../sim/constants';
import { Rng } from '../sim/rng';

export interface Brood {
  id: number;
  name: string;
  /** Kind.Dot (Swarmers), Tank (Shields), Lancer (Spears) or Swift (Raiders) */
  kind: number;
  size: number;
  cap: number;
  wins: number;
  /** battles left to sit out; counts down only on battles it doesn't fight */
  wounded: number;
  /** cap grows bought at the camp (each costs more) */
  grows: number;
  /** strain rewards (ids in rewards.ts), at most STRAIN_SLOTS */
  strains: string[];
}

export const MAX_FIELDED = 3;
export const MAX_ROSTER = 6;
/** a brood below this many dots is spent and dies */
export const MIN_SIZE = 4;
/** wins before a brood's starting dots spawn as veterans */
export const VETERAN_WINS = 2;
/** fights when no brood is fit: nobody is at risk */
export const MILITIA = { kind: Kind.Dot, count: 10 };
const START = { size: 12, cap: 16 };
export const RESCUE_SIZE = 8;

export const KIND_NAME: Record<number, string> = {
  [Kind.Dot]: 'Swarmers',
  [Kind.Tank]: 'Shields',
  [Kind.Lancer]: 'Spears',
  [Kind.Swift]: 'Raiders',
};
/** the nest type that produces each kind */
export const KIND_NEST: Record<number, number> = {
  [Kind.Dot]: NestType.Hive,
  [Kind.Tank]: NestType.Forge,
  [Kind.Lancer]: NestType.Spire,
  [Kind.Swift]: NestType.Swift,
};

export type PackId = 'swarm' | 'wall' | 'raid';
export interface Pack {
  name: string;
  blurb: string;
  kinds: number[];
  unlock: Unlock;
}
export const PACKS: Record<PackId, Pack> = {
  swarm: { name: 'Swarm', blurb: 'Two Swarmer broods, and Nova from the start.', kinds: [Kind.Dot, Kind.Dot], unlock: 'nova' },
  wall: { name: 'Wall', blurb: 'Swarmers and Shields, with Forges unlocked: Shields keep coming, and Fortify.', kinds: [Kind.Dot, Kind.Tank], unlock: NestType.Forge },
  raid: { name: 'Raid', blurb: 'Swarmers and Raiders, with Dens unlocked: fast captures, and Blink.', kinds: [Kind.Dot, Kind.Swift], unlock: NestType.Swift },
};

/** A camp unlock: a nest type (its units and power), or Nova. */
export type Unlock = number | 'nova';
export const UNLOCKS: Unlock[] = [NestType.Forge, NestType.Spire, NestType.Swift, NestType.Bastion, 'nova'];
export const UNLOCK_TEXT: Record<string, string> = {
  [NestType.Forge]: 'Forge: spawns Shields, unlocks Fortify',
  [NestType.Spire]: 'Spire: spawns Spears, unlocks Barrage',
  [NestType.Swift]: 'Den: spawns Raiders, unlocks Blink',
  [NestType.Bastion]: 'Bastion: unlocks Lockdown',
  nova: 'Nova: the shockwave power',
};

/** Camp prices (provisional). */
export const COST = {
  heal: 15,
  grow: (b: Brood) => 15 + 5 * b.grows,
  growBy: 4,
  nest: 35,
  nova: 25,
};

const FIRST = ['Ash', 'Gloam', 'Ember', 'Vex', 'Thorn', 'Rime', 'Sable', 'Cinder', 'Murk', 'Hollow', 'Briar', 'Dusk', 'Lumen', 'Shard'];
const LAST = ['wing', 'coil', 'maw', 'tide', 'fang', 'veil', 'mire', 'spark', 'thorn', 'drift', 'claw', 'song'];

/** A brood name, seeded and not already used in the roster. */
export function broodName(seed: number, taken: string[]): string {
  const rng = new Rng(seed);
  for (let k = 0; k < 40; k++) {
    const name = rng.pick(FIRST) + rng.pick(LAST);
    if (!taken.includes(name)) return name;
  }
  return `Brood ${taken.length + 1}`;
}

export function newBrood(id: number, kind: number, seed: number, taken: string[], size = START.size): Brood {
  return { id, name: broodName(seed + id * 977, taken), kind, size, cap: START.cap, wins: 0, wounded: 0, grows: 0, strains: [] };
}

export const fit = (b: Brood) => b.wounded === 0;
export const veteran = (b: Brood) => b.wins >= VETERAN_WINS;

/** The broods that actually fight from a pick: fit ones only, at most `max` (MAX_FIELDED, or 1 under Lone wolf). */
export const fighters = (broods: Brood[], fielded: number[], max = MAX_FIELDED): Brood[] =>
  broods.filter((b) => fielded.includes(b.id) && fit(b)).slice(0, max);

/** What happened to a brood after a battle, for the debrief. */
export interface BroodEvent {
  name: string;
  kind: number;
  what: 'grew' | 'shrank' | 'held' | 'wounded' | 'died' | 'rescued' | 'veteran' | 'recovered';
  size: number;
}

export interface BattleReport {
  won: boolean;
  /** your living units of each kind at the end (index = Kind) */
  survivors: number[];
  /** nests you held at the end */
  nests: number;
  seconds: number;
}

/**
 * Apply a battle to the roster. Win: each fielded brood takes its share of
 * your surviving units of its kind (at least MIN_SIZE, at most its cap) and a
 * win. Loss: fielded broods are wounded and halved; below MIN_SIZE they die.
 * Broods that sat out heal a battle's worth.
 */
export function settleBroods(broods: Brood[], fielded: number[], r: BattleReport): BroodEvent[] {
  const events: BroodEvent[] = [];
  const out = broods.filter((b) => fielded.includes(b.id));
  for (const b of broods) {
    if (fielded.includes(b.id) || b.wounded === 0) continue;
    b.wounded--;
    if (b.wounded === 0) events.push({ name: b.name, kind: b.kind, what: 'recovered', size: b.size });
  }
  if (r.won) {
    for (const b of out) {
      const sameKind = out.filter((o) => o.kind === b.kind).length;
      const share = Math.floor((r.survivors[b.kind] ?? 0) / sameKind);
      const before = b.size;
      const wasVet = veteran(b);
      b.size = Math.max(MIN_SIZE, Math.min(b.cap, share));
      b.wins++;
      events.push({ name: b.name, kind: b.kind, what: b.size > before ? 'grew' : b.size < before ? 'shrank' : 'held', size: b.size });
      if (!wasVet && veteran(b)) events.push({ name: b.name, kind: b.kind, what: 'veteran', size: b.size });
    }
    return events;
  }
  for (const b of out) {
    b.size = Math.floor(b.size / 2);
    if (b.size < MIN_SIZE) {
      broods.splice(broods.indexOf(b), 1);
      events.push({ name: b.name, kind: b.kind, what: 'died', size: 0 });
    } else {
      b.wounded = 1;
      events.push({ name: b.name, kind: b.kind, what: 'wounded', size: b.size });
    }
  }
  return events;
}

/** Biomass for a win: the node's base, nests held, survivors and speed. */
export function biomassFor(base: number, r: BattleReport): number {
  if (!r.won) return 0;
  const survivors = r.survivors.reduce((a, b) => a + b, 0);
  const speed = Math.max(0, Math.round((10 * (240 - r.seconds)) / 240));
  return base + r.nests + Math.floor(survivors / 5) + speed;
}
