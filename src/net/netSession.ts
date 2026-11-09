import { rejectedIn, type OrderFail, type Session, type TimedCommand } from '../game/session';
import type { Command } from '../sim/commands';
import { DT } from '../sim/constants';
import { normalizeCommand } from '../sim/sanitize';
import { seatHasBot, seatToBot, seatToHuman } from '../sim/seats';
import { createWorld, type MatchSetup } from '../sim/setup';
import { fullHash } from '../sim/snapshot';
import { step } from '../sim/step';
import type { World } from '../sim/world';
import { decodeMsg, encodeMsg } from './codec';
import { MAX_TURNS_PER_MSG, type Ctrl, type LatRow, type Msg, type Turn } from './protocol';
import type { Transport } from './transport';

/**
 * A networked match on one client (#159). It sends its orders to the
 * sequencer and steps tick T only once turn T has arrived, so every client
 * runs the same commands on the same ticks.
 *
 * - **Jitter buffer.** It runs a few turns behind the newest it holds:
 *   `target = clamp(ceil(p95 jitter / tick) + 1, minBuffer, maxBuffer)`.
 * - **Time dilation.** The sim runs at `1 + 0.05·(buffered − target)`
 *   (0.9–1.25×), so the buffer drifts back to its target without a jump.
 * - **Catch-up.** Far behind (after a freeze or a background tab), it steps
 *   back to back within a frame budget instead of dropping the backlog.
 * - Lost turns are asked for again (`ack.want`); orders that never show up
 *   in a turn are resent with the same seq (the sequencer drops dupes).
 * - It pings, acks, and reports `fullHash` every `hashTicks`.
 */

const DT_MS = DT * 1000;

export interface NetSessionOptions {
  minBuffer: number;
  maxBuffer: number;
  /** ms per frame for catching up */
  catchupMs: number;
  /** ticks past the target before catching up */
  catchupLag: number;
  /** a fixed step cost for the catch-up budget (a virtual clock); default: measured */
  stepCostMs?: number;
  pingMs: number;
  ackMs: number;
  hashTicks: number;
  /** jitter samples kept: ten seconds of turns */
  jitterWindow: number;
  /** ms between lowering the buffer target by one */
  lowerMs: number;
  /** an order unseen this long past 2·RTT is resent; after maxResends it's given up */
  resendMs: number;
  maxResends: number;
}

export const NET_SESSION_DEFAULTS: NetSessionOptions = {
  minBuffer: 2,
  maxBuffer: 8,
  catchupMs: 8,
  catchupLag: 15,
  pingMs: 1000,
  ackMs: 333,
  hashTicks: 30,
  jitterWindow: 300,
  lowerMs: 5000,
  resendMs: 750,
  maxResends: 8,
};

export interface NetSessionConfig {
  setup: MatchSetup;
  seat: number;
  transport: Transport;
  /** the sequencer's peer id */
  host: string;
  /** ms */
  clock: () => number;
  opts?: Partial<NetSessionOptions>;
}

interface Pending {
  cmd: Command;
  issuedAt: number;
  sentAt: number;
  resends: number;
  /** the tick a turn put it on, once seen */
  tick: number;
}

export class NetSession implements Session {
  readonly world: World;
  readonly setup: MatchSetup;
  readonly localSeat: number;
  readonly net = true;
  readonly log: TimedCommand[] = [];
  /** control entries, by the tick they applied before */
  readonly ctrlLog: { tick: number; ctrl: Ctrl }[] = [];
  readonly opts: NetSessionOptions;
  /** networked play runs at the sequencer's pace, and only it pauses */
  speed = 1;
  held = false;
  alpha = 0;
  lastStepMs = 0;
  issued = 0;
  onIssue: ((cmd: Command) => void) | null = null;
  /** one of our orders got its tick (as soon as its turn arrives, before it runs) */
  onLand: ((seq: number, tick: number) => void) | null = null;
  /** one of our orders ran: ms from issue to the step that ran it */
  onEffect: ((seq: number, ms: number) => void) | null = null;
  /** one of our orders did nothing: the sim refused it, or it never reached a turn */
  onReject: ((seq: number, why: OrderFail) => void) | null = null;
  /** each fullHash this client reports, as it reports it */
  onHash: ((tick: number, hash: number) => void) | null = null;
  /**
   * Called just before tick `tick` steps, after its control entries: tests
   * (and dev flags) change every peer's world the same way at the same tick,
   * or one peer's to force a desync.
   */
  beforeStep: ((tick: number, w: World) => void) | null = null;
  /** a control entry applied (a pause, a resume, a seat going away or to a bot), as the step before `tick` runs */
  onCtrl: ((tick: number, ctrl: Ctrl) => void) | null = null;

