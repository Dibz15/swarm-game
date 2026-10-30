/**
 * Rewards (#64): after every won node you pick 1 of 3. Strains attach to a
 * brood and change every unit of its kind you field with it; power variants,
 * perks and pacts last the whole run. All of them are numbers in the sim's
 * FactionMods (src/sim/mods.ts). Pure: no DOM.
 *
 * PROVISIONAL: tiers and values are first guesses until the reward-impact
 * probe (phase 7, #68) measures them.
 */

import { Kind, POWER_NEST } from '../sim/constants';
import { defaultMods, type FactionMods } from '../sim/mods';
import { Rng, hashString } from '../sim/rng';
import type { Brood } from './broods';
import { trophyOf } from './warlords';

export type Tier = 'common' | 'uncommon' | 'rare';
export type Family = 'strain' | 'power' | 'perk' | 'pact';
export type Power = 'surge' | 'nova' | 'fortify' | 'barrage' | 'blink' | 'lockdown';

export interface Reward {
  id: string;
  name: string;
  text: string;
  family: Family;
  tier: Tier;
  /** strains: the unit kind they belong to */
  kind?: number;
  /** power variants: the power they change (one variant per power) */
  power?: Power;
  apply: (m: FactionMods) => void;
}

/** a brood carries at most this many strains */
export const STRAIN_SLOTS = 2;
/** rerolling an offer: base + step per reroll already made on it */
export const REROLL = { base: 10, step: 5 };
/** offer weights per tier (PROVISIONAL); warlord domains tilt these (DOMAIN_WEIGHT in warlords.ts) */
export const TIER_WEIGHT: Record<Tier, number> = { common: 60, uncommon: 30, rare: 10 };
/** Hunger's Bloom speed-up */
export const HUNGER_BLOOM = 1.25;

const strain = (id: string, name: string, kind: number, tier: Tier, text: string, f: (k: FactionMods['kind'][number]) => void): Reward => ({
  id,
  name,
  text,
  family: 'strain',
  tier,
  kind,
  apply: (m) => f(m.kind[kind]),
});
const variant = (id: string, name: string, power: Power, tier: Tier, text: string, apply: (m: FactionMods) => void): Reward => ({
  id,
  name,
  text,
  family: 'power',
  tier,
  power,
  apply,
});

