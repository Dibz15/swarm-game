// Shared probe options from the environment, e.g. TERRAIN=standard npx vite-node scripts/balance.ts
import type { TerrainLevel } from '../src/sim/mapgen';

export const TERRAIN = (process.env.TERRAIN ?? 'none') as TerrainLevel;
