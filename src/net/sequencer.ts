import type { Command } from '../sim/commands';
import { DT } from '../sim/constants';
import { normalizeCommand, sanitizeCommand, type CommandLimits } from '../sim/sanitize';
import { MAX_ENTRIES_PER_TURN, MAX_TURNS_PER_MSG, type Ctrl, type CtrlSeatState, type Entry, type LatRow, type Msg, type SeatBot, type SeatState, type Turn } from './protocol';

/**
 * The Sequencer (#158): the one place that decides which tick each command
 * runs on. It never waits for anyone.
 *
 * - A turn clock closes turn T at `t0 + T·DT` and broadcasts it, empty or not.
 * - A command gets its sender's seat as `p` (whatever it said), is deduped,
 *   rate-limited and sanitized, then scheduled for tick `S + D(seat)`, S
 *   being the turn now open. A seat's commands never overtake each other.
 * - D is `dMin` plus, when humans face each other, a hold that evens out
 *   everyone's order-to-effect delay (fair in PvP, fast in co-op).
 * - Pause, resume and seat changes (human → away → Easy bot → reclaimed)
 *   go out as control entries in closed turns, so every client applies them
 *   at the same tick.
 * - Clients report `fullHash`es; a mismatch fires `onDesync`.
 *
 * DOM-free with an injected clock: it runs in a browser host, in Node tests,
 * or later in a relay (#167). Its soft state exports as plain JSON so a
 * successor can take over (#166).
 */

const DT_MS = DT * 1000;

export interface SequencerOptions {
  /** minimum delay in ticks, for every seat including the host's */
  dMin: number;
  /**
   * most delay in ticks a seat is ever given: 1 s, enough to even out a
   * 300 ms friend on a lossy link (whose jitter buffer runs ~8 ticks)
   */
  dMax: number;
  /** D moves one tick at most this often */
  dStepMs: number;
  /** commands per seat: bucket size and refill per second */
  burst: number;
  refill: number;
  /** silence before a seat is away, and away time before its bot takes over */
  awayMs: number;
  botMs: number;
  /** the bot a dropped seat gets */
  seatBot: SeatBot;
  /** pauses each seat may call, and their total length */
  pauses: number;
  pauseMs: number;
  /** the seats that may pause and resume the match (null: every human seat); a networked match passes only the host's (#162) */
  pausers: number[] | null;
  /** countdown between a resume and the next turn */
  resumeMs: number;
  /** how often clients hear `status` while paused */
  statusMs: number;
  /** hash reports for a tick are compared at the latest this many ticks later */
  hashTicks: number;
  /** how often everyone hears the latency table (`lat`, #161) */
  latMs: number;
  /** stop the match at the first hash mismatch, until resumed or resynced (#165) */
  haltOnDesync: boolean;
}

export const SEQUENCER_DEFAULTS: SequencerOptions = {
  dMin: 2,
  dMax: 30,
  dStepMs: 500,
  burst: 60,
  refill: 30,
  awayMs: 5000,
  botMs: 60000,
  seatBot: { difficulty: 0, personality: 'expander' },
  pauses: 3,
  pauseMs: 120000,
  pausers: null,
  resumeMs: 3000,
  statusMs: 1000,
  hashTicks: 300,
  latMs: 2000,
  haltOnDesync: true,
};

/** A human seat in the match, and the peer that plays it (null: nobody yet). */
export interface SeatConfig {
  seat: number;
  team: number;
  peer: string | null;
}

/** How far back `seen` remembers a seat's seqs. */
const SEQ_WINDOW = 512;
/** Most turns one `want` gets resent. */
const MAX_RESEND = MAX_TURNS_PER_MSG * 4;

interface SeatRec {
  seat: number;
  team: number;
  peer: string | null;
  state: SeatState;
  /** ms since the peer was last heard / since the seat went away (aged on export) */
  heardAt: number;
  awayAt: number;
  highSeq: number;
  seen: number[];
  tokens: number;
  tokensAt: number;
  /** current delay, and when it last moved */
  d: number;
  dAt: number;
  lastExec: number;
  /** what the client last reported */
  rtt: number;
  buffer: number;
  ackTick: number;
  pausesLeft: number;
  pauseMsLeft: number;
}

