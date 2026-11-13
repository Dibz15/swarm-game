/**
 * "You are here" (#235): for a few seconds at the start of a match, your home
 * nest pulses in your color and a YOU tag sits on it. The clock is wall time
 * (a resumed or rejoined match starts at a nonzero tick) and only runs while
 * the match does, so a briefing hold, a pause or a rejoin's catch-up doesn't
 * use it up.
 */
export const BEACON_SECS = 5;
/** the tag fades over the last part */
const FADE_SECS = 1;
/** a ring every this many seconds */
export const BEACON_PULSE = 0.8;

export class Beacon {
  private armed = false;
  /** running seconds shown so far */
  private shown = 0;
  /** wall time of the last update, while running */
  private last = -1;
  private running = false;
  private lastPulse = -Infinity;

  /** Show it once the match runs. */
  arm(): void {
    this.armed = true;
    this.shown = 0;
    this.last = -1;
    this.lastPulse = -Infinity;
  }

  /** Stop showing it now. */
  clear(): void {
    this.armed = false;
  }

  /** Each frame; `running` is false while the match is held, paused or catching up. */
  update(time: number, running: boolean): void {
    this.running = running;
    if (!this.armed) return;
    if (running && this.last >= 0) this.shown += time - this.last;
    this.last = running ? time : -1;
    if (this.shown >= BEACON_SECS) this.armed = false;
  }

  /** 0..1 strength now (1 while on, fading out at the end), 0 when off or not started. */
  level(): number {
    if (!this.armed || (this.shown === 0 && this.last < 0)) return 0;
    return Math.max(0, Math.min(1, (BEACON_SECS - this.shown) / FADE_SECS));
  }

  /** True once per pulse while on and running. */
  pulse(time: number): boolean {
    if (!this.running || this.level() <= 0 || time - this.lastPulse < BEACON_PULSE) return false;
    this.lastPulse = time;
    return true;
  }
}
