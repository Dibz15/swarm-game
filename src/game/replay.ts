import type { Command } from '../sim/commands';
import { worldHash } from '../sim/hash';
import { applySeatCtrl } from '../sim/seats';
import { createWorld, type MatchSetup } from '../sim/setup';
import { step } from '../sim/step';
import type { World } from '../sim/world';
import type { Ctrl } from '../net/protocol';
import type { Recording } from './recording';
import type { TimedCommand } from './session';

/** A control entry as logged: only seat changes touch the sim (pauses are in the log for the record). */
type LoggedCtrl = { tick: number; ctrl: Ctrl };

/**
 * Re-run a match from its setup, command log and control entries up to
 * `until` (or its end): seat changes apply before their tick steps, exactly
 * as a networked session applies them (#164).
 */
export function replayLog(setup: MatchSetup, log: readonly TimedCommand[], ctrl: readonly LoggedCtrl[], until: number, onTick?: (w: World) => void): World {
  const w = createWorld(setup);
  const byTick = new Map<number, Command[]>();
  for (const { tick, cmd } of log) {
    const list = byTick.get(tick);
    if (list) list.push(cmd);
    else byTick.set(tick, [cmd]);
  }
  const ctrlAt = new Map<number, LoggedCtrl['ctrl'][]>();
  for (const { tick, ctrl: c } of ctrl) ctrlAt.set(tick, [...(ctrlAt.get(tick) ?? []), c]);
  while (w.tick < until && !w.over) {
    const t = w.tick + 1;
    for (const c of ctrlAt.get(t) ?? []) if (c.k === 'seat') applySeatCtrl(w, c);
    step(w, byTick.get(t) ?? []);
    w.fx = [];
    w.deaths = [];
    onTick?.(w);
  }
  return w;
}

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
  const w = replayLog(rec.setup, rec.log, rec.ctrl ?? [], rec.end.tick, onTick);
  const hash = worldHash(w);
  return { world: w, hash, ok: hash === rec.end.hash && w.tick === rec.end.tick };
}
