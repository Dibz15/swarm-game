import { DOMINATION, KEYS, Kind, LEVEL, MAX_LEVEL, NEST_KIND, NEST_RADIUS, NEUTRAL, NUM_FACTIONS, SURGE, TICK_HZ } from './constants';
import { defaultMods, type FactionMods } from './mods';
import { Bot, DIFFICULTY, type BotConfig } from './ai/bot';
import { generateMap, type MapParams, type MapSpec, type CaveLevel, type CaveParams, type EventLevel, type EventParams, type MapFill, type MapForm, type MapLayout, type MapSize, type TerrainLevel, type TerrainParams } from './mapgen';
import { initEvents } from './events';
import { initHeart } from './heart';
import { initSiege, type SiegeSetup } from './siege';
import { TAU, dcos, dsin } from './mathx';
import { spawnUnit, World, type HeartRule } from './world';

export interface PlayerSetup {
  /** faction id == color index 0..5 */
  faction: number;
  team: number;
  human: boolean;
  bot?: BotConfig;
  /** starting energy (tutorial missions; default 0) */
  energy?: number;
  /** hard army limit (tutorial opponents) */
  unitCap?: number;
  /** production multiplier, instead of the difficulty's (tutorial opponents) */
  prod?: number;
  /** starting army at the capital, instead of START_UNITS Swarmers (campaign broods) */
  army?: { kind: number; count: number; vet?: boolean; brood?: number }[];
  /** bitmask of usable nest types (default: all); locked ones spawn Swarmers and grant no power */
  nestTypes?: number;
  /** stat modifiers (campaign rewards); default: none */
  mods?: FactionMods;
}

export interface MatchSetup {
  seed: number;
  size: MapSize;
  players: PlayerSetup[];
  /** terrain preset or explicit amounts (default: none) */
  terrain?: TerrainLevel | TerrainParams;
  /** cave layout preset or explicit params (default: open map) */
  caves?: CaveLevel | CaveParams;
  /** neutral map events preset or explicit schedule (default: off) */
  events?: EventLevel | EventParams;
  /** how nests are spread (default: picked by the seed) */
  layout?: MapLayout | 'random';
  /** the map's large-scale form and fill (default: picked by the seed, #98) */
  form?: MapForm | 'random';
  fill?: MapFill | 'random';
  /** a hand-authored map (tutorial missions); replaces generation from the fields above */
  map?: MapSpec;
  /** nobody wins by elimination or domination: the mission script ends the match */
  endless?: boolean;
  /** share of nests needed for domination, instead of the map size's default */
  domShare?: number;
  /** the Bloom's heart (campaign finale): a rooted boss; strength = nodes the Bloom ate */
  heart?: { strength: number; rule: HeartRule; wound?: number };
  /** a warlord's stronghold (#100): this player's capital is a walled citadel; a human taking it wins */
  /** Hold the line (#67): the human, walled in, holds its capital against waves */
  siege?: SiegeSetup;
  /** key nests (#87, campaign Domination): scoring on them wins, instead of a share */
  keys?: number;
  /** Conquest's late Bloom surge (#87): on, with SURGE's timing, waves of this base size */
  surge?: { size: number };
  stronghold?: {
    player: number;
    /** its starting garrisons (citadel and inner nests) are this many times FORTIFY's: matched to the army you bring */
    scale?: number;
  };
}

/** Most human seats a match can hold: one per player color (#156). */
export const MAX_HUMANS = NEUTRAL;

/**
 * Reject setups the sim can't run (#156). Several human seats are fine in
 * FFA or teams; a Hold the line siege is built around a single human.
 */
export function validateSetup(setup: MatchSetup): void {
  const humans = setup.players.filter((p) => p.human).length;
  if (humans > MAX_HUMANS) throw new Error(`MatchSetup: ${humans} human seats, at most ${MAX_HUMANS}`);
  if (setup.siege && humans > 1) throw new Error(`MatchSetup: a siege (Hold the line) takes one human seat, not ${humans}`);
}

/** The generator's params for a setup's map (thumbnails use this too, so they match the battle). */
export function mapParamsOf(setup: MatchSetup): MapParams {
  validateSetup(setup);
  return {
    seed: setup.seed,
    size: setup.size,
    players: setup.players.length,
    terrain: setup.terrain,
    caves: setup.caves,
    events: setup.events,
    layout: setup.layout,
    form: setup.form,
    fill: setup.fill,
    keys: setup.keys,
    fortress: setup.stronghold?.player ?? (setup.siege ? setup.players.findIndex((p) => p.human) : undefined),
  };
}

export const START_UNITS = 10;

/**
 * Team matches (#213): a team's domination share starts from its slice of the
 * map (its players over all players), plus DOMINATION.take of the rest. Without
 * this, the bigger side of a 3v2 starts at about 60% and the 70% bar is nearly
 * free; in a 2v2, beating one rival is enough. FFA keeps `domShare`.
 */
function teamDomShares(w: World, setup: MatchSetup): void {
  const size = new Map<number, number>();
  for (const p of setup.players) size.set(p.team, (size.get(p.team) ?? 0) + 1);
  if (size.size === setup.players.length) return;
  for (const [team, k] of size) {
    const fair = k / setup.players.length;
    w.domShares[team] = fair + DOMINATION.take * (1 - fair);
  }
}

