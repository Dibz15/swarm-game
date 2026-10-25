import { DT } from '../sim/constants';
import type { Command } from '../sim/commands';
import { createWorld, type MatchSetup } from '../sim/setup';
import { step } from '../sim/step';
import type { World } from '../sim/world';

export interface TimedCommand {
  tick: number;
  cmd: Command;
}

/**
 * Drives the sim at a fixed tick rate from a variable frame clock.
 * A future LockstepSession would expose the same surface but only advance
 * once every peer's commands for a tick have arrived.
 */
export class LocalSession {
  readonly world: World;
  readonly setup: MatchSetup;
  /** seed + this log fully reproduce the match */
  readonly log: TimedCommand[] = [];
  private queue: Command[] = [];
  private acc = 0;
  speed = 1;
  paused = false;
  /** interpolation factor between the previous and current tick */
  alpha = 0;
  lastStepMs = 0;
  /** sees every command as it is issued (the match recorder) */
  onIssue: ((cmd: Command) => void) | null = null;

  constructor(setup: MatchSetup) {
    this.setup = setup;
    this.world = createWorld(setup);
  }

  issue(cmd: Command): void {
    this.queue.push(cmd);
    this.onIssue?.(cmd);
  }

  update(dt: number): number {
    if (this.paused || this.world.over) {
      this.alpha = 1;
      return 0;
    }
    this.acc += dt * this.speed;
    let steps = 0;
    while (this.acc >= DT && steps < 6) {
      const cmds = this.queue;
      this.queue = [];
      for (const c of cmds) this.log.push({ tick: this.world.tick + 1, cmd: c });
      const t0 = performance.now();
      step(this.world, cmds);
      this.lastStepMs = performance.now() - t0;
      this.acc -= DT;
      steps++;
    }
    if (steps === 6) this.acc = 0; // don't spiral after a stall
    this.alpha = Math.min(1, this.acc / DT);
    return steps;
  }
}
