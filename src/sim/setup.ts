import { DOMINATION, Kind, NEST_KIND, NEST_RADIUS, NEUTRAL, NUM_FACTIONS } from './constants';
import { Bot, DIFFICULTY, type BotConfig } from './ai/bot';
import { generateMap, type MapSpec, type CaveLevel, type CaveParams, type EventLevel, type EventParams, type MapSize, type TerrainLevel, type TerrainParams } from './mapgen';
import { initEvents } from './events';
import { TAU, dcos, dsin } from './mathx';
import { spawnUnit, World } from './world';

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
  /** a hand-authored map (tutorial missions); replaces generation from the fields above */
  map?: MapSpec;
  /** nobody wins by elimination or domination: the mission script ends the match */
  endless?: boolean;
  /** share of nests needed for domination, instead of the map size's default */
  domShare?: number;
}

export const START_UNITS = 10;

export function createWorld(setup: MatchSetup): World {
  const map = setup.map ?? generateMap({
    seed: setup.seed,
    size: setup.size,
    players: setup.players.length,
    portrait: setup.portrait,
    terrain: setup.terrain,
    caves: setup.caves,
    events: setup.events,
  });
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
      level: s.level,
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

    // Garrisons are made of the nest's own unit kind (tanks guard forges...).
    const gk = s.player >= 0 || NEST_KIND[s.type] < 0 ? Kind.Dot : NEST_KIND[s.type];
    // A player's garrison overrides the starting army (hand-authored maps).
    const count = s.player >= 0 ? s.garrison || START_UNITS : gk === Kind.Tank ? Math.ceil(s.garrison / 2.2) : s.garrison;
    if (s.player < 0) w.nests[id].garrison = count;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + w.rng.next() * 0.4;
      const rr = r * (0.5 + w.rng.next() * 0.6);
      const x = s.x + dcos(a) * rr, y = s.y + dsin(a) * rr;
      const ar = s.player >= 0 ? r + 14 : 6;
      spawnUnit(w, owner, gk, x, y, s.player >= 0 ? s.x : x, s.player >= 0 ? s.y : y, ar);
    }
  });

  initEvents(w, map.events);

  for (const p of setup.players) {
    const fs = w.factions[p.faction].stats;
    fs.peak = w.unitCount[p.faction];
  }
  return w;
}
