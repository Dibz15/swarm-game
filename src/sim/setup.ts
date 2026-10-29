import { DOMINATION, Kind, LEVEL, MAX_LEVEL, NEST_KIND, NEST_RADIUS, NEUTRAL, NUM_FACTIONS } from './constants';
import { defaultMods, type FactionMods } from './mods';
import { Bot, DIFFICULTY, type BotConfig } from './ai/bot';
import { generateMap, type MapParams, type MapSpec, type CaveLevel, type CaveParams, type EventLevel, type EventParams, type MapLayout, type MapSize, type TerrainLevel, type TerrainParams } from './mapgen';
import { initEvents } from './events';
import { initHeart } from './heart';
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
  army?: { kind: number; count: number; vet?: boolean }[];
  /** bitmask of usable nest types (default: all); locked ones spawn Swarmers and grant no power */
  nestTypes?: number;
  /** stat modifiers (campaign rewards); default: none */
  mods?: FactionMods;
}

export interface MatchSetup {
  seed: number;
  size: MapSize;
  players: PlayerSetup[];
  /** tall map for portrait screens */
  portrait?: boolean;
  /** terrain preset or explicit amounts (default: none) */
  terrain?: TerrainLevel | TerrainParams;
  /** cave layout preset or explicit params (default: open map) */
  caves?: CaveLevel | CaveParams;
  /** neutral map events preset or explicit schedule (default: off) */
  events?: EventLevel | EventParams;
  /** how nests are spread (default: picked by the seed) */
  layout?: MapLayout | 'random';
  /** a hand-authored map (tutorial missions); replaces generation from the fields above */
  map?: MapSpec;
  /** nobody wins by elimination or domination: the mission script ends the match */
  endless?: boolean;
  /** share of nests needed for domination, instead of the map size's default */
  domShare?: number;
  /** the Bloom's heart (campaign finale): a rooted boss; strength = nodes the Bloom ate */
  heart?: { strength: number; rule: HeartRule };
  /** a warlord's stronghold (#100): this player's capital is a walled citadel; a human taking it wins */
  stronghold?: {
    player: number;
    /** its starting garrisons (citadel and inner nests) are this many times FORTIFY's: matched to the army you bring */
    scale?: number;
  };
}

/** The generator's params for a setup's map (thumbnails use this too, so they match the battle). */
export function mapParamsOf(setup: MatchSetup, portrait = setup.portrait): MapParams {
  return {
    seed: setup.seed,
    size: setup.size,
    players: setup.players.length,
    portrait,
    terrain: setup.terrain,
    caves: setup.caves,
    events: setup.events,
    layout: setup.layout,
    stronghold: setup.stronghold?.player,
  };
}

export const START_UNITS = 10;

export function createWorld(setup: MatchSetup): World {
  const map = setup.map ?? generateMap(mapParamsOf(setup));
  const w = new World(setup.seed, map.width, map.height, map.terrain);
  w.domShare = setup.domShare ?? DOMINATION.share[setup.size] ?? 0.7;
  w.endless = !!setup.endless;

  // Inactive factions get unique teams so they never count as allies.
  for (let f = 0; f < NUM_FACTIONS; f++) if (f !== NEUTRAL) w.setTeam(f, 200 + f);
  for (const p of setup.players) {
    const f = w.factions[p.faction];
    f.active = true;
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

    // Garrisons are made of the nest's own unit kind (tanks guard forges...).
    const gk = s.player >= 0 || NEST_KIND[s.type] < 0 ? Kind.Dot : NEST_KIND[s.type];
    // A player's garrison overrides the starting army (hand-authored maps).
    // A campaign army (broods) replaces it at the player's capital.
    const army = s.player >= 0 && w.nests[id].capital && !s.garrison ? setup.players[s.player].army : undefined;
    const kinds: { kind: number; vet: boolean }[] = army ? army.flatMap((a) => Array.from({ length: a.count }, () => ({ kind: a.kind, vet: !!a.vet }))) : [];
    const hold = setup.stronghold && s.player === setup.stronghold.player ? (setup.stronghold.scale ?? 1) : 1;
    const count = army ? kinds.length : s.player >= 0 ? Math.round((s.garrison || START_UNITS) * hold) : gk === Kind.Tank ? Math.ceil(s.garrison / 2.2) : s.garrison;
    if (s.player < 0) w.nests[id].garrison = count;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + w.rng.next() * 0.4;
      const rr = r * (0.5 + w.rng.next() * 0.6);
      const x = s.x + dcos(a) * rr, y = s.y + dsin(a) * rr;
      const ar = s.player >= 0 ? r + 14 : 6;
      const u = spawnUnit(w, owner, army ? kinds[k].kind : gk, x, y, s.player >= 0 ? s.x : x, s.player >= 0 ? s.y : y, ar);
      if (u >= 0 && army && kinds[k].vet) {
        w.vet[u] = 1;
        w.hp[u] *= LEVEL.veteranHp;
      }
    }
  });

  initEvents(w, map.events);
  if (setup.heart) initHeart(w, setup.heart.strength, setup.heart.rule);

  for (const p of setup.players) {
    const fs = w.factions[p.faction].stats;
    fs.peak = w.unitCount[p.faction];
  }
  return w;
}
