/**
 * Match setups from the player's saved preferences (#147: moved out of the UI so
 * the tutorial's real 1v1 can build its own): the skirmish screen's choices, a
 * random seed name, and the ready-made quick matches the menu suggests.
 */

import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import type { CaveLevel, EventLevel, MapLayout, MapSize, TerrainLevel } from '../sim/mapgen';
import { hashString } from '../sim/rng';
import type { MatchSetup } from '../sim/setup';

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
  return {
    seed,
    size: p.size,
    terrain: p.terrain,
    caves: p.caves,
    layout: p.layout,
    events: p.events,
    players: [
      { faction: p.color, team: 0, human: true },
      ...p.bots.map((b, i) => ({
        faction: b.faction,
        team: p.teams ? b.team : i + 1,
        human: false,
        bot: { difficulty: b.difficulty, personality: pick(b.personality) },
      })),
    ],
  };
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
      bots: others.slice(0, bots).map((faction, i) => ({ faction, difficulty, personality: 'random', team: i + 1 })),
    },
    randomSeed(),
  );
}
