import { DT } from '../sim/constants';
import type { Command } from '../sim/commands';
import { normalizeCommand } from '../sim/sanitize';
import { createWorld, type MatchSetup } from '../sim/setup';
import { step } from '../sim/step';
import type { World } from '../sim/world';

export interface TimedCommand {
  tick: number;
  cmd: Command;
}

/**
 * What GameView drives a match through (#159): the local LocalSession, or a
 * NetSession that steps the turns a sequencer closes (src/net/netSession.ts).
 */
export interface Session {
  readonly world: World;
  readonly setup: MatchSetup;
  /** seed + this log fully reproduce the match (with a NetSession's ctrlLog) */
  readonly log: TimedCommand[];
  /** the faction this client plays (-1: none) */
  readonly localSeat: number;
  /** networked: speed and held do nothing, pause goes through the sequencer */
  readonly net: boolean;
  readonly paused: boolean;
  /** ask to pause or resume; a NetSession's pause only shows once the sequencer agrees */
  setPaused(on: boolean): void;
  /** every command issued so far, stepped or not */
  readonly issued: number;
  /** orders issued but not yet stepped */
  readonly queued: number;
  speed: number;
  held: boolean;
  /** interpolation factor between the previous and current tick */
  readonly alpha: number;
  readonly lastStepMs: number;
  /** sees every command as it is issued (the match recorder) */
  onIssue: ((cmd: Command) => void) | null;
  issue(order: Command): void;
  /** advance by dt seconds of real time; returns the ticks stepped */
  update(dt: number): number;
}

/** Drives the sim at a fixed tick rate from a variable frame clock. Single player, the tutorial, the demo. */
export class LocalSession implements Session {
  readonly world: World;
  readonly net = false;
  readonly localSeat: number;
  readonly setup: MatchSetup;
  /** seed + this log fully reproduce the match */
  readonly log: TimedCommand[] = [];
  private queue: Command[] = [];
  private acc = 0;
  speed = 1;
  paused = false;
  /** every command issued so far, stepped or not */
  issued = 0;
  /** held without the pause menu (the tutorial's reading pause) */
  held = false;
  /** interpolation factor between the previous and current tick */
  alpha = 0;
  lastStepMs = 0;
  /** sees every command as it is issued (the match recorder) */
  onIssue: ((cmd: Command) => void) | null = null;

  /** `seat`: the local faction (default: the setup's first human, or -1) */
  constructor(setup: MatchSetup, seat?: number) {
    this.setup = setup;
    this.world = createWorld(setup);
    this.localSeat = seat ?? setup.players.find((p) => p.human)?.faction ?? -1;
  }

  setPaused(on: boolean): void {
    this.paused = on;
  }

  issue(order: Command): void {
    // Canonical form here (#154, #157): x/y on a 1/16 px grid, sorted unit lists. The log, the recorder and the wire then agree.
    const cmd = normalizeCommand(order);
    this.queue.push(cmd);
    this.issued++;
    this.onIssue?.(cmd);
  }

  /** Orders issued but not yet stepped (held or paused). */
  get queued(): number {
    return this.queue.length;
  }

  update(dt: number): number {
    if (this.paused || this.held || this.world.over) {
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
