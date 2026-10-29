import { ALL_NEST_TYPES, MAX_UNITS, NEUTRAL, NEUTRAL_TEAM, NUM_FACTIONS, UNIT_STATS } from './constants';
import { Rng } from './rng';
import { defaultMods, type FactionMods } from './mods';
import { Grid } from './spatial';
import { Terrain, emptyTerrain, type TerrainSpec } from './terrain';
import type { EventSpec } from './mapgen';
import type { Bot } from './ai/bot';

export interface Nest {
  id: number;
  x: number;
  y: number;
  r: number;
  type: number;
  /** owning faction, -1 = unowned (neutralized) */
  owner: number;
  level: number;
  /** 0..1 control of `controller` (== owner once captured) */
  control: number;
  controller: number;
  spawnAcc: number;
  rallyX: number;
  rallyY: number;
  feedProgress: number;
  feedIncoming: number;
  /** tick of the last spawn, for render pulses */
  lastSpawn: number;
  /** true while hostile units stand on it */
  contested: boolean;
  /** tick until which a Lockdown stops spawning and control recovery */
  lockedUntil: number;
  /** a player's starting nest: built-in turret + stronger home armor */
  capital: boolean;
  /** neutral guards this nest regrows toward (living-map events) */
  garrison: number;
  /** last tick anyone stood on it (unowned nests go wild again when left alone) */
  visited: number;
}

export interface FactionStats {
  spawned: number;
  kills: number;
  lost: number;
  captured: number;
  peak: number;
}

export interface Faction {
  id: number;
  active: boolean;
  team: number;
  human: boolean;
  energy: number;
  eliminated: boolean;
  eliminatedTick: number;
  prodMult: number;
  /** hard army limit on top of supply (tutorial opponents); 0 = none */
  unitCap: number;
  /**
   * Bitmask of nest types this faction may use (bit = NestType). A locked type
   * still captures, but spawns Swarmers and grants no power (campaign unlocks).
   */
  nestTypes: number;
  /** campaign rewards and the like; identity by default (see mods.ts) */
  mods: FactionMods;
  stats: FactionStats;
}

export type FxType =
  | 'capture'
  | 'neutralize'
  | 'levelup'
  | 'nova'
  | 'surge'
  | 'upgradeFail'
  | 'eliminated'
  | 'absorb'
  | 'escalation'
  | 'fortify'
  | 'barrage'
  | 'barrageHit'
  | 'blink'
  | 'lockdown'
  | 'crystal'
  | 'swarmSpawn'
  | 'dropIncoming'
  | 'dropTaken'
  | 'colossusSpawn'
  | 'colossusDown'
  | 'stomp'
  | 'domStart'
  | 'domBreak'
  | 'bloomSwarm'
  | 'heartWindup'
  | 'heartPulse'
  | 'heartPhase'
  | 'heartDown'
  | 'siegeWave'
  | 'capitalLost'
  | 'capitalRetaken';

export interface FxEvent {
  type: FxType;
  x: number;
  y: number;
  /** faction responsible */
  f: number;
  r: number;
  nest: number;
  /** previous owner, for capture/neutralize */
  prev: number;
  /** origin, for blink */
  x0: number;
  y0: number;
}

export interface Barrage {
  x: number;
  y: number;
  owner: number;
  /** tick the strike lands */
  impact: number;
  /** blast radius (bigger from a level-3 Spire) */
  r: number;
  /** the nest it was launched from, and when */
  x0: number;
  y0: number;
  t0: number;
}

/** An energy crystal; `holder` is the faction charging from it, or -1. */
export interface Crystal {
  x: number;
  y: number;
  r: number;
  holder: number;
  /** last faction to hold it, so passers-by don't re-announce it */
  last: number;
}

/** A supply drop: lands after a telegraph, then the only team on it fills `progress`. */
export interface Drop {
  x: number;
  y: number;
  lands: number;
  expires: number;
  /** 0..1, owned by `holder` (faction), -1 = nobody yet */
  progress: number;
  holder: number;
}

/** A wild swarm: neutral units hunting the biggest army nearby. */
export interface Swarm {
  uids: number[];
  tx: number;
  ty: number;
  /** a siege wave (#67): it hunts this faction, whatever else is near: its capital, or (raiders) its nearest other nest */
  hunt?: number;
  raid?: boolean;
}

/** A Colossus walking its path; `leg` is the waypoint it heads for. */
export interface Colossus {
  uid: number;
  path: [number, number][];
  leg: number;
  maxHp: number;
  /** a siege Colossus (#67): at the end of its path it stays, rather than walking off */
  stay?: boolean;
}

/** Runtime state of the map's events (schedule in `spec.params`). */
export interface EventState {
  spec: EventSpec;
  rng: Rng;
  nextSwarm: number;
  nextDrop: number;
  swarmCount: number;
  dropCount: number;
  swarms: Swarm[];
  drops: Drop[];
  colossi: Colossus[];
}

