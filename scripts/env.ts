// Shared probe options from the environment, e.g. TERRAIN=standard CAVES=full EVENTS=normal npx vite-node scripts/balance.ts
import type { CaveLevel, EventLevel, TerrainLevel } from '../src/sim/mapgen';

export const TERRAIN = (process.env.TERRAIN ?? 'none') as TerrainLevel;
export const EVENTS = (process.env.EVENTS ?? 'off') as EventLevel;
export const CAVES = (process.env.CAVES ?? 'off') as CaveLevel;