  /** paused by a control entry (someone pressed pause), and the sequencer's latest word on it */
  private pausedBy = -1;
  /** every human seat's latency, as the sequencer last reported it (#161) */
  lat: LatRow[] = [];
  /** the sequencer's last word while paused; `at` is when it came (this session's clock), to count down from */
  status: { paused: boolean; by: number; resumeIn: number; auto: number; at: number } | null = null;

  /** round-trip estimate to the sequencer, ms */
  rtt = 0;
  private rttSeen = false;
  /** the jitter buffer target in ticks */
  target: number;
  /** stats: ms spent wanting a turn that hadn't come; turns stepped by catch-up; bad messages */
  stallMs = 0;
  caughtUp = 0;
  badMessages = 0;
  /** buffered-turn counts seen at each update, 0..maxBuffer*4 (the last bucket is "more") */
  readonly bufferHist: number[];

  private readonly transport: Transport;
  private readonly host: string;
  private readonly clock: () => number;
  private epoch = 0;
  private turns = new Map<number, Turn>();
  /** highest tick held with no gap from the world's tick */
  private held_ = 0;
  private maxSeen = 0;
  private gapSince = -1;
  private wantAt = -Infinity;
  /** when the last new turn came in */
  private turnAt = -1;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private lastLanded = 0;
  private acc = 0;
  private started = false;
  private pingAt = -Infinity;
  private ackAt = -Infinity;
  private offsets: number[] = [];
  private lowerAt = 0;
  private retargetAt = -Infinity;
  private stepCost = 1;
  private landMs = 0;

  constructor(cfg: NetSessionConfig) {
    this.opts = { ...NET_SESSION_DEFAULTS, ...cfg.opts };
    this.setup = cfg.setup;
    this.world = createWorld(cfg.setup);
    this.localSeat = cfg.seat;
    this.transport = cfg.transport;
    this.host = cfg.host;
    this.clock = cfg.clock;
    this.target = this.clampTarget(this.opts.minBuffer);
    this.held_ = this.world.tick;
    this.bufferHist = new Array(this.opts.maxBuffer * 4 + 1).fill(0);
    if (this.opts.stepCostMs !== undefined) this.stepCost = this.opts.stepCostMs;
    this.transport.onMessage = (peer, bytes) => {
      if (peer !== this.host) return;
      const m = decodeMsg(bytes);
      if (m) this.receive(m);
      else this.badMessages++;
    };
  }

  get paused(): boolean {
    return this.pausedBy >= 0;
  }

  setPaused(on: boolean): void {
    this.send({ k: 'pause', on });
  }

  /** take our seat back from the bot that took it while we were gone */
  reclaim(): void {
    this.send({ k: 'reclaim' });
  }

  /** orders sent that haven't run yet */
  get queued(): number {
    return this.pending.size;
  }

  /** turns held beyond the world's tick */
  get buffered(): number {
    return this.held_ - this.world.tick;
  }

  /**
   * What an order issued now should take to run, ms: the recent issue-to-turn
   * time plus the buffer. Before any order has landed: a round trip plus the
   * minimum hold.
   */
  expectedDelayMs(): number {
    return (this.landMs || this.rtt + 2 * DT_MS) + this.target * DT_MS;
  }

  issue(order: Command): number {
    const cmd = normalizeCommand(order);
    const s = ++this.seq;
    const now = this.clock();
    this.pending.set(s, { cmd, issuedAt: now, sentAt: now, resends: 0, tick: -1 });
    this.issued++;
    this.onIssue?.(cmd);
    this.send({ k: 'cmd', seq: s, cmd });
    return s;
  }

  private send(m: Msg): void {
    this.transport.send(this.host, encodeMsg(m));
  }

  // ---- receiving -------------------------------------------------------------