export const WILD_SWARM = 1;
export const WILD_COLOSSUS = 2;
/** the Bloom's heart: a rooted boss (campaign finale, see heart.ts) */
export const WILD_HEART = 3;

/** How the finale ends: the heart alone, or the heart and then the rivals (Brutal). */
export type HeartRule = 'heart' | 'heart+rivals';

/** Hold the line (#67): the kinds of Bloom wave. */
export type WaveKind = 'swarm' | 'brutes' | 'spears' | 'raiders' | 'pincer' | 'colossus';

export interface Wave {
  /** tick it arrives */
  at: number;
  kind: WaveKind;
  /** units (a Colossus wave: its escort) */
  size: number;
  /** spawn indices (into SiegeState.spawns): two for a pincer */
  from: number[];
}

/** Hold the line (#67): hold your capital until `until`, against a schedule of waves. */
export interface SiegeState {
  until: number;
  waves: Wave[];
  /** the next wave to come (index) */
  next: number;
  /** the defender and its capital nest */
  human: number;
  capital: number;
  /** tick the capital fell, or -1 */
  lostAt: number;
  spawns: [number, number][];
}

/** The Bloom's heart and its nests (campaign finale). */
export interface HeartState {
  uid: number;
  x: number;
  y: number;
  maxHp: number;
  strength: number;
  rule: HeartRule;
  /** 0, 1, 2: drops at 66% and 33% hp */
  phase: number;
  /** Bloom nests (ids): they release swarms while neutral and ward the heart */
  nests: number[];
  /** tick each Bloom nest next releases a swarm */
  nestNext: number[];
  nextPulse: number;
  /** tick the telegraphed pulse lands, or -1 */
  pulseAt: number;
  nextLob: number;
  nextCall: number;
  /** last tick an enemy was close */
  threat: number;
  /** wild swarms rally to the heart until this tick */
  recall: number;
  slain: boolean;
}

export const UNIT_FEEDING = 1;

/**
 * Entire game state. Units live in structure-of-arrays typed arrays indexed
 * by slot; dead slots are recycled through `free`. `uid` is a stable id used
 * by commands, since slots get reused.
 */
export class World {
  tick = 0;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;

  /** high-water slot count; iterate 0..n and check alive */
  n = 0;
  count = 0;
  nextUid = 1;

  readonly x = new Float64Array(MAX_UNITS);
  readonly y = new Float64Array(MAX_UNITS);
  readonly px = new Float64Array(MAX_UNITS);
  readonly py = new Float64Array(MAX_UNITS);
  readonly vx = new Float64Array(MAX_UNITS);
  readonly vy = new Float64Array(MAX_UNITS);
  readonly hp = new Float64Array(MAX_UNITS);
  readonly dmg = new Float64Array(MAX_UNITS);
  /** damage taken multiplier this tick (home turf, Bastion aura) */
  readonly armor = new Float64Array(MAX_UNITS);
  /** order point and arrival radius */
  readonly ox = new Float64Array(MAX_UNITS);
  readonly oy = new Float64Array(MAX_UNITS);
  readonly arrive = new Float64Array(MAX_UNITS);
  readonly owner = new Uint8Array(MAX_UNITS);
  readonly kind = new Uint8Array(MAX_UNITS);
  readonly alive = new Uint8Array(MAX_UNITS);
  readonly state = new Uint8Array(MAX_UNITS);
  readonly engaged = new Uint8Array(MAX_UNITS);
  readonly lastHit = new Int8Array(MAX_UNITS);
  readonly feedNest = new Int16Array(MAX_UNITS);
  readonly uid = new Uint32Array(MAX_UNITS);
  readonly tgt = new Int32Array(MAX_UNITS);
  readonly tgtUid = new Uint32Array(MAX_UNITS);
  /** tick until which the unit is surged */
  readonly surge = new Int32Array(MAX_UNITS);
  /** tick until which the unit is fortified */
  readonly fortify = new Int32Array(MAX_UNITS);
  /** last unit that hit this one (slot + uid), for retaliation */
  readonly attacker = new Int32Array(MAX_UNITS);
  readonly attackerUid = new Uint32Array(MAX_UNITS);
  /** last tick this unit alerted its neighbors (rate limit) */
  readonly alertTick = new Int32Array(MAX_UNITS);
  /** nearby friendly Dots last tick (pack bonus) */
  readonly pack = new Uint8Array(MAX_UNITS);
  /** spawned by a level-3 nest: extra HP */
  readonly vet = new Uint8Array(MAX_UNITS);
  /** neutral event units: WILD_SWARM, WILD_COLOSSUS or WILD_HEART, else 0 */
  readonly wild = new Uint8Array(MAX_UNITS);

  readonly free: number[] = [];
  readonly uidToSlot = new Map<number, number>();