/** Everything a successor needs to carry on (#166). Times are ages in ms, not clock readings. */
export interface SequencerState {
  epoch: number;
  /** the next turn to close */
  next: number;
  pending: [number, Entry[]][];
  ctrlNext: Ctrl[];
  seats: SeatRec[];
  /** resumeIn -1: not resuming yet; after ≥ 0: the turn carrying the pause hasn't closed yet */
  pause: { by: number; since: number; resumeIn: number; after: number } | null;
}

export interface SequencerConfig {
  limits: CommandLimits;
  seats: SeatConfig[];
  clock: () => number;
  send: (peer: string, msg: Msg) => void;
  opts?: Partial<SequencerOptions>;
  /** the first turn to close (default 1: the step that makes tick 1) */
  first?: number;
  epoch?: number;
  /** take over from another sequencer: its exported state, and the turns it closed */
  resume?: { state: SequencerState; history?: { first: number; turns: Turn[] } };
}

export class Sequencer {
  readonly opts: SequencerOptions;
  epoch: number;
  /** the turn now open: the next to close */
  next: number;
  /** closed turns: history[i] is turn base + i */
  private history: Turn[] = [];
  private base: number;
  private t0: number;
  private pending = new Map<number, Entry[]>();
  private ctrlNext: Ctrl[] = [];
  private seats = new Map<number, SeatRec>();
  private byPeer = new Map<string, SeatRec>();
  private pause: { by: number; at: number; resumeAt: number } | null = null;
  /** the turn after which the clock stops (the one carrying the pause entry); -1 once stopped */
  private pauseAfter = -1;
  private statusAt = -Infinity;
  private latAt = -Infinity;
  private hashes = new Map<number, Map<number, number>>();
  private readonly clock: () => number;
  private readonly send: (peer: string, msg: Msg) => void;
  private readonly limits: CommandLimits;

  /** every closed turn, as it closes */
  onTurn: ((tick: number, turn: Turn) => void) | null = null;
  /** clients disagree about the world after `tick` */
  /**
   * The first time clients disagree (#165): the tick, every seat's hash, and
   * the seats outside the majority (all of them when there's no majority).
   * Once only, until `clearDesync`: a world that diverged stays diverged.
   */
  onDesync: ((tick: number, hashes: Map<number, number>, odd: number[]) => void) | null = null;
  /** every mismatch reported, for the report bundle */
  readonly desyncs: { tick: number; hashes: Record<number, number> }[] = [];
  private desyncAt = -1;
  /** every tick whose hash reports were compared, agreeing or not (for the net-sim) */
  onHashes: ((tick: number, hashes: Map<number, number>) => void) | null = null;
  /** commands dropped, by reason (for tests and the debug overlay) */
  readonly dropped = { seat: 0, dup: 0, rate: 0, invalid: 0 };

  constructor(cfg: SequencerConfig) {
    this.opts = { ...SEQUENCER_DEFAULTS, ...cfg.opts };
    this.clock = cfg.clock;
    this.send = cfg.send;
    this.limits = cfg.limits;
    const now = this.clock();
    const r = cfg.resume;
    this.epoch = cfg.epoch ?? (r ? r.state.epoch + 1 : 0);
    if (r) {
      const s = r.state;
      this.next = s.next;
      for (const [t, e] of s.pending) this.pending.set(t, e.map((x) => ({ ...x })));
      this.ctrlNext = s.ctrlNext.map((c) => ({ ...c }));
      for (const rec of s.seats) {
        const copy: SeatRec = { ...rec, seen: [...rec.seen], heardAt: now - rec.heardAt, awayAt: now - rec.awayAt, tokensAt: now - rec.tokensAt, dAt: now - rec.dAt };
        this.addSeat(copy);
      }
      if (s.pause) {
        this.pause = { by: s.pause.by, at: now - s.pause.since, resumeAt: s.pause.resumeIn < 0 ? Infinity : now + s.pause.resumeIn };
        this.pauseAfter = s.pause.after;
      }
      if (r.history) {
        if (r.history.first + r.history.turns.length !== this.next) throw new Error('sequencer: history does not end at the last closed turn');
        this.history = r.history.turns.slice();
      }
    } else {
      this.next = cfg.first ?? 1;
      for (const c of cfg.seats) {
        this.addSeat({
          seat: c.seat, team: c.team, peer: c.peer, state: c.peer === null ? 'away' : 'human',
          heardAt: now, awayAt: now, highSeq: 0, seen: [], tokens: this.opts.burst, tokensAt: now,
          d: this.opts.dMin, dAt: now, lastExec: 0, rtt: 0, buffer: 0, ackTick: this.next - 1,
          pausesLeft: this.opts.pauses, pauseMsLeft: this.opts.pauseMs,
        });
      }
    }
    this.base = this.next - this.history.length;
    // the open turn closes one tick from now
    this.t0 = now - (this.next - 1) * DT_MS;
  }

