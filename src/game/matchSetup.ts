/**
 * Match setups from the player's saved preferences (#147: moved out of the UI so
 * the tutorial's real 1v1 can build its own): the skirmish screen's choices, a
 * random seed name, and the ready-made quick matches the menu suggests.
 */

import { DIFFICULTY, PERSONALITIES, type Personality } from '../sim/ai/bot';
import type { CaveLevel, EventLevel, MapLayout, MapSize, TerrainLevel } from '../sim/mapgen';
import { hashString } from '../sim/rng';
import { MAX_DEFENDERS, type MatchSetup } from '../sim/setup';
import { siegeAt, type SiegeSetup } from '../sim/siege';

export interface BotRow {
  faction: number;
  difficulty: number;
  personality: Personality | 'random';
  team: number;
}

export interface SetupPrefs {
  color: number;
  size: MapSize;
  terrain: TerrainLevel;
  caves: CaveLevel;
  layout: MapLayout | 'random';
  events: EventLevel;
  teams: boolean;
  bots: BotRow[];
  /** the match type (#222) */
  mode: MatchMode;
  /** Stronghold: the bot (index in `bots`) that holds the citadel */
  holder: number;
  /** Hold the line: how hard the waves are, 0..2 */
  waves: number;
}

const DEFAULT_PREFS: SetupPrefs = {
  color: 0,
  size: 'medium',
  terrain: 'standard',
  caves: 'off',
  layout: 'random',
  events: 'normal',
  teams: false,
  bots: [
    { faction: 1, difficulty: 1, personality: 'random', team: 1 },
    { faction: 2, difficulty: 1, personality: 'random', team: 2 },
    { faction: 3, difficulty: 1, personality: 'random', team: 3 },
  ],
  mode: 'conquest',
  holder: 0,
  waves: 1,
};