  readonly factions: Faction[] = [];
  readonly teamOf = new Int32Array(NUM_FACTIONS);
  readonly unitCount = new Int32Array(NUM_FACTIONS);
  nests: Nest[] = [];
  readonly grid: Grid;
  readonly terrain: Terrain;
  crystals: Crystal[] = [];
  /** living-map events, or null when they're off */
  events: EventState | null = null;
  /** the Bloom's heart (campaign finale), or null */
  heart: HeartState | null = null;
  /** a stronghold's citadel nest (#100): a human taking it wins; -1 if none */
  citadel = -1;
  /** Hold the line (#67), or null */
  siege: SiegeState | null = null;
  bots: Bot[] = [];

  /** attacker/target pairs this tick; attacker < 0 means nest -(a+1) */
  readonly beams = new Int32Array(MAX_UNITS * 2 + 512);
  beamCount = 0;
  /** x, y, owner triples; drained by the client */
  deaths: number[] = [];
  fx: FxEvent[] = [];
  /** pending Barrage strikes */
  barrages: Barrage[] = [];

  /** share of nests a team must hold for DOMINATION.ticks to win */
  domShare = 0.7;
  over = false;
  winnerTeam = -1;
  /** no elimination or domination win (tutorial missions without an opponent) */
  endless = false;
  /** how the match ended */
  winReason: '' | 'elimination' | 'domination' | 'heart' | 'citadel' | 'held' | 'fallen' = '';
  /** consecutive ticks each team has held the domination share */
  readonly domTicks = new Int32Array(NEUTRAL_TEAM + 1);
  /** per-faction unit counts sampled once a second */
  readonly history: number[][] = [];

  constructor(seed: number, width: number, height: number, terrain: TerrainSpec = emptyTerrain()) {
    this.seed = seed >>> 0;
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed ^ 0x51f15e);
    this.grid = new Grid(width, height);
    this.terrain = new Terrain(terrain, width, height);
    this.crystals = terrain.crystals.map((c) => ({ x: c.x, y: c.y, r: c.r, holder: -1, last: -1 }));
    for (let f = 0; f < NUM_FACTIONS; f++) {
      this.factions.push({
        id: f,
        active: f === NEUTRAL,
        team: f === NEUTRAL ? NEUTRAL_TEAM : f,
        human: false,
        energy: 0,
        eliminated: false,
        eliminatedTick: 0,
        prodMult: 1,
        unitCap: 0,
        nestTypes: ALL_NEST_TYPES,
        mods: defaultMods(),
        stats: { spawned: 0, kills: 0, lost: 0, captured: 0, peak: 0 },
      });
      this.teamOf[f] = f === NEUTRAL ? NEUTRAL_TEAM : f;
      this.history.push([]);
    }
  }

  setTeam(f: number, team: number): void {
    this.factions[f].team = team;
    this.teamOf[f] = team;
  }

  hostile(a: number, b: number): boolean {
    return this.teamOf[a] !== this.teamOf[b];
  }
}

export function spawnUnit(
  w: World,
  owner: number,
  kind: number,
  x: number,
  y: number,
  ox: number,
  oy: number,
  arrive: number,
): number {
  if (w.count >= MAX_UNITS) return -1;
  const i = w.free.length > 0 ? w.free.pop()! : w.n++;
  w.x[i] = x;
  w.y[i] = y;
  w.px[i] = x;
  w.py[i] = y;
  w.vx[i] = 0;
  w.vy[i] = 0;
  w.hp[i] = UNIT_STATS[kind].hp * w.factions[owner].mods.kind[kind].hp;
  w.dmg[i] = 0;
  w.armor[i] = 1;
  w.ox[i] = ox;
  w.oy[i] = oy;
  w.arrive[i] = arrive;
  w.owner[i] = owner;
  w.kind[i] = kind;
  w.alive[i] = 1;
  w.state[i] = 0;
  w.engaged[i] = 0;
  w.lastHit[i] = -1;
  w.feedNest[i] = -1;
  w.tgt[i] = -1;
  w.tgtUid[i] = 0;
  w.surge[i] = 0;
  w.fortify[i] = 0;
  w.pack[i] = 0;
  w.wild[i] = 0;
  w.vet[i] = 0;
  w.attacker[i] = -1;
  w.attackerUid[i] = 0;
  w.alertTick[i] = -1000;
  const uid = w.nextUid++;
  w.uid[i] = uid;
  w.uidToSlot.set(uid, i);
  w.count++;
  w.unitCount[owner]++;
  return i;
}

export function removeUnit(w: World, i: number): void {
  if (!w.alive[i]) return;
  if (w.state[i] === UNIT_FEEDING) {
    const n = w.nests[w.feedNest[i]];
    if (n) n.feedIncoming--;
    w.state[i] = 0;
  }
  w.alive[i] = 0;
  w.uidToSlot.delete(w.uid[i]);
  w.free.push(i);
  w.count--;
  w.unitCount[w.owner[i]]--;
}

export function pushFx(
  w: World,
  type: FxType,
  x: number,
  y: number,
  f: number,
  r = 0,
  nest = -1,
  prev = -1,
  x0 = 0,
  y0 = 0,
): void {
  w.fx.push({ type, x, y, f, r, nest, prev, x0, y0 });
}
