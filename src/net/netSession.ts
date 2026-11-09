import { rejectedIn, type OrderFail, type Session, type TimedCommand } from '../game/session';
import type { Command } from '../sim/commands';
import { DT } from '../sim/constants';
import { normalizeCommand } from '../sim/sanitize';
import { applySeatCtrl, seatHasBot } from '../sim/seats';
import { createWorld, type MatchSetup } from '../sim/setup';
import { decodeSnap, hashBytes, restoreWorld, serializeWorld } from '../sim/snapshot';
import { step } from '../sim/step';
import type { World } from '../sim/world';
import { decodeMsg, encodeMsg } from './codec';
import { MAX_TURNS_PER_MSG, type Ctrl, type CtrlSeatState, type LatRow, type Msg, type Turn } from './protocol';
import { chunkSnap, packSnap, settle, SnapAssembler, unpackSnap, type SnapMeta } from './snapwire';
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

/** Drop a tick-ordered log's entries after `tick`, in place. */
function keepUntil(log: { tick: number }[], tick: number): void {
  let n = log.length;
  while (n > 0 && log[n - 1].tick > tick) n--;
  log.length = n;
}

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
  /** world snapshots kept, one per hash tick, to show the host after a desync (#165) */
  keepSnaps: number;
  /** gzip snapshots this client sends (off in the headless rig, which can't wait on streams) */
  gzipSnaps: boolean;
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
  keepSnaps: 6,
  gzipSnaps: true,
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
  /**
   * Rejoining a match already under way (#164): ask the host for a snapshot
   * and step nothing until it comes, then catch up from the turns after it.
   */
  resume?: boolean;
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
  private world_: World;
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
  /** a snapshot became this session's world (#164): the world at `tick`, with the turns after it to come */
  onAdopt: ((tick: number) => void) | null = null;
  /** the host's word on a desync (#165): the first field that differs, as far as it could tell */
  onDesyncNote: ((tick: number, text: string) => void) | null = null;
  /** halted after a desync at this tick (#165), until turns flow again; -1: not halted */
  halted = -1;
  /** the turn the halt came on */
  private haltTurn = -1;
  /** the last desync announced, so a resync's re-stepping doesn't announce it again */
  private lastDesync = -1;
  /** every hash this client reported lately, [tick, hash] (#165): for its report bundle */
  readonly hashLog: [number, number][] = [];
  /** the last few hash ticks' worlds, as bytes (#165): what the host asks for after a desync */
  private readonly kept = new Map<number, Uint8Array>();

  /** rejoining: no world to play yet, a snapshot is on its way (#164) */
  syncing = false;
  /** the page is hidden (#164): the seat is away; no pings, acks or resends until it's back */
  hidden = false;
  /** who drives our seat, from the control entries (#164) */
  private own: CtrlSeatState = 'human';
  private reclaimAt = -Infinity;
  private snapReqAt = -Infinity;
  /**
   * while resyncing after a fork (#166): the last tick the new host's turns
   * replace from. Our world is still the forked one, past it, but its turns
   * from here on are the ones to keep for when the snapshot comes.
   */
  private forkFloor = -1;
  private readonly snaps: SnapAssembler;
  /** closed turns stepped, from `historyFrom` on: the match's log as this client holds it (#164) */
  private history: Turn[] = [];
  private historyFrom = 1;

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
  /** the peer running the sequencer: changes when hosting passes to another player (#166) */
  private host: string;
  private readonly clock: () => number;
  private epoch = 0;
  /** our orders that ran lately, by seq: a fork past them (#166) sends them again */
  private landed = new Map<number, { cmd: Command; tick: number; at: number }>();
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
    this.world_ = createWorld(cfg.setup);
    this.syncing = !!cfg.resume;
    this.snaps = new SnapAssembler(cfg.clock);
    this.localSeat = cfg.seat;
    this.transport = cfg.transport;
    this.host = cfg.host;
    this.clock = cfg.clock;
    this.target = this.clampTarget(this.opts.minBuffer);
    this.held_ = this.world_.tick;
    this.bufferHist = new Array(this.opts.maxBuffer * 4 + 1).fill(0);
    if (this.opts.stepCostMs !== undefined) this.stepCost = this.opts.stepCostMs;
    this.transport.onMessage = (peer, bytes) => {
      if (peer !== this.host) return;
      const m = decodeMsg(bytes);
      if (m) this.receive(m);
      else this.badMessages++;
    };
  }

  get world(): World {
    return this.world_;
  }

  get paused(): boolean {
    return this.pausedBy >= 0 || this.halted >= 0;
  }

  /** This client's world at a recent hash tick, as bytes, if still kept (#165). */
  keptSnap(tick: number): Uint8Array | undefined {
    return this.kept.get(tick);
  }

  /** who has the match paused (-1: nobody) */
  get pausedSeat(): number {
    return this.pausedBy;
  }

  /** an Easy bot drives our seat for now: our orders would be refused until we take it back (#164) */
  get seatBot(): boolean {
    return this.own === 'bot';
  }

  /**
   * The page was hidden or shown again (#164). Hidden, the seat goes away at
   * once (an explicit `away`) and this client goes quiet; shown, an ack goes
   * out at once and the seat is ours again.
   */
  setHidden(on: boolean): void {
    if (on === this.hidden) return;
    this.hidden = on;
    if (on) this.send({ k: 'away' });
    else this.ackAt = -Infinity;
  }

  /**
   * Every closed turn this client holds, stepped or buffered, from
   * `historyFrom` (the first after the snapshot it started from, or 1).
   */
  closedTurns(): { first: number; turns: Turn[] } {
    const turns = this.history.slice();
    for (let t = this.world_.tick + 1; t <= this.held_; t++) turns.push(this.turns.get(t)!);
    return { first: this.historyFrom, turns };
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

  /** the highest tick held with no gap */
  get heldTick(): number {
    return this.held_;
  }

  /** the sequencer's epoch this client follows (#166) */
  get currentEpoch(): number {
    return this.epoch;
  }

  /** whose turns this client takes */
  get leader(): string {
    return this.host;
  }

  /**
   * Closed turns another player forwards while a new sequencer takes over
   * (#166): the old one closed them, whatever its epoch now.
   */
  absorb(first: number, list: Turn[]): void {
    const now = this.clock();
    for (let i = 0; i < list.length; i++) this.turnIn(first + i, list[i], now);
  }

  /**
   * Hosting passed to `leader` (#166): its turns, from `next` on, under
   * `epoch`. Turns we hold from `next` on came from the old sequencer and
   * were never confirmed: drop them. Our orders that hadn't landed before
   * `next` go to the new one at once. If our world already ran past `next`
   * (we stepped turns the new sequencer never had), resync from its world.
   */
  follow(leader: string, epoch: number, next: number): void {
    const now = this.clock();
    this.host = leader;
    this.epoch = epoch;
    for (const t of [...this.turns.keys()]) if (t >= next) this.turns.delete(t);
    for (const p of this.pending.values()) {
      if (p.tick >= next) p.tick = -1;
      if (p.tick < 0) {
        p.sentAt = -Infinity;
        p.resends = 0;
      }
    }
    this.offsets.length = 0;
    this.gapSince = -1;
    this.wantAt = -Infinity;
    this.turnAt = now;
    this.ackAt = -Infinity;
    if (this.world_.tick >= next) {
      // forked: the orders that ran in the lost stretch go again, with the agreed world
      for (const [s, l] of this.landed) {
        if (l.tick >= next && !this.pending.has(s)) this.pending.set(s, { cmd: l.cmd, issuedAt: l.at, sentAt: -Infinity, resends: 0, tick: -1 });
      }
      this.syncing = true;
      this.snapReqAt = -Infinity;
      this.forkFloor = next - 1;
      this.maxSeen = this.held_ = next - 1;
      return;
    }
    this.held_ = Math.min(this.held_, next - 1);
    while (this.turns.has(this.held_ + 1)) this.held_++;
    this.maxSeen = Math.min(this.maxSeen, next - 1);
  }

  /** turns held beyond the world's tick */
  get buffered(): number {
    return this.held_ - this.world_.tick;
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
      case 'snapreq': {
        // the host wants our world at a desync's tick (#165)
        const bytes = m.tick > 0 ? this.kept.get(m.tick) : undefined;
        if (!bytes) return;
        settle(
          packSnap({ tick: m.tick, pausedBy: this.pausedBy, seqBase: 0 }, bytes, this.opts.gzipSnaps),
          (packed) => {
            for (const c of chunkSnap(m.tick, packed)) this.send(c);
          },
          () => undefined,
        );
        return;
      }
      case 'desync':
        this.onDesyncNote?.(m.tick, m.text);
        return;
      case 'snap': {
        const packed = this.snaps.add(this.host, m);
        if (!packed) return;
        try {
          settle(unpackSnap(packed), (s) => this.fromSnap(s.meta, s.world), () => this.badMessages++);
        } catch {
          this.badMessages++;
        }
        return;
      }
      default:
        return;
    }
  }

  private fromSnap(meta: SnapMeta, bytes: Uint8Array): void {
    // a rejoin's snapshot only while waiting for one; a resync's any time (#165)
    if (!this.syncing && !meta.resync) return;
    let w: World;
    try {
      w = restoreWorld(this.setup, decodeSnap(bytes));
    } catch {
      this.badMessages++;
      return;
    }
    if (w.tick !== meta.tick) return void this.badMessages++;
    this.adopt(w, meta, { restep: !!meta.resync && !this.syncing });
  }

  /**
   * Take a snapshot's world as ours (#164): the turns after it, buffered while
   * it came, play on from here. Our next orders are numbered above any of
   * this seat's the sequencer has seen, so none is taken for a duplicate.
   */
  adopt(w: World, meta: SnapMeta, o: { restep?: boolean } = {}): void {
    const tick = w.tick;
    this.forkFloor = -1;
    if (o.restep) {
      // a resync (#165): the turns we stepped past `tick` run again on the agreed world
      const from = this.historyFrom;
      for (let t = tick + 1; t <= this.world_.tick; t++) {
        const turn = this.history[t - from];
        if (turn && !this.turns.has(t)) this.turns.set(t, turn);
      }
      this.history = this.history.slice(0, Math.max(0, tick + 1 - from));
      keepUntil(this.log, tick);
      keepUntil(this.ctrlLog, tick);
      for (const k of [...this.kept.keys()]) if (k > tick) this.kept.delete(k);
    }
    this.world_ = w;
    for (const t of [...this.turns.keys()]) if (t <= tick) this.turns.delete(t);
    this.held_ = tick;
    while (this.turns.has(this.held_ + 1)) this.held_++;
    this.maxSeen = Math.max(this.maxSeen, this.held_);
    this.pausedBy = meta.pausedBy;
    this.seq = Math.max(this.seq, meta.seqBase);
    this.own = this.localSeat >= 0 && seatHasBot(w, this.localSeat) ? 'bot' : 'human';
    if (!o.restep) {
      this.history = [];
      this.historyFrom = tick + 1;
    }
    this.syncing = false;
    this.started = false;
    this.acc = 0;
    this.gapSince = -1;
    this.wantAt = -Infinity;
    this.ackAt = -Infinity;
    // the turns that came while syncing came in a burst: their timing says nothing about the link
    this.offsets.length = 0;
    this.onAdopt?.(tick);
  }

  private turnIn(tick: number, turn: Turn, now: number): void {
    const floor = this.forkFloor >= 0 ? this.forkFloor : this.world_.tick;
    if (tick <= floor || this.turns.has(tick)) return;
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
    if (this.syncing) {
      // no world yet: ask for one (again, if the last ask got nowhere), and keep the line warm
      if (now - this.snapReqAt >= 3000) {
        this.snapReqAt = now;
        this.send({ k: 'snapreq', tick: 0 });
      }
      if (now - this.pingAt >= this.opts.pingMs) {
        this.pingAt = now;
        this.send({ k: 'ping', t: now });
      }
      this.alpha = 1;
      return 0;
    }
    this.timers(now);
    this.retarget(now);
    this.reclaimSeat(now);
    for (const [s, l] of this.landed) {
      if (now - l.at <= 30_000) break; // in the order they landed
      this.landed.delete(s);
    }
    if (this.world_.over) {
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
      while (steps < most && this.buffered > this.target && !this.world_.over) {
        this.stepOne();
        steps++;
      }
      this.caughtUp += steps;
      this.acc = 0;
    } else {
      const rate = Math.min(1.25, Math.max(0.9, 1 + 0.05 * (buffered - this.target)));
      this.acc += dt * rate;
      while (this.acc >= DT && steps < 6 && this.turns.has(this.world_.tick + 1) && !this.world_.over) {
        this.stepOne();
        this.acc -= DT;
        steps++;
      }
      if (this.acc >= DT && !this.turns.has(this.world_.tick + 1)) {
        // starved: wait for the turn, but don't bank time to burn through later (a pause isn't a stall)
        if (!this.paused) this.stallMs += (this.acc - DT) * 1000;
        this.acc = DT;
      }
    }
    this.alpha = Math.min(1, this.acc / DT);
    return steps;
  }

  /** Back and caught up while a bot plays for us: take the seat back (#164), at most every 2 s until it's ours. */
  private reclaimSeat(now: number): void {
    if (this.own !== 'bot' || this.hidden || now - this.reclaimAt < 2000) return;
    if (this.world_.factions[this.localSeat]?.eliminated || this.buffered > this.target + 2) return;
    this.reclaimAt = now;
    this.reclaim();
  }

  private stepOne(): void {
    const t = this.world_.tick + 1;
    const turn = this.turns.get(t)!;
    this.turns.delete(t);
    this.history.push(turn);
    // turns flow again after a halt: resumed, or resynced (#165)
    if (this.halted >= 0 && t > this.haltTurn) this.halted = -1;
    const w = this.world_;
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
      this.landed.set(e.seq, { cmd: p.cmd, tick: t, at: p.issuedAt });
      failed ??= rejectedIn(w, fx);
      const why = failed.get(i);
      if (why) this.onReject?.(e.seq, why);
      else this.onEffect?.(e.seq, now - p.issuedAt);
    });
    if (t % this.opts.hashTicks === 0) {
      // fullHash is the hash of these bytes: keep them, for a desync report (#165)
      const bytes = serializeWorld(w);
      const hash = hashBytes(bytes);
      this.kept.set(t, bytes);
      if (this.kept.size > this.opts.keepSnaps) this.kept.delete(this.kept.keys().next().value!);
      this.hashLog.push([t, hash]);
      if (this.hashLog.length > 600) this.hashLog.shift();
      this.onHash?.(t, hash);
      this.send({ k: 'hash', tick: t, hash });
    }
  }

  private applyCtrl(tick: number, c: Ctrl): void {
    this.ctrlLog.push({ tick, ctrl: c });
    if (c.k === 'pause') this.pausedBy = c.seat;
    else if (c.k === 'resume') this.pausedBy = -1;
    else if (c.k === 'desync') {
      this.halted = c.tick;
      this.haltTurn = tick;
      // stepped again after a resync: already announced
      if (c.tick === this.lastDesync) return;
      this.lastDesync = c.tick;
    } else {
      applySeatCtrl(this.world, c);
      if (c.seat === this.localSeat) this.own = c.state;
    }
    this.onCtrl?.(tick, c);
  }

  // ---- upkeep ----------------------------------------------------------------

  private timers(now: number): void {
    // hidden: quiet, so the seat stays away (any message would bring it back)
    if (this.hidden) return;
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
