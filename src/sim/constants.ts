// Core tuning constants for the deterministic simulation.

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const MAX_UNITS = 8192;
/** 6 playable colors + 1 neutral faction. Faction id == color index. */
export const NUM_FACTIONS = 7;
export const NEUTRAL = 6;
export const NEUTRAL_TEAM = 100;
export const FACTION_UNIT_CAP = 1000;
export const CELL = 32;

/**
 * Unit kinds. Players see them by their metaphor names (UNIT_STATS.name):
 * Dot = Swarmer, Tank = Shield, Lancer = Spear, Swift = Raider.
 * "Spears pierce Shields, Shields stop Swarmers, Swarmers overrun Spears."
 */
export const Kind = { Dot: 0, Tank: 1, Lancer: 2, Swift: 3 } as const;

export interface UnitStats {
  name: string;
  hp: number;
  dps: number;
  range: number;
  speed: number;
  size: number;
  /** seconds between spawns at nest level 1 */
  interval: number;
  /** separation radius */
  sep: number;
  /** bot strength weight */
  weight: number;
}

export const UNIT_STATS: readonly UnitStats[] = [
  { name: 'Swarmer', hp: 10, dps: 4, range: 22, speed: 40, size: 4.4, interval: 1.4, sep: 6.5, weight: 1 },
  { name: 'Shield', hp: 34, dps: 4.5, range: 20, speed: 28, size: 6.6, interval: 3.4, sep: 9, weight: 3 },
  { name: 'Spear', hp: 8, dps: 4.4, range: 52, speed: 32, size: 4.2, interval: 2.2, sep: 6.5, weight: 1.4 },
  { name: 'Raider', hp: 6, dps: 3.2, range: 18, speed: 72, size: 3.6, interval: 0.9, sep: 5.5, weight: 0.65 },
];
/**
 * Rock-paper-scissors damage multipliers: DAMAGE_VS[attacker][target].
 * Lancers beat Tanks, Tanks beat Dots, Dots beat Lancers; Swifts are raiders.
 */
export const DAMAGE_VS: readonly (readonly number[])[] = [
  //  Dot  Tank Lancer Swift
  [1.0, 0.6, 1.7, 1.0], // Dot
  [1.4, 1.0, 0.8, 1.2], // Tank
  [0.75, 1.2, 1.0, 0.8], // Lancer
  [1.0, 0.5, 1.0, 1.0], // Swift
];

/** Signature traits, one per unit kind. */
export const TRAITS = {
  /** Dots: +perAlly damage per nearby friendly Dot, up to max */
  pack: { radius: 22, perAlly: 0.07, max: 0.7 },
  /** Tanks: enemies treat a Tank as this fraction of its real distance when picking targets */
  taunt: 0.45,
  /** Lancers: each shot also hits up to `extra` enemies within `radius` of the target */
  pierce: { radius: 14, extra: 2, damage: 0.3 },
  /** Swifts: count this many times when capturing or draining a nest */
  raidCapture: 3,
};

/** units notice enemies this far beyond their attack range */
export const AGGRO_EXTRA = 26;
/** a unit shot from beyond its notice range turns on its attacker if it's within this much extra */
export const RETALIATE_EXTRA = 60;
/** when hit, a unit alerts idle allies this close, at most once per ALERT_EVERY ticks */
export const ALERT_RADIUS = 60;
export const ALERT_EVERY = 20;
/** how far an idle unit will chase from its order point */
export const LEASH = 90;
/** each unit re-searches for the nearest enemy every RETARGET ticks (staggered) */
export const RETARGET = 6;

export const NestType = { Hive: 0, Forge: 1, Spire: 2, Swift: 3, Bastion: 4 } as const;
export const NEST_NAMES = ['Hive', 'Forge', 'Spire', 'Den', 'Bastion'] as const;
/** unit kind spawned by each nest type; -1 = spawns nothing */
export const NEST_KIND: readonly number[] = [Kind.Dot, Kind.Tank, Kind.Lancer, Kind.Swift, Kind.Dot];
/** per-type spawn speed multiplier (Bastion trades production for defense) */
export const NEST_SPAWN_MULT: readonly number[] = [1, 1, 1, 1, 0.5];
export const NEST_RADIUS: readonly number[] = [26, 28, 26, 24, 25];
export const NEST_BLURB: readonly string[] = [
  'Spawns Swarmers: stronger in packs. They overrun Spears, but Shields stop them.',
  'Spawns Shields: draw enemy fire and stop Swarmers, but Spears pierce them. Unlocks Fortify (R).',
  'Spawns Spears: long range, splash. They pierce Shields, but Swarmers overrun them. Unlocks Barrage (F).',
  'Spawns Raiders: fast, fragile, capture nests 3× faster. Unlocks Blink (G).',
  'Spawns Swarmers slowly. Beam turret, shields nearby allies. Unlocks Lockdown (T).',
];
export const MAX_LEVEL = 3;
/** spawn speed multiplier by level (index = level) */
export const LEVEL_SPAWN_MULT: readonly number[] = [0, 1, 1.5, 2];
/** dots consumed to go from level L to L+1 (index = L) */
export const UPGRADE_COST: readonly number[] = [0, 20, 35, 0];
export const UPGRADE_PICK_RADIUS = 240;