  private addSeat(rec: SeatRec): void {
    this.seats.set(rec.seat, rec);
    if (rec.peer !== null) this.byPeer.set(rec.peer, rec);
  }

  get paused(): boolean {
    return this.pause !== null;
  }

  /** The seat a peer is bound to, or -1. */
  seatOfPeer(peer: string): number {
    return this.byPeer.get(peer)?.seat ?? -1;
  }

  /** The highest order seq seen from this seat: a rejoining client numbers its orders above it (#164). */
  seatSeq(seat: number): number {
    return this.seats.get(seat)?.highSeq ?? 0;
  }

  seatState(seat: number): SeatState | undefined {
    return this.seats.get(seat)?.state;
  }

  /** Ticks of delay a seat's next command gets. */
  delayOf(seat: number): number {
    return this.seats.get(seat)?.d ?? this.opts.dMin;
  }

  /** A closed turn, if still held. */
  turn(tick: number): Turn | undefined {
    return this.history[tick - this.base];
  }

  /** The last closed tick. */
  get closed(): number {
    return this.next - 1;
  }

  /** A peer (re)joins a seat. Nothing changes in the match until it sends something. */
  bindPeer(seat: number, peer: string): void {
    const rec = this.seats.get(seat);
    if (!rec) throw new Error(`sequencer: no seat ${seat}`);
    if (rec.peer !== null) this.byPeer.delete(rec.peer);
    rec.peer = peer;
    this.byPeer.set(peer, rec);
  }

  /** The transport lost this peer: its seat goes away now rather than after the silence timeout. */
  peerLost(peer: string): void {
    const rec = this.byPeer.get(peer);
    if (rec && rec.state === 'human') this.setState(rec, 'away', this.clock());
  }

  // ---- incoming --------------------------------------------------------------

  onMessage(peer: string, msg: Msg): void {
    const rec = this.byPeer.get(peer);
    if (!rec) return;
    const now = this.clock();
    rec.heardAt = now;
    // the page went hidden (#164): away now, not after a silence; anything else it sends brings it back
    if (msg.k === 'away') {
      if (rec.state === 'human') this.setState(rec, 'away', now);
      return;
    }
    if (rec.state === 'away') this.setState(rec, 'human', now);
    switch (msg.k) {
      case 'cmd':
        this.command(rec, msg.seq, msg.cmd, now);
        return;
      case 'ack':
        rec.rtt = msg.rtt;
        rec.buffer = msg.buffer;
        rec.ackTick = Math.max(rec.ackTick, msg.tick);
        if (msg.want) this.sendRange(peer, msg.want[0], Math.min(msg.want[1], msg.want[0] + MAX_RESEND - 1));
        return;
      case 'ping':
        this.send(peer, { k: 'pong', t: msg.t });
        return;
      case 'hash':
        this.hash(rec.seat, msg.tick, msg.hash);
        return;
      case 'pause':
        if (this.opts.pausers && !this.opts.pausers.includes(rec.seat)) return;
        if (msg.on) this.requestPause(rec, now);
        else this.requestResume(now);
        return;
      case 'reclaim':
        if (rec.state === 'bot') this.setState(rec, 'human', now);
        return;
      default:
        // lobby messages (hello, seats, start) belong to the host around this class
        return;
    }
  }

