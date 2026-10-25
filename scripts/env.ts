// Shared probe options from the environment, e.g. TERRAIN=standard CAVES=full EVENTS=normal npx vite-node scripts/balance.ts
import { SUPPLY } from '../src/sim/constants';
import { DIFFICULTY, PERSONALITY } from '../src/sim/ai/bot';
import type { CaveLevel, EventLevel, TerrainLevel } from '../src/sim/mapgen';

export const TERRAIN = (process.env.TERRAIN ?? 'none') as TerrainLevel;
export const EVENTS = (process.env.EVENTS ?? 'off') as EventLevel;
export const CAVES = (process.env.CAVES ?? 'off') as CaveLevel;

// Tuning overrides, e.g. SUPPLY='{"upkeep":0.4}' node probe.mjs
if (process.env.SUPPLY) Object.assign(SUPPLY, JSON.parse(process.env.SUPPLY));

// Bot difficulty overrides for one level, e.g. BOT='{"level":2,"openReserve":0}'
if (process.env.BOT) {
  const { level = 2, ...knobs } = JSON.parse(process.env.BOT);
  Object.assign(DIFFICULTY[level], knobs);
}
// Personality overrides, e.g. PERS='{"turtler":{"reserve":0.18}}'
if (process.env.PERS) {
  const all = JSON.parse(process.env.PERS) as Record<string, object>;
  for (const [p, knobs] of Object.entries(all)) Object.assign(PERSONALITY[p as keyof typeof PERSONALITY], knobs);
}