export function createWorld(setup: MatchSetup): World {
  validateSetup(setup);
  const map = setup.map ?? generateMap(mapParamsOf(setup));
  const w = new World(setup.seed, map.width, map.height, map.terrain);
  w.domShare = setup.domShare ?? DOMINATION.share[setup.size] ?? 0.7;
  w.endless = !!setup.endless;

  // Inactive factions get unique teams so they never count as allies.
  for (let f = 0; f < NUM_FACTIONS; f++) if (f !== NEUTRAL) w.setTeam(f, 200 + f);
  for (const p of setup.players) {
    const f = w.factions[p.faction];
    f.active = true;
    // A human seat stays `human` even while a bot drives it (#156: a dropped
    // player's Easy bot, see seats.ts), so win rules keep it the player's faction.
    f.human = p.human;
    f.energy = p.energy ?? 0;
    f.unitCap = p.unitCap ?? 0;
    if (p.nestTypes !== undefined) f.nestTypes = p.nestTypes;
    f.mods = p.mods ?? defaultMods();
    w.setTeam(p.faction, p.team);
    if (!p.human) {
      const cfg = p.bot ?? { difficulty: 1, personality: 'expander' };
      f.prodMult = p.prod ?? DIFFICULTY[cfg.difficulty]?.prod ?? 1;
      w.bots.push(new Bot(p.faction, cfg, setup.seed));
    }
  }

  if (setup.domShare === undefined) teamDomShares(w, setup);

  map.nests.forEach((s, id) => {
    const owner = s.player >= 0 ? setup.players[s.player].faction : NEUTRAL;
    const r = NEST_RADIUS[s.type];
    w.nests.push({
      id,
      x: s.x,
      y: s.y,
      r,
      type: s.type,
      owner,
      level: s.player >= 0 && s.capital !== false ? Math.min(MAX_LEVEL, s.level + (setup.players[s.player].mods?.capitalLevel ?? 0)) : s.level,
      control: 1,
      controller: owner,
      spawnAcc: 0,
      rallyX: s.x,
      rallyY: s.y,
      feedProgress: 0,
      feedIncoming: 0,
      lastSpawn: -100,
      contested: false,
      lockedUntil: 0,
      capital: s.player >= 0 && s.capital !== false,
      garrison: 0,
      visited: 0,
    });
    if (setup.stronghold && s.player === setup.stronghold.player && s.capital !== false) w.citadel = id;
    if (s.key) w.keys.push(id);

    // Garrisons are made of the nest's own unit kind (tanks guard forges...).
    const gk = s.player >= 0 || NEST_KIND[s.type] < 0 ? Kind.Dot : NEST_KIND[s.type];
    // A player's garrison overrides the starting army (hand-authored maps).
    // A campaign army (broods) replaces it at the player's capital.
    // (Holding the line, your fortress's capital garrison gives way to your broods too.)
    const army = s.player >= 0 && w.nests[id].capital && (!s.garrison || (setup.siege && setup.players[s.player].human)) ? setup.players[s.player].army : undefined;
    const kinds: { kind: number; vet: boolean; brood?: number }[] = army ? army.flatMap((a) => Array.from({ length: a.count }, () => ({ kind: a.kind, vet: !!a.vet, brood: a.brood }))) : [];
    const hold = setup.stronghold && s.player === setup.stronghold.player ? (setup.stronghold.scale ?? 1) : 1;
    const count = army ? kinds.length : s.player >= 0 ? Math.round((s.garrison || START_UNITS) * hold) : gk === Kind.Tank ? Math.ceil(s.garrison / 2.2) : s.garrison;
    if (s.player < 0) w.nests[id].garrison = count;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + w.rng.next() * 0.4;
      const rr = r * (0.5 + w.rng.next() * 0.6);
      const x = s.x + dcos(a) * rr, y = s.y + dsin(a) * rr;
      const ar = s.player >= 0 ? r + 14 : 6;
      const u = spawnUnit(w, owner, army ? kinds[k].kind : gk, x, y, s.player >= 0 ? s.x : x, s.player >= 0 ? s.y : y, ar);
      // Campaign broods (#134): each unit knows its brood, so a brood is credited with its own survivors.
      if (u >= 0 && army && kinds[k].brood !== undefined) w.brood[u] = kinds[k].brood! + 1;
      if (u >= 0 && army && kinds[k].vet) {
        w.vet[u] = 1;
        w.hp[u] *= LEVEL.veteranHp;
      }
    }
  });

  initEvents(w, map.events);
  if (w.keys.length) w.keySealUntil = KEYS.seal;
  if (setup.surge && w.events) {
    const at = SURGE.after * TICK_HZ;
    w.bloomSurge = { warnAt: at - SURGE.warn * TICK_HZ, next: at, every: SURGE.every * TICK_HZ, size: setup.surge.size, grow: SURGE.grow, swarms: SURGE.swarms, wave: 0 };
  }
  if (setup.heart) initHeart(w, setup.heart.strength, setup.heart.rule, setup.heart.wound);
  if (setup.siege) initSiege(w, setup.siege, setup.players.find((p) => p.human)?.faction ?? setup.players[0].faction);

  for (const p of setup.players) {
    const fs = w.factions[p.faction].stats;
    fs.peak = w.unitCount[p.faction];
  }
  return w;
}