export function loadPrefs(): SetupPrefs {
  try {
    const raw = localStorage.getItem('swarm.setup');
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return structuredClone(DEFAULT_PREFS);
}

export function savePrefs(p: SetupPrefs): void {
  try {
    localStorage.setItem('swarm.setup', JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function randomSeed(): string {
  const words = ['ember', 'tide', 'nova', 'moss', 'flux', 'drift', 'spark', 'hollow', 'prism', 'vale', 'echo', 'glint', 'rune', 'haze'];
  const r = () => words[Math.floor(Math.random() * words.length)];
  return `${r()}-${r()}-${Math.floor(Math.random() * 100)}`;
}

function weighted<T>(opts: [T, number][], rnd: () => number): T {
  let r = rnd() * opts.reduce((s, o) => s + o[1], 0);
  for (const [v, wt] of opts) if ((r -= wt) < 0) return v;
  return opts[opts.length - 1][0];
}

/**
 * A random map for `sides` players and bots (Quick match, and multiplayer's
 * random map, #184): bigger maps for more of them, never a small one for five
 * or more.
 */
export function randomMap(sides: number, rnd: () => number = Math.random): { size: MapSize; terrain: TerrainLevel; caves: CaveLevel; layout: MapLayout | 'random'; events: EventLevel } {
  const size: MapSize = sides <= 2 ? 'small' : sides <= 4 ? weighted<MapSize>([['small', 1], ['medium', 3]], rnd) : weighted<MapSize>([['medium', 1], ['large', 3]], rnd);
  return {
    size,
    terrain: weighted<TerrainLevel>([['light', 2], ['standard', 5], ['heavy', 2]], rnd),
    caves: weighted<CaveLevel>([['off', 6], ['belt', 2], ['full', 1]], rnd),
    layout: 'random',
    events: weighted<EventLevel>([['calm', 2], ['normal', 6], ['wild', 1]], rnd),
  };
}

/** The match seed for a seed text. */
export const seedOf = (seedText: string): number => hashString(seedText.trim() || 'swarm');

/** Resolves "random" personalities in order, deterministically from the seed. */
export function personalityPicker(seed: number): (p: Personality | 'random') => Personality {
  let s = seed;
  return (p) => {
    if (p !== 'random') return p;
    s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x6b43a9b5) >>> 0;
    return PERSONALITIES[s % PERSONALITIES.length];
  };
}

export function buildSetup(p: SetupPrefs, seedText: string): MatchSetup {
  const seed = seedOf(seedText);
  const pick = personalityPicker(seed);
  // Hold the line is you against the Bloom: no bots (#222)
  const bots = p.mode === 'hold' ? [] : p.bots;
  const setup: MatchSetup = {
    seed,
    size: p.size,
    terrain: p.terrain,
    caves: p.caves,
    layout: p.layout,
    events: p.events,
    players: [
      { faction: p.color, team: 0, human: true },
      ...bots.map((b, i) => ({
        faction: b.faction,
        team: p.teams ? b.team : i + 1,
        human: false,
        bot: { difficulty: b.difficulty, personality: pick(b.personality) },
      })),
    ],
  };
  return applyMode(setup, p.mode, { holder: 1 + p.holder, waves: p.waves });
}

// ---- match types (#222) --------------------------------------------------------

/**
 * The match types a skirmish or a room can be, as in the campaign:
 * - conquest: wipe out the rivals, or hold the map's share of nests;
 * - domination: score on the key nests (#87);
 * - stronghold: a bot holds a walled citadel (#100); a player taking it wins;
 * - hold: Hold the line (#67), walled in against the Bloom's waves, alone.
 */
export type MatchMode = 'conquest' | 'domination' | 'stronghold' | 'hold';
export const MATCH_MODES: readonly MatchMode[] = ['conquest', 'domination', 'stronghold', 'hold'];

export const MATCH_MODE_LABEL: Record<MatchMode, string> = {
  conquest: 'Conquest',
  domination: 'Domination',
  stronghold: 'Stronghold',
  hold: 'Hold the line',
};

export const MATCH_MODE_BLURB: Record<MatchMode, string> = {
  conquest: 'wipe out the rivals, or hold most of the nests',
  domination: 'score on the gold-ringed key nests',
  stronghold: 'a bot holds a walled citadel: take it to win',
  hold: 'walled in, hold your capital against the Bloom’s waves',
};

/** Key nests in a Domination battle (#87): two, three with three rivals or more. */
export const keyNests = (rivals: number) => (rivals >= 3 ? 3 : 2);
/** Domination's nest share, with key nests only the HUD's guide (#87). */
export const DOMINATION_SHARE = 0.5;
/** A stronghold's holder starts with three nests: production in its stronghold (#100). */
export const STRONGHOLD_PROD = 0.7;
/** A stronghold match's nest share: the holder's three nests would make the usual share a head start. */
export const STRONGHOLD_SHARE = 0.8;
/**
 * A skirmish stronghold's garrisons grow this much for each side attacking it
 * past the first (#222), so a crowd can't just walk in. PROVISIONAL.
 */
export const STRONGHOLD_PER_SIDE = 0.25;

/** Hold the line's wave levels, as the skirmish offers them. */
export const WAVE_NAMES = ['Easy', 'Normal', 'Hard'] as const;

/**
 * A skirmish's Hold the line (#222): the campaign's siege curve at a run's
 * start, middle and end, without a run's Bloom growth.
 */
export const skirmishSiege = (level: number): SiegeSetup => siegeAt(Math.max(0, Math.min(2, Math.round(level))) / 2);

/**
 * Teams on but every bot on your team (A): the last bot goes to team B, so
 * there's someone to fight. The skirmish screen does this at Start.
 */
export function settleTeams(p: SetupPrefs): void {
  if (p.teams && p.bots.length && p.bots.every((b) => b.team === 0)) p.bots[p.bots.length - 1].team = 1;
}

/** Why the skirmish screen's choices can't be played as their match type (#222), or null: as Start would build them. */
export function prefsProblem(p: SetupPrefs): string | null {
  const settled = structuredClone(p);
  settleTeams(settled);
  return modeProblem(buildSetup({ ...settled, mode: 'conquest' }, ''), p.mode, 1 + p.holder);
}

/** The sides in a setup: distinct teams. */
const sidesOf = (s: MatchSetup) => new Set(s.players.map((p) => p.team)).size;

/** Whether a setup can be played as a mode; if not, why. */
export function modeProblem(s: MatchSetup, mode: MatchMode, holder: number): string | null {
  if (mode === 'stronghold') {
    const h = s.players[holder];
    if (!h || h.human) return 'A bot has to hold the stronghold';
    if (s.players.some((p) => p.human && p.team === h.team)) return 'The stronghold’s side is bots only';
    if (!s.players.some((p) => p.team !== h.team)) return 'Someone has to attack the stronghold';
  }
  if (mode === 'hold' && !s.players.some((p) => p.human)) return 'Someone has to hold the line';
  if (mode === 'hold' && s.players.filter((p) => p.human).length > MAX_DEFENDERS) return `Hold the line takes at most ${MAX_DEFENDERS} players`;
  return null;
}

/**
 * A setup played as `mode` (#222). `holder` is the stronghold's player (an
 * index in `players`, a bot), `waves` Hold the line's level. A setup that
 * can't be played that way (`modeProblem`) stays Conquest.
 */
export function applyMode(s: MatchSetup, mode: MatchMode, o: { holder?: number; waves?: number } = {}): MatchSetup {
  const holder = o.holder ?? s.players.findIndex((p) => !p.human);
  if (mode === 'conquest' || modeProblem(s, mode, holder)) return s;
  switch (mode) {
    case 'domination':
      return { ...s, keys: keyNests(sidesOf(s) - 1), domShare: DOMINATION_SHARE };
    case 'stronghold': {
      const h = s.players[holder];
      const attackers = new Set(s.players.filter((p) => p.team !== h.team).map((p) => p.team)).size;
      const players = s.players.map((p, i) =>
        // In its stronghold the holder turtles, whatever its temper, and spawns slower: it starts with three nests.
        i === holder ? { ...p, prod: (DIFFICULTY[p.bot!.difficulty]?.prod ?? 1) * STRONGHOLD_PROD, bot: { ...p.bot!, personality: 'turtler' as const, citadel: true } } : p,
      );
      // No cave rock in a fortress: it could seal the gates.
      return { ...s, caves: 'off', players, domShare: STRONGHOLD_SHARE, stronghold: { player: holder, scale: 1 + STRONGHOLD_PER_SIDE * (attackers - 1) } };
    }
    case 'hold': {
      // The humans against the Bloom, together (#228): no bots, one team.
      const players = s.players.filter((p) => p.human).map((p) => ({ ...p, team: 0 }));
      // The waves come from the map's swarm spawns: events can't be off.
      return { ...s, players, caves: 'off', events: s.events === 'off' ? 'calm' : s.events, siege: skirmishSiege(o.waves ?? 1) };
    }
  }
}

/** Ready-made matches the menu suggests: the graduation 1v1 and what comes after. */
export function quickSetup(kind: 'normal1v1' | 'easy1v1' | 'ffa'): MatchSetup {
  const p = loadPrefs();
  const others = [0, 1, 2, 3, 4, 5].filter((c) => c !== p.color);
  const bots = kind === 'ffa' ? 3 : 1;
  const difficulty = kind === 'easy1v1' ? 0 : 1;
  return buildSetup(
    {
      ...p,
      size: kind === 'ffa' ? 'medium' : 'small',
      terrain: 'standard',
      caves: 'off',
      events: 'normal',
      teams: false,
      mode: 'conquest',
      bots: others.slice(0, bots).map((faction, i) => ({ faction, difficulty, personality: 'random', team: i + 1 })),
    },
    randomSeed(),
  );
}