export const BASTION = {
  range: 96,
  rangePerLevel: 16,
  /** player-owned turret damage per target */
  dps: 19,
  /** neutral Bastions hit softer so they aren't a trap to capture */
  neutralDps: 10,
  minControl: 0.5,
  aura: 0.65,
};

/** Turret damage per second and target count for a Bastion. */
export function bastionTurret(owner: number, level: number): { dps: number; targets: number } {
  return owner === NEUTRAL ? { dps: BASTION.neutralDps, targets: 1 } : { dps: BASTION.dps, targets: level };
}

/** Each player's starting nest: a built-in turret and stronger home armor, so a fast rush can't knock a player out early. */
export const CAPITAL = { range: 88, dps: 11, targets: 2, armor: 0.6 };

/**
 * Anti-snowball tuning.
 * - Production slows as an army grows past softCap + capPerNest * nests:
 *   mult = 1 / (1 + over / softScale). Sitting on one nest stalls early.
 * - Units near their own nests take less damage (home turf).
 * - Factions behind the leader charge energy faster.
 * - Each extra nest adds less production than the last.
 */
export const BALANCE = {
  softCap: 30,
  /** extra soft-cap headroom per nest held, so hoarding on one nest stalls sooner */
  capPerNest: 25,
  softScale: 160,
  homeRadius: 70,
  homeArmor: 0.75,
  underdogEnergy: 1.5,
  /** total production grows as nests^exp, so wide empires out-produce less */
  nestExponent: 0.9,
};

/**
 * Late-game escalation. The comeback rules above keep the early game close,
 * but with many players they can hold everyone level forever. From `start`
 * they fade out over `ramp` ticks so every match gets an endgame.
 */
export const ESCALATION = { start: 5 * 60 * TICK_HZ, ramp: 3 * 60 * TICK_HZ };

/** 0 before escalation, rising to 1 once it is complete. */
export function escalation(tick: number): number {
  const t = (tick - ESCALATION.start) / ESCALATION.ramp;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

export const ENERGY = { max: 100, passive: 0.9, kill: 0.2, capture: 15 };

export const POWER = {
  surgeCost: 30,
  surgeTicks: 6 * TICK_HZ,
  surgeSpeed: 1.7,
  surgeDmg: 1.6,
  /** damage taken multiplier while surged */
  surgeArmor: 0.7,
  novaCost: 60,
  novaDamage: 22,
  novaSacrifice: 0.2,
  novaKnock: 110,

  // Nest-granted powers: available while you hold a nest of that type.
  /** Forge: selected dots take less damage but move slower */
  fortifyCost: 25,
  fortifyTicks: 5 * TICK_HZ,
  fortifyArmor: 0.5,
  fortifySlow: 0.55,
  /** Spire: telegraphed artillery strike at a point */
  barrageCost: 40,
  barrageDelay: Math.round(1.2 * TICK_HZ),
  barrageRadius: 58,
  barrageDamage: 20,
  /** Swift: teleport the selected group toward a point */
  blinkCost: 30,
  blinkRange: 180,
  /** Bastion: stop an enemy nest from spawning or recovering control */
  lockdownCost: 35,
  lockdownTicks: 8 * TICK_HZ,
};

/** Which nest type grants each power. */
export const POWER_NEST = { fortify: 1, barrage: 2, blink: 3, lockdown: 4 } as const;
export type NestPower = keyof typeof POWER_NEST;

export const DOMINATION = {
  /** share of all nests a team must hold, by map size; large maps need less so endgames don't drag */
  share: { small: 0.7, medium: 0.7, large: 0.6 } as Record<string, number>,
  ticks: 30 * TICK_HZ,
};

/** Terrain: walls block movement and line of fire; fields change movement and fights. */
export const TERRAIN = {
  /** pathing keeps tile centers this far from walls */
  wallMargin: 6,
  /** largest unit radius, for bucketing walls by cell */
  maxUnitRadius: 4,
  /** shots may graze this far into a wall's edge */
  losGrace: 3,
  /** flow-field cost multipliers: units route around slow or dangerous ground when it pays */
  nebulaCost: 1.6,
  riftCost: 3,
  maxFields: 96,
  /** Nebula: movement speed multiplier */
  nebulaSlow: 0.55,
  /** Rift: damage per second to anything standing in it */
  riftDps: 2.4,
  /** Crystal: energy per second for the only team standing on it */
  crystalEnergy: 1.1,
};
