/**
 * Per-faction modifiers (#64): campaign rewards, and later warlord traits and
 * champion enemies. Plain multipliers (and a few additions) read where each
 * stat is used. Everything defaults to "no change", so skirmish and bots are
 * untouched. Set once from the match setup, never mid-match, so replays and
 * lockstep stay deterministic.
 */

import { UNIT_STATS } from './constants';

export interface KindMods {
  hp: number;
  speed: number;
  dps: number;
  range: number;
  /** Spear splash radius */
  splash: number;
  /** Shield taunt: < 1 draws fire from further away */
  taunt: number;
  /** Swarmer pack bonus */
  pack: number;
  /** Raider capture weight */
  capture: number;
  /** Swarm-call (#60): damage bonus a dying Swarmer gives its neighbours, 0 = off */
  call: number;
  /** Spikes (#60): share of the damage a unit is dealt that hits its attacker back */
  spikes: number;
  /** Phalanx (#60): less damage taken per nearby Shield */
  phalanx: number;
  /** Piercing (#60): Spear shots hit along a line instead of a splash */
  pierceLine: boolean;
  /** Skirmish (#60): badly hurt Raiders fall back to heal */
  skirmish: boolean;
  /** Arsonist (#60): drain on enemy nests with Raiders on them */
  arson: number;
}

export interface FactionMods {
  /** per unit kind (index = Kind) */
  kind: KindMods[];
  barrageBudget: number;
  novaRadius: number;
  novaDamage: number;
  surgeTicks: number;
  surgeCost: number;
  blinkRange: number;
  /** damage taken while fortified, on top of POWER.fortifyArmor */
  fortifyArmor: number;
  /** fortified units can't move */
  fortifyRoot: boolean;
  lockdownTicks: number;
  /** levels added to your capital at the start */
  capitalLevel: number;
  bastionRange: number;
  /** extra supply per nest held */
  supplyPerNest: number;
  crystalRate: number;
  energyRate: number;
  /** capture speed at every nest */
  captureRate: number;
  // Power variants with a rule of their own (#60); one per power, kept so by the campaign.
  /** Barrage Cluster: three small shells */
  cluster: boolean;
  /** Barrage Scorch: the impact burns on */
  scorch: boolean;
  /** Nova Implode: pulls enemies in */
  implode: boolean;
  /** Surge Mend: heals instead of the speed boost */
  mend: boolean;
  /** Blink Echo: ghosts left where the group was */
  echo: boolean;
  /** Fortify Thorns: share of each blow a fortified unit sends back */
  thorns: number;
  /** Lockdown Siphon: energy/s drained from a locked nest's owner */
  siphon: number;
  // Perks and pacts with a rule of their own (#60).
  /** supply drops land near you and you take them faster (×this), 0 = off */
  dropFavour: number;
  /** nests at this level and up spawn veterans */
  vetLevel: number;
  /** Blood price: powers cost units instead of energy */
  bloodPrice: boolean;
  /** control a nest starts at when you capture it (Scorched earth) */
  captureControl: number;
  /** spawn speed at every nest */
  spawnRate: number;
  /** Feral: no powers */
  noPowers: boolean;
}

export const defaultKindMods = (): KindMods => ({
  hp: 1,
  speed: 1,
  dps: 1,
  range: 1,
  splash: 1,
  taunt: 1,
  pack: 1,
  capture: 1,
  call: 0,
  spikes: 0,
  phalanx: 0,
  pierceLine: false,
  skirmish: false,
  arson: 1,
});

export function defaultMods(): FactionMods {
  return {
    kind: UNIT_STATS.map(defaultKindMods),
    barrageBudget: 1,
    novaRadius: 1,
    novaDamage: 1,
    surgeTicks: 1,
    surgeCost: 1,
    blinkRange: 1,
    fortifyArmor: 1,
    fortifyRoot: false,
    lockdownTicks: 1,
    capitalLevel: 0,
    bastionRange: 1,
    supplyPerNest: 0,
    crystalRate: 1,
    energyRate: 1,
    captureRate: 1,
    cluster: false,
    scorch: false,
    implode: false,
    mend: false,
    echo: false,
    thorns: 0,
    siphon: 0,
    dropFavour: 0,
    vetLevel: 3,
    bloodPrice: false,
    captureControl: 1,
    spawnRate: 1,
    noPowers: false,
  };
}
