import type { Command } from '../sim/commands';
import { worldHash } from '../sim/hash';
import { createWorld } from '../sim/setup';
import { step } from '../sim/step';
import type { World } from '../sim/world';
import type { Recording } from './recording';

export interface ReplayResult {
  world: World;
  hash: number;
  /** the final hash matches the one recorded */
  ok: boolean;
}

/**
 * Re-run a recording headlessly up to its last tick. `onTick` sees the world
 * after each step, for analysis that needs full sim state.
 */
export function replay(rec: Recording, onTick?: (w: World) => void): ReplayResult {
  const w = createWorld(rec.setup);
  const byTick = new Map<number, Command[]>();
  for (const { tick, cmd } of rec.log) {
    const list = byTick.get(tick);
    if (list) list.push(cmd);
    else byTick.set(tick, [cmd]);
  }
  while (w.tick < rec.end.tick && !w.over) {
    step(w, byTick.get(w.tick + 1) ?? []);
    w.fx = [];
    w.deaths = [];
    onTick?.(w);
  }
  const hash = worldHash(w);
  return { world: w, hash, ok: hash === rec.end.hash && w.tick === rec.end.tick };
}
