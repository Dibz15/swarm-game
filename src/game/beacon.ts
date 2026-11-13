/**
 * "You are here" (#235): for a few seconds at the start of a match, your home
 * nest pulses in your color and a YOU tag sits on it. The clock is wall time
 * (a resumed or rejoined match starts at a nonzero tick) and only starts once
 * the match is running, so a briefing that holds the start doesn't use it up.
 */
export const BEACON_SECS = 5;
/** the tag fades over the last part */
const FADE_SECS = 1;
/** a ring every this many seconds */
export const BEACON_PULSE = 0.8;

export class Beacon {
  private from = -1;
  private armed = false;
  private lastPulse = -Infinity;

  /** Show it once the match runs. */
  arm(): void {
    this.armed = true;
    this.from = -1;
    this.lastPulse = -Infinity;
  }

  /** Stop showing it now. */
  clear(): void {
    this.armed = false;
  }

  /** Each frame; `running` is false while the match is held or paused. */
  update(time: number, running: boolean): void {
    if (this.armed && this.from < 0 && running) this.from = time;
    if (this.armed && this.from >= 0 && time - this.from >= BEACON_SECS) this.armed = false;
  }

  /** 0..1 strength now (1 while on, fading out at the end), 0 when off or not started. */
  level(time: number): number {
    if (!this.armed || this.from < 0) return 0;
    const left = BEACON_SECS - (time - this.from);
    return Math.max(0, Math.min(1, left / FADE_SECS));
  }

  /** True once per pulse while on. */
  pulse(time: number): boolean {
    if (this.level(time) <= 0 || time - this.lastPulse < BEACON_PULSE) return false;
    this.lastPulse = time;
    return true;
  }
}
