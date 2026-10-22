// Shared probe options from the environment, e.g. TERRAIN=standard EVENTS=normal npx vite-node scripts/balance.ts
import type { EventLevel, TerrainLevel } from '../src/sim/mapgen';

export const TERRAIN = (process.env.TERRAIN ?? 'none') as TerrainLevel;
export const EVENTS = (process.env.EVENTS ?? 'off') as EventLevel;