  private command(rec: SeatRec, seq: number, raw: Command, now: number): void {
    if (rec.state !== 'human') return void this.dropped.seat++;
    if (!Number.isSafeInteger(seq) || seq <= rec.highSeq - SEQ_WINDOW || rec.seen.includes(seq)) return void this.dropped.dup++;
    // rate limit before marking it seen: a resend of a throttled command may still get in
    rec.tokens = Math.min(this.opts.burst, rec.tokens + ((now - rec.tokensAt) / 1000) * this.opts.refill);
    rec.tokensAt = now;
    if (rec.tokens < 1) return void this.dropped.rate++;
    rec.tokens--;
    rec.seen.push(seq);
    if (seq > rec.highSeq) {
      rec.highSeq = seq;
      const low = seq - SEQ_WINDOW;
      if (rec.seen.length > 64 && rec.seen[0] <= low) rec.seen = rec.seen.filter((s) => s > low);
    }
    // the seat comes from the connection, never from the command
    const clean = sanitizeCommand(this.limits, { ...raw, p: rec.seat });
    if (!clean) return void this.dropped.invalid++;
    const cmd = normalizeCommand(clean);
    let at = Math.max(this.next + rec.d, rec.lastExec);
    let list = this.pending.get(at);
    while (list && list.length >= MAX_ENTRIES_PER_TURN) list = this.pending.get(++at);
    if (!list) this.pending.set(at, (list = []));
    list.push({ seat: rec.seat, seq, cmd });
    rec.lastExec = at;
  }

  private requestPause(rec: SeatRec, now: number): void {
    if (rec.state !== 'human' || rec.pausesLeft <= 0 || rec.pauseMsLeft <= 0) return;
    if (this.pause) {
      // pausing again during the countdown cancels it, on the first pauser's allowance
      if (this.pause.resumeAt !== Infinity) this.pause.resumeAt = Infinity;
      this.broadcastStatus(now);
      return;
    }
    rec.pausesLeft--;
    this.pause = { by: rec.seat, at: now, resumeAt: Infinity };
    this.ctrlNext.push({ k: 'pause', seat: rec.seat });
    // the pause rides on the turn now open, which closes on time; the clock stops after it
    this.pauseAfter = this.next;
  }

  private requestResume(now: number): void {
    if (!this.pause || this.pause.resumeAt !== Infinity) return;
    this.pause.resumeAt = now + this.opts.resumeMs;
    this.broadcastStatus(now);
  }

  /**
   * This seat's faction is out (#183): the player watches the rest. No
   * control entry (nothing in the sim changes), no away/bot timers, no
   * commands; its hashes are still compared while it's heard from.
   */
  setSpectating(seat: number): void {
    const rec = this.seats.get(seat);
    if (rec) rec.state = 'spectating';
  }

  private setState(rec: SeatRec, state: CtrlSeatState, now: number): void {
    if (rec.state === state) return;
    rec.state = state;
    if (state === 'away') rec.awayAt = now;
    if (state === 'human') rec.heardAt = now;
    this.ctrlNext.push(state === 'bot' ? { k: 'seat', seat: rec.seat, state, bot: { ...this.opts.seatBot } } : { k: 'seat', seat: rec.seat, state });
  }

  private hash(seat: number, tick: number, h: number): void {
    if (tick >= this.next || tick < this.next - this.opts.hashTicks) return;
    let m = this.hashes.get(tick);
    if (!m) this.hashes.set(tick, (m = new Map()));
    m.set(seat, h);
    // humans, and spectators still here: a defeated player's world is checked too
    const now = this.clock();
    let expected = 0;
    for (const r of this.seats.values()) if (r.state === 'human' || (r.state === 'spectating' && now - r.heardAt <= this.opts.awayMs)) expected++;
    if (m.size >= expected) this.judge(tick, m);
  }