  private receive(m: Msg): void {
    const now = this.clock();
    switch (m.k) {
      case 'turns':
        if (m.epoch < this.epoch) return; // a deposed host (#166)
        this.epoch = m.epoch;
        for (let i = 0; i < m.list.length; i++) this.turnIn(m.first + i, m.list[i], now);
        return;
      case 'pong': {
        const sample = Math.max(0, now - m.t);
        this.rtt = this.rttSeen ? this.rtt * 0.8 + sample * 0.2 : sample;
        this.rttSeen = true;
        return;
      }
      case 'lat':
        this.lat = m.rows;
        return;
      case 'status':
        this.status = { paused: m.paused, by: m.by, resumeIn: m.resumeIn, auto: m.auto, at: now };
        return;
      default:
        return;
    }
  }

  private turnIn(tick: number, turn: Turn, now: number): void {
    if (tick <= this.world.tick || this.turns.has(tick)) return;
    this.turns.set(tick, turn);
    this.turnAt = now;
    if (turn.ctrl?.some((c) => c.k === 'resume')) this.offsets.length = 0; // the clock restarted: old timing says nothing
    this.offsets.push(now - tick * DT_MS);
    if (this.offsets.length > this.opts.jitterWindow) this.offsets.shift();
    if (tick > this.maxSeen) this.maxSeen = tick;
    while (this.turns.has(this.held_ + 1)) this.held_++;
    for (const e of turn.entries) {
      if (e.seat !== this.localSeat) continue;
      const p = this.pending.get(e.seq);
      if (!p || p.tick >= 0) continue;
      p.tick = tick;
      this.landMs = this.landMs ? this.landMs * 0.8 + (now - p.issuedAt) * 0.2 : now - p.issuedAt;
      if (e.seq > this.lastLanded) this.lastLanded = e.seq;
      this.onLand?.(e.seq, tick);
    }
  }

  // ---- stepping --------------------------------------------------------------

  update(dt: number): number {
    const now = this.clock();
    this.timers(now);
    this.retarget(now);
    if (this.world.over) {
      // the match is decided: step() no longer advances, so neither do we
      this.alpha = 1;
      return 0;
    }
    const buffered = this.buffered;
    this.bufferHist[Math.min(buffered, this.bufferHist.length - 1)]++;
    if (!this.started) {
      if (buffered < this.target) {
        this.alpha = 1;
        return 0;
      }
      this.started = true;
    }
    let steps = 0;
    if (buffered > this.target + this.opts.catchupLag) {
      // far behind: as many steps as the budget allows, down to the target
      const most = Math.max(1, Math.floor(this.opts.catchupMs / Math.max(0.05, this.stepCost)));
      while (steps < most && this.buffered > this.target && !this.world.over) {
        this.stepOne();
        steps++;
      }
      this.caughtUp += steps;
      this.acc = 0;
    } else {
      const rate = Math.min(1.25, Math.max(0.9, 1 + 0.05 * (buffered - this.target)));
      this.acc += dt * rate;
      while (this.acc >= DT && steps < 6 && this.turns.has(this.world.tick + 1) && !this.world.over) {
        this.stepOne();
        this.acc -= DT;
        steps++;
      }
      if (this.acc >= DT && !this.turns.has(this.world.tick + 1)) {
        // starved: wait for the turn, but don't bank time to burn through later (a pause isn't a stall)
        if (!this.paused) this.stallMs += (this.acc - DT) * 1000;
        this.acc = DT;
      }
    }
    this.alpha = Math.min(1, this.acc / DT);
    return steps;
  }

  private stepOne(): void {
    const t = this.world.tick + 1;
    const turn = this.turns.get(t)!;
    this.turns.delete(t);
    const w = this.world;
    for (const c of turn.ctrl ?? []) this.applyCtrl(t, c);
    const cmds: Command[] = [];
    for (const e of turn.entries) {
      cmds.push(e.cmd);
      this.log.push({ tick: t, cmd: e.cmd });
    }
    this.beforeStep?.(t, w);
    const fx = w.fx.length;
    const t0 = performance.now();
    step(w, cmds);
    this.lastStepMs = performance.now() - t0;
    if (this.opts.stepCostMs === undefined) this.stepCost = this.stepCost * 0.9 + this.lastStepMs * 0.1;
    const now = this.clock();
    let failed: Map<number, OrderFail> | null = null;
    turn.entries.forEach((e, i) => {
      if (e.seat !== this.localSeat) return;
      const p = this.pending.get(e.seq);
      if (!p) return;
      this.pending.delete(e.seq);
      failed ??= rejectedIn(w, fx);
      const why = failed.get(i);
      if (why) this.onReject?.(e.seq, why);
      else this.onEffect?.(e.seq, now - p.issuedAt);
    });
    if (t % this.opts.hashTicks === 0) {
      const hash = fullHash(w);
      this.onHash?.(t, hash);
      this.send({ k: 'hash', tick: t, hash });
    }
  }