export const REWARDS: Reward[] = [
  // Swarmer strains
  strain('frenzy', 'Frenzy', Kind.Dot, 'uncommon', 'Bigger pack bonus: +60% from nearby Swarmers', (k) => (k.pack *= 1.6)),
  strain('lean', 'Lean', Kind.Dot, 'common', '+15% speed, −15% HP', (k) => ((k.speed *= 1.15), (k.hp *= 0.85))),
  strain('thick-hide', 'Thick hide', Kind.Dot, 'common', '+25% HP, −10% speed', (k) => ((k.hp *= 1.25), (k.speed *= 0.9))),
  strain('swarm-call', 'Swarm-call', Kind.Dot, 'uncommon', 'A dying Swarmer rouses those nearby: +25% damage and +20% speed for 2 s', (k) => (k.call = 0.25)),
  // Shield strains
  strain('plated', 'Plated', Kind.Tank, 'common', '+30% HP', (k) => (k.hp *= 1.3)),
  strain('bulwark', 'Bulwark', Kind.Tank, 'uncommon', 'Enemies pick Shields as targets from further away', (k) => (k.taunt *= 0.6)),
  strain('spikes', 'Spikes', Kind.Tank, 'common', 'A quarter of the damage Shields are dealt hits the attacker back', (k) => (k.spikes = 0.25)),
  strain('phalanx', 'Phalanx', Kind.Tank, 'uncommon', 'Shields take 8% less damage for each Shield beside them (up to 3)', (k) => (k.phalanx = 0.08)),
  // Spear strains
  strain('barbed', 'Barbed', Kind.Lancer, 'uncommon', '+40% splash radius', (k) => (k.splash *= 1.4)),
  strain('longshot', 'Longshot', Kind.Lancer, 'common', '+25% range, −15% damage', (k) => ((k.range *= 1.25), (k.dps *= 0.85))),
  strain('quickdraw', 'Quickdraw', Kind.Lancer, 'rare', '+25% damage (faster shots)', (k) => (k.dps *= 1.25)),
  strain('piercing', 'Piercing', Kind.Lancer, 'uncommon', 'Shots carry on through a line of enemies behind the target', (k) => (k.pierceLine = true)),
  // Raider strains
  strain('saboteur', 'Saboteur', Kind.Swift, 'common', 'Raiders capture 40% faster still', (k) => (k.capture *= 1.4)),
  strain('fleet', 'Fleet', Kind.Swift, 'common', '+15% speed', (k) => (k.speed *= 1.15)),
  strain('skirmish', 'Skirmish', Kind.Swift, 'common', 'Badly hurt Raiders fall back to a nest, heal, and return', (k) => (k.skirmish = true)),
  strain('arsonist', 'Arsonist', Kind.Swift, 'rare', 'Enemy nests with your Raiders on them lose control 60% faster', (k) => (k.arson = 1.6)),
  // Power variants
  variant('heavy-shell', 'Heavy shell', 'barrage', 'uncommon', 'Barrage: +50% damage budget', (m) => (m.barrageBudget *= 1.5)),
  variant('cluster', 'Cluster', 'barrage', 'uncommon', 'Barrage: three smaller shells land one after another round the target', (m) => (m.cluster = true)),
  variant('scorch', 'Scorch', 'barrage', 'uncommon', 'Barrage: a weaker blast, but the ground burns for 6 s', (m) => (m.scorch = true)),
  variant('wide', 'Wide', 'nova', 'common', 'Nova: +35% radius, −25% damage', (m) => ((m.novaRadius *= 1.35), (m.novaDamage *= 0.75))),
  variant('implode', 'Implode', 'nova', 'common', 'Nova: pulls enemies in instead of throwing them out, −25% damage', (m) => (m.implode = true)),
  variant('overdrive', 'Overdrive', 'surge', 'uncommon', 'Surge: lasts 50% longer and costs 30% less', (m) => ((m.surgeTicks *= 1.5), (m.surgeCost *= 0.7))),
  variant('mend', 'Mend', 'surge', 'uncommon', 'Surge: heals 35% of HP over its length instead of the speed boost', (m) => (m.mend = true)),
  variant('long-jump', 'Long jump', 'blink', 'common', 'Blink: +50% range', (m) => (m.blinkRange *= 1.5)),
  variant('echo', 'Echo', 'blink', 'rare', 'Blink: ghosts stay behind for 4 s and draw enemy fire', (m) => (m.echo = true)),
  variant('root', 'Root', 'fortify', 'uncommon', "Fortify: units can't move, but take 40% less damage again", (m) => ((m.fortifyArmor *= 0.6), (m.fortifyRoot = true))),
  variant('thorns', 'Thorns', 'fortify', 'common', 'Fortify: fortified units send 30% of each blow back at the attacker', (m) => (m.thorns = 0.3)),
  variant('long', 'Long', 'lockdown', 'common', 'Lockdown: lasts 50% longer', (m) => (m.lockdownTicks *= 1.5)),
  variant('siphon', 'Siphon', 'lockdown', 'uncommon', 'Lockdown: drains 1.2 energy/s from its owner to you, but is 20% shorter and rests 10 s after', (m) => ((m.lockdownTicks *= 0.8), (m.siphon = 1.2))),
  // Nest and economy perks
  { id: 'capital', name: 'Seasoned capital', text: 'Your capital starts at level 2', family: 'perk', tier: 'rare', apply: (m) => (m.capitalLevel += 1) },
  { id: 'bastion-range', name: 'Long watch', text: 'Bastion turrets reach 30% further', family: 'perk', tier: 'common', apply: (m) => (m.bastionRange *= 1.3) },
  { id: 'supply', name: 'Deep stores', text: '+1 supply per nest held', family: 'perk', tier: 'uncommon', apply: (m) => (m.supplyPerNest += 1) },
  { id: 'crystals', name: 'Crystal sense', text: 'Crystals charge 25% faster', family: 'perk', tier: 'common', apply: (m) => (m.crystalRate *= 1.25) },
  { id: 'energy', name: 'Rich blood', text: '+15% energy income', family: 'perk', tier: 'uncommon', apply: (m) => (m.energyRate *= 1.15) },
  { id: 'capture', name: 'Quick claim', text: 'Capture every nest 25% faster', family: 'perk', tier: 'common', apply: (m) => (m.captureRate *= 1.25) },
  {
    id: 'drops',
    name: 'Kind skies',
    text: 'Supply drops usually land near you, and you take them 50% faster',
    family: 'perk',
    tier: 'uncommon',
    apply: (m) => (m.dropFavour = 1.5),
  },
  { id: 'old-blood', name: 'Old blood', text: 'Level-2 nests spawn veterans (+35% HP), not just level 3', family: 'perk', tier: 'rare', apply: (m) => (m.vetLevel = 2) },
  // Pacts: strong, with a drawback
  {
    id: 'glass',
    name: 'Glass swarm',
    text: '+30% damage, −20% HP, for every unit',
    family: 'pact',
    tier: 'rare',
    apply: (m) => m.kind.forEach((k) => ((k.dps *= 1.3), (k.hp *= 0.8))),
  },
  { id: 'hunger', name: 'Hunger', text: 'Double biomass from battles, but the Bloom advances 25% faster', family: 'pact', tier: 'rare', apply: () => {} },
  { id: 'lone-wolf', name: 'Lone wolf', text: 'Field only one brood, but it fights twice as large', family: 'pact', tier: 'rare', apply: () => {} },
  {
    id: 'blood-price',
    name: 'Blood price',
    text: 'Powers cost no energy, but one of your units for every 6 energy they would have cost',
    family: 'pact',
    tier: 'rare',
    apply: (m) => (m.bloodPrice = true),
  },
  {
    id: 'scorched-earth',
    name: 'Scorched earth',
    text: 'Nests you capture start half-held and must recover before they spawn, but every nest spawns 20% faster',
    family: 'pact',
    tier: 'rare',
    apply: (m) => ((m.captureControl = 0.5), (m.spawnRate *= 1.2)),
  },
  { id: 'feral', name: 'Feral', text: 'No powers at all, but every nest spawns 25% faster', family: 'pact', tier: 'rare', apply: (m) => ((m.noPowers = true), (m.spawnRate *= 1.25)) },
];