  private judge(tick: number, m: Map<number, number>): void {
    this.hashes.delete(tick);
    this.onHashes?.(tick, m);
    const counts = new Map<number, number>();
    for (const h of m.values()) counts.set(h, (counts.get(h) ?? 0) + 1);
    if (counts.size <= 1 || this.desyncAt >= 0) return;
    this.desyncAt = tick;
    // the majority's hash, if there is one (with two seats there never is)
    const top = Math.max(...counts.values());
    const tops = [...counts].filter(([, n]) => n === top);
    const odd = tops.length === 1 ? [...m].filter(([, h]) => h !== tops[0][0]).map(([s]) => s) : [...m.keys()];
    this.desyncs.push({ tick, hashes: Object.fromEntries(m) });
    this.onDesync?.(tick, m, odd.sort((a, b) => a - b));
    if (this.opts.haltOnDesync) this.halt(tick, this.clock());
  }

  /**
   * Stop the match for everyone (#165): a pause nobody's allowance pays for,
   * that never ends by itself. The `desync` entry rides on the turn now open,
   * so every client stops on the same tick.
   */
  private halt(tick: number, now: number): void {
    if (this.pause) {
      // already paused: it just won't end by itself now. If the clock has
      // stopped, every client is stopped on the same tick already; an entry
      // would only go out on resume, and halt everyone again.
      if (this.pauseAfter >= 0) this.ctrlNext.push({ k: 'desync', tick });
      this.pause.by = -1;
      this.pause.resumeAt = Infinity;
      this.broadcastStatus(now);
      return;
    }
    this.ctrlNext.push({ k: 'desync', tick });
    this.pause = { by: -1, at: now, resumeAt: Infinity };
    this.pauseAfter = this.next;
  }

  /** Watch for the next mismatch again (after a resync, #165). */
  clearDesync(): void {
    this.desyncAt = -1;
    this.hashes.clear();
  }

  /** The peer playing a seat (null: the host's own, or nobody). */
  peerOfSeat(seat: number): string | null {
    return this.seats.get(seat)?.peer ?? null;
  }

  // ---- clock -----------------------------------------------------------------

  /** Close every turn whose time has come, and run the seat timers. */
  update(): void {
    const now = this.clock();
    this.seatTimers(now);
    if (now - this.latAt >= this.opts.latMs) this.broadcastLat(now);
    if (this.pause && this.pauseAfter < 0) {
      this.paused_(now);
      return;
    }
    while (now >= this.t0 + this.next * DT_MS) {
      this.close();
      if (this.pauseAfter >= 0 && this.next > this.pauseAfter) {
        this.pauseAfter = -1;
        this.broadcastStatus(now);
        return;
      }
    }
  }

  private paused_(now: number): void {
    const p = this.pause!;
    const by = this.seats.get(p.by);
    if (by && p.resumeAt === Infinity) {
      // spend the pauser's allowance; when it runs out, the countdown starts by itself
      by.pauseMsLeft -= now - p.at;
      p.at = now;
      if (by.pauseMsLeft <= 0) p.resumeAt = now + this.opts.resumeMs;
    }
    if (now >= p.resumeAt) {
      this.pause = null;
      // a halt (by -1, #165) has no seat to name: turns simply flow again
      if (p.by >= 0) this.ctrlNext.push({ k: 'resume', seat: p.by });
      // the next turn closes one tick after play resumes
      this.t0 = p.resumeAt - (this.next - 1) * DT_MS;
      this.broadcastStatus(now);
      this.update();
      return;
    }
    if (now - this.statusAt >= this.opts.statusMs) this.broadcastStatus(now);
  }

  /** Every human seat's round trip and order-to-effect delay: their RTT, the delay their orders are held, and their buffer. */
  private broadcastLat(now: number): void {
    this.latAt = now;
    const rows: LatRow[] = [...this.seats.values()].map((r) => ({ seat: r.seat, state: r.state, rtt: r.rtt, delay: r.rtt + (r.d + r.buffer) * DT_MS }));
    for (const peer of this.byPeer.keys()) this.send(peer, { k: 'lat', rows });
  }

