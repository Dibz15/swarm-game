/**
 * Keep a phone's screen on through a multiplayer match (#193): a screen that
 * locks on its own hides the page, and a hidden page's seat goes away (and,
 * when it runs the match, hands that on). The Screen Wake Lock only stops
 * the screen from dimming and locking by itself: the power button still
 * locks it, and the browser lets go of the lock whenever the page is
 * hidden, so it's asked for again when the page is shown.
 */

interface Sentinel {
  release(): Promise<void>;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<Sentinel>;
}

const browserApi = (): WakeLockApi | null => (typeof navigator !== 'undefined' && 'wakeLock' in navigator ? (navigator as unknown as { wakeLock: WakeLockApi }).wakeLock : null);

export class ScreenAwake {
  private want = false;
  private lock: Sentinel | null = null;
  private asking = false;
  private readonly api: WakeLockApi | null;

  constructor(api: WakeLockApi | null = browserApi()) {
    this.api = api;
  }

  /** whether we hold the lock now */
  get held(): boolean {
    return this.lock !== null;
  }

  /** Keep the screen on, or let it sleep again. */
  set(on: boolean): void {
    if (on === this.want) return;
    this.want = on;
    if (on) this.ask();
    else this.drop();
  }

  /** The page was shown again: the browser let go of the lock when it was hidden. */
  shown(): void {
    this.lock = null;
    if (this.want) this.ask();
  }

  private ask(): void {
    if (!this.api || this.lock || this.asking) return;
    this.asking = true;
    let req: Promise<Sentinel>;
    try {
      req = this.api.request('screen');
    } catch {
      this.asking = false;
      return;
    }
    req.then(
      (s) => {
        this.asking = false;
        // let go meanwhile: give it straight back
        if (!this.want) return void s.release().catch(() => undefined);
        this.lock = s;
      },
      // refused (hidden, low power, not allowed): the screen just sleeps as it would
      () => (this.asking = false),
    );
  }

  private drop(): void {
    const s = this.lock;
    this.lock = null;
    if (s) void s.release().catch(() => undefined);
  }
}
