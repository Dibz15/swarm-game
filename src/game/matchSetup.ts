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

export function buildSetup(p: SetupPrefs, seedText: string): MatchSetup {
  const seed = hashString(seedText.trim() || 'swarm');
  // Resolve "random" personalities deterministically from the seed.
  let s = seed;
  const nextPers = (): Personality => {
    s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x6b43a9b5) >>> 0;
    return PERSONALITIES[s % PERSONALITIES.length];
  };
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
        bot: { difficulty: b.difficulty, personality: b.personality === 'random' ? nextPers() : b.personality },
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