  private broadcastStatus(now: number): void {
    this.statusAt = now;
    const p = this.pause;
    const left = p ? (this.seats.get(p.by)?.pauseMsLeft ?? 0) : 0;
    const msg: Msg = p
      ? {
          k: 'status',
          paused: true,
          by: p.by,
          resumeIn: p.resumeAt === Infinity ? -1 : Math.max(0, Math.round(p.resumeAt - now)),
          auto: p.resumeAt === Infinity ? Math.max(0, Math.round(left - (now - p.at))) + this.opts.resumeMs : Math.max(0, Math.round(p.resumeAt - now)),
        }
      : { k: 'status', paused: false, by: -1, resumeIn: 0, auto: 0 };
    for (const peer of this.byPeer.keys()) this.send(peer, msg);
  }

  private seatTimers(now: number): void {
    for (const r of this.seats.values()) {
      if (r.state === 'human' && now - r.heardAt > this.opts.awayMs) this.setState(r, 'away', now);
      else if (r.state === 'away' && now - r.awayAt > this.opts.botMs) this.setState(r, 'bot', now);
    }
    this.retargetDelays(now);
  }

  /**
   * Fair in PvP: when two humans are on opposing teams, each seat is held so
   * its total order-to-effect delay (RTT + D + jitter buffer) matches the
   * slowest human's. Fast in co-op: everyone gets dMin. D moves a tick at a
   * time, so delays don't swing, and never above dMax.
   */
  private retargetDelays(now: number): void {
    const live = [...this.seats.values()].filter((r) => r.state === 'human');
    const pvp = new Set(live.map((r) => r.team)).size > 1;
    const est = (r: SeatRec) => r.rtt + r.buffer * DT_MS;
    const worst = pvp ? Math.max(...live.map(est)) : 0;
    for (const r of this.seats.values()) {
      const hold = pvp && r.state === 'human' ? Math.ceil((worst - est(r)) / DT_MS - 1e-9) : 0;
      const target = Math.min(this.opts.dMax, this.opts.dMin + Math.max(0, hold));
      if (target === r.d || now - r.dAt < this.opts.dStepMs) continue;
      r.d += target > r.d ? 1 : -1;
      r.dAt = now;
    }
  }

  private close(): void {
    const t = this.next;
    const entries = this.pending.get(t) ?? [];
    this.pending.delete(t);
    const turn: Turn = this.ctrlNext.length ? { entries, ctrl: this.ctrlNext } : { entries };
    this.ctrlNext = [];
    this.history.push(turn);
    this.next++;
    // hash reports too old to complete are judged with what came in
    const stale = t - this.opts.hashTicks;
    for (const [tick, m] of this.hashes) if (tick <= stale) this.judge(tick, m);
    const msg: Msg = { k: 'turns', epoch: this.epoch, first: t, list: [turn] };
    for (const peer of this.byPeer.keys()) this.send(peer, msg);
    this.onTurn?.(t, turn);
  }

  /** Resend closed turns [from, to] to one peer, in batches. */
  sendRange(peer: string, from: number, to: number): void {
    from = Math.max(from, this.base);
    to = Math.min(to, this.next - 1);
    for (let a = from; a <= to; a += MAX_TURNS_PER_MSG) {
      const b = Math.min(to, a + MAX_TURNS_PER_MSG - 1);
      this.send(peer, { k: 'turns', epoch: this.epoch, first: a, list: this.history.slice(a - this.base, b - this.base + 1) });
    }
  }

  // ---- handoff ---------------------------------------------------------------

  exportState(): SequencerState {
    const now = this.clock();
    const p = this.pause;
    return JSON.parse(JSON.stringify({
      epoch: this.epoch,
      next: this.next,
      pending: [...this.pending].sort((a, b) => a[0] - b[0]),
      ctrlNext: this.ctrlNext,
      seats: [...this.seats.values()].map((r) => ({ ...r, heardAt: now - r.heardAt, awayAt: now - r.awayAt, tokensAt: now - r.tokensAt, dAt: now - r.dAt })),
      pause: p ? { by: p.by, since: now - p.at, resumeIn: p.resumeAt === Infinity ? -1 : p.resumeAt - now, after: this.pauseAfter } : null,
    })) as SequencerState;
  }

  /** Every closed turn still held, oldest first (for a successor, or a resumable match). */
  closedTurns(): { first: number; turns: Turn[] } {
    return { first: this.base, turns: this.history.slice() };
  }
}