export const REWARD: Record<string, Reward> = Object.fromEntries(REWARDS.map((r) => [r.id, r]));

/** What an offer needs to know about the run (kept narrow so run.ts can import this). */
export interface OfferRun {
  seed: number;
  turn: number;
  broods: Brood[];
  perks: string[];
  unlocks: { nests: number; nova: boolean };
}

/** Is this power usable in the run? Surge always; Nova and nest powers once unlocked. */
function powerOpen(run: OfferRun, p: Power): boolean {
  if (p === 'surge') return true;
  if (p === 'nova') return run.unlocks.nova;
  return !!(run.unlocks.nests & (1 << POWER_NEST[p]));
}

/** Could this reward be offered now? */
export function offerable(run: OfferRun, r: Reward): boolean {
  if (r.family === 'strain') {
    // Some brood of its kind still has room for it.
    return run.broods.some((b) => b.kind === r.kind && !b.strains.includes(r.id));
  }
  if (run.perks.includes(r.id)) return false;
  // Feral gives up powers: no variants, and no paying for them in blood.
  const feral = run.perks.includes('feral');
  if (r.power) return !feral && powerOpen(run, r.power);
  if (r.id === 'blood-price') return !feral;
  if (r.id === 'feral') return !run.perks.includes('blood-price');
  return true;
}

/** Up to three different rewards, weighted by tier, from the run seed, turn and reroll count. */
export function rollOffer(run: OfferRun, rerolls: number, weight: Record<Tier, number> = TIER_WEIGHT): string[] {
  const rng = new Rng(hashString(`offer:${run.seed}:${run.turn}:${rerolls}`));
  const pool = REWARDS.filter((r) => offerable(run, r));
  const out: string[] = [];
  while (out.length < 3 && pool.length) {
    const total = pool.reduce((s, r) => s + weight[r.tier], 0);
    let x = rng.next() * total;
    let k = 0;
    while (k < pool.length - 1 && x >= weight[pool[k].tier]) x -= weight[pool[k++].tier];
    out.push(pool[k].id);
    pool.splice(k, 1);
  }
  return out;
}

/** The match modifiers for a battle: the run's perks, plus the strains of the broods that fight. */
export function modsFor(perks: string[], fighting: Brood[]): FactionMods {
  const m = defaultMods();
  for (const id of perks) (REWARD[id] ?? trophyOf(id))?.apply(m);
  // Two broods of one kind both lend their strains; the same strain doesn't stack.
  const strains = new Set(fighting.flatMap((b) => b.strains));
  for (const id of strains) REWARD[id]?.apply(m);
  return m;
}

export const POWER_LABEL: Record<Power, string> = { surge: 'Surge', nova: 'Nova', fortify: 'Fortify', barrage: 'Barrage', blink: 'Blink', lockdown: 'Lockdown' };
export const FAMILY_LABEL: Record<Family, string> = { strain: 'Strain', power: 'Power variant', perk: 'Perk', pact: 'Pact' };
