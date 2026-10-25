// Shared probe options from the environment, e.g. TERRAIN=standard CAVES=full EVENTS=normal npx vite-node scripts/balance.ts
import { SUPPLY } from '../src/sim/constants';
import type { CaveLevel, EventLevel, TerrainLevel } from '../src/sim/mapgen';

export const TERRAIN = (process.env.TERRAIN ?? 'none') as TerrainLevel;
export const EVENTS = (process.env.EVENTS ?? 'off') as EventLevel;
export const CAVES = (process.env.CAVES ?? 'off') as CaveLevel;

// Tuning overrides, e.g. SUPPLY='{"upkeep":0.4}' node probe.mjs
if (process.env.SUPPLY) Object.assign(SUPPLY, JSON.parse(process.env.SUPPLY));
