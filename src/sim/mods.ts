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
}

export const defaultKindMods = (): KindMods => ({ hp: 1, speed: 1, dps: 1, range: 1, splash: 1, taunt: 1, pack: 1, capture: 1 });

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
  };
}