  private applyCtrl(tick: number, c: Ctrl): void {
    this.ctrlLog.push({ tick, ctrl: c });
    const w = this.world;
    if (c.k === 'pause') this.pausedBy = c.seat;
    else if (c.k === 'resume') this.pausedBy = -1;
    else if (c.state === 'bot') seatToBot(w, c.seat, { difficulty: c.bot?.difficulty ?? 0, personality: c.bot?.personality ?? 'expander' });
    else if (seatHasBot(w, c.seat)) seatToHuman(w, c.seat);
    this.onCtrl?.(tick, c);
  }

  // ---- upkeep ----------------------------------------------------------------

  private timers(now: number): void {
    if (now - this.pingAt >= this.opts.pingMs) {
      this.pingAt = now;
      this.send({ k: 'ping', t: now });
    }
    // a gap: turns past it have come, the missing ones haven't
    let want: [number, number] | undefined;
    if (this.maxSeen > this.held_) {
      if (this.gapSince < 0) this.gapSince = now;
      const wait = Math.max(200, 2 * this.rtt);
      if (now - this.gapSince >= wait && now - this.wantAt >= wait) {
        let to = this.held_ + 1;
        while (to + 1 <= this.maxSeen && !this.turns.has(to + 1)) to++;
        want = [this.held_ + 1, to];
        this.wantAt = now;
      }
    } else {
      this.gapSince = -1;
      // No gap, but nothing new for a while either, and not paused: the last
      // turns may be lost with nothing behind them to show it. Ask for
      // whatever comes next; if nothing has closed, the sequencer sends nothing.
      const quiet = Math.max(200, 2 * this.rtt) + this.opts.resendMs;
      if (this.started && !this.paused && this.turnAt >= 0 && now - this.turnAt >= quiet && now - this.wantAt >= quiet) {
        want = [this.held_ + 1, this.held_ + MAX_TURNS_PER_MSG];
        this.wantAt = now;
      }
    }
    if (want || now - this.ackAt >= this.opts.ackMs) {
      this.ackAt = now;
      this.send({ k: 'ack', tick: this.held_, seq: this.lastLanded, rtt: Math.round(this.rtt), buffer: this.target, ...(want ? { want } : {}) });
    }
    // orders that never showed up in a turn
    const late = 2 * this.rtt + this.opts.resendMs;
    for (const [s, p] of this.pending) {
      if (p.tick >= 0 || now - p.sentAt < late) continue;
      if (p.resends >= this.opts.maxResends) {
        this.pending.delete(s); // the sequencer refused it (throttled, or our seat isn't ours right now)
        this.onReject?.(s, 'lost');
        continue;
      }
      p.resends++;
      p.sentAt = now;
      this.send({ k: 'cmd', seq: s, cmd: p.cmd });
    }
  }

  private clampTarget(v: number): number {
    return Math.min(this.opts.maxBuffer, Math.max(this.opts.minBuffer, v));
  }

  /** The buffer target from the p95 of recent arrival jitter: up at once, down a tick per lowerMs. */
  private retarget(now: number): void {
    const o = this.offsets;
    if (o.length < 10 || now - this.retargetAt < 250) return;
    this.retargetAt = now;
    let min = Infinity;
    for (const v of o) if (v < min) min = v;
    const j = o.map((v) => v - min).sort((a, b) => a - b);
    const p95 = j[Math.min(j.length - 1, Math.floor(j.length * 0.95))];
    const want = this.clampTarget(Math.ceil(p95 / DT_MS - 1e-9) + 1);
    if (want > this.target) {
      this.target = want;
      this.lowerAt = now;
    } else if (want < this.target && now - this.lowerAt >= this.opts.lowerMs) {
      this.target--;
      this.lowerAt = now;
    }
  }
}
