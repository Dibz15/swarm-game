import { limitsOf } from '../sim/sanitize';
import type { MatchSetup } from '../sim/setup';
import { decodeSnap, restoreWorld, serializeWorld } from '../sim/snapshot';
import { decodeMsg, encodeMsg, msgKind } from './codec';
import { analyzeDesync, type DesyncReport } from './desync';
import { FakeNetwork, VirtualClock, type LinkSpec } from './fakeTransport';
import type { HostGo } from './lobby';
import { NetSession, type NetSessionOptions } from './netSession';
import { MAX_TURNS_PER_MSG, type Ctrl, type Msg, type MsgKind } from './protocol';
import { rebuildState, Sequencer, type SequencerOptions, type SequencerState } from './sequencer';
import { canGzip, chunkSnap, packSnap, settle, SnapAssembler, unpackSnap } from './snapwire';
import { HOST_SELF, hostSequencer, type Transport } from './transport';

/**
 * One networked match from this peer's side (#162): the local NetSession,
 * and while this peer hosts, the Sequencer too. The app calls `update()`
 * every frame, before the game view steps; a host also runs off a worker
 * heartbeat, so a hidden host tab keeps closing turns (browsers throttle a
 * hidden tab's own timers to 1 Hz, but not a worker's).
 *
 * Hosting moves (#166). Running the sequencer is a role, apart from the
 * seat: when the host leaves it hands its state to a successor, and when it
 * vanishes the players elect one, with no voting round:
 *
 * - Every player beats to every other twice a second: the epoch it follows,
 *   whether it still hears the host, and whether its page is hidden.
 * - Rank: desktop before phone, then seat order, the same on every peer.
 * - A player suspects the host after SILENCE_MS without a word from it (the
 *   host says something every second, even paused), or at once when its
 *   link drops. It claims only if a majority of the electorate (everyone
 *   but the host, minus the gone and the hidden) suspects it too, and it
 *   ranks first among them: an isolated player never takes over while the
 *   others are still reachable.
 * - The claimant collects the closed turns the others hold beyond its own,
 *   rebuilds the sequencer's state from the log, and leads from the first
 *   tick nobody holds. Epochs encode (round, rank), so the highest epoch
 *   always wins, ties included; a deposed host that hears it steps down,
 *   and a player that ran past the fork resyncs from the new host's world.
 */

export interface NetMatchEvents {
  /** a seat went away, was taken by a bot, or came back */
  onSeat?: (seat: number, state: 'human' | 'away' | 'bot') => void;
  /** the host paused or resumed */
  onPause?: (paused: boolean) => void;
  /** another player runs the match now (#166): the seat they play, and their peer id (ours when it's us) */
  onLeader?: (seat: number, peer: string) => void;
  /** no word from the host for a while (#166): the match waits while a new one is found; false when it goes on */
  onStall?: (stalled: boolean) => void;
  /** players' worlds stopped matching at `tick` (#165): the match halted for everyone */
  onDesync?: (tick: number) => void;
  /** host: what it found once every world came in (or the wait ran out) */
  onDesyncReport?: (report: DesyncReport) => void;
  /** guests: the host's word on it, the first field that differs */
  onDesyncNote?: (tick: number, text: string) => void;
}

/** A human seat in the match, and the peer that plays it. */
export interface MatchPeer {
  seat: number;
  team: number;
  peer: string;
  mobile: boolean;
}

export interface MatchConfig {
  setup: MatchSetup;
  /** our seat */
  seat: number;
  /** every human seat (ours included) */
  peers: MatchPeer[];
  /** the peer running the sequencer now (ours: we host) */
  leader: string;
  /** a dropped seat's idle time before its Easy bot, ms (#164) */
  botMs?: number;
  clock?: () => number;
  seq?: Partial<SequencerOptions>;
  net?: Partial<NetSessionOptions>;
  /** run the sequencer off a worker heartbeat while hosting (default true; off in tests) */
  heartbeat?: boolean;
  /** gzip the snapshots we send (default: where the browser can) */
  gzip?: boolean;
  /** rejoining a match under way (#164) */
  resume?: boolean;
}

/** what the host may get from a player */
const TO_SEQ = new Set<MsgKind>(['cmd', 'ack', 'ping', 'hash', 'pause', 'reclaim', 'away', 'snapreq', 'snap']);
/** players talking among themselves about who hosts (#166) */
const MESH = new Set<MsgKind>(['beat', 'claim', 'lead', 'handoff']);
/**
 * what only a running sequencer sends: hearing these, and not a player's
 * beats, is what tells us the host still hosts (#166)
 */
const SEQ_OUT = new Set<MsgKind>(['turns', 'status', 'lat', 'pong', 'snap', 'snapreq', 'desync']);

export const BEAT_MS = 500;
/** a player beat within this is alive */
export const ALIVE_MS = 2000;
/** no word from the host this long: suspect it */
export const SILENCE_MS = 1500;
/** a claimant waits this long for the others' turns */
export const COLLECT_MS = 400;
/** after someone claims: wait this long for their `lead` before looking again */
export const LEAD_WAIT_MS = 1000;
/** the host said goodbye: its handoff may still be on its way (another channel) */
export const BYE_WAIT_MS = 150;

/** Who takes over first: desktop before phone, then seat order. */
export function rankOf(peers: readonly MatchPeer[]): string[] {
  return [...peers].sort((a, b) => Number(a.mobile) - Number(b.mobile) || a.seat - b.seat).map((p) => p.peer);
}

/** Epoch for a takeover: the round, then rank (first ranked highest), so the highest epoch always wins. */
export function epochFor(round: number, rank: number): number {
  return round * 8 + (7 - Math.min(7, rank));
}

export class NetMatch {
  readonly session: NetSession;
  events: NetMatchEvents = {};
  private seq_: Sequencer | null = null;
  private beat: Worker | null = null;
  /** the first sequencer, made on the first update or heartbeat (see `tick`) */
  private makeSeq: (() => Sequencer) | null = null;
  private readonly heartbeat: boolean;
  private readonly clockSync: (() => void) | null;
  private readonly cleanup: () => void;
  private readonly clock: () => number;

  // ---- the room's match (remote null: `local`)
  private readonly remote: Transport | null;
  private readonly self: string;
  private readonly mySeat: number;
  private peers: MatchPeer[];
  private leaderId: string;
  private leading_ = false;
  private epoch = 0;
  /** the first tick this peer's own sequencer closed: the fork point it leads from */
  private forkAt = 1;
  private readonly seqOpts: Partial<SequencerOptions>;
  private readonly gzip: boolean;
  /** what the session talks through: to our own sequencer while we host, else to the host */
  private readonly port: Transport;

  // ---- choosing a host (#166)
  private readonly started: number;
  private heardAt = new Map<string, number>();
  private beats = new Map<string, { at: number; epoch: number; ok: boolean; hidden: boolean; syncing: boolean }>();
  private gone = new Set<string>();
  private goneAt = new Map<string, number>();
  private linkLost = new Set<string>();
  private beatAt = -Infinity;
  private suspect = false;
  private stalled = false;
  private hidden = false;
  private candidate: { epoch: number; until: number } | null = null;
  private awaiting: { epoch: number; until: number } | null = null;

  // ---- desyncs (#165)
  private readonly snaps: SnapAssembler;
  private reported = new Map<number, [number, number][]>();
  private collect: { tick: number; hashes: Map<number, number>; odd: number[]; got: Map<number, Uint8Array>; until: number } | null = null;
  private report: DesyncReport | null = null;
  /** seats already marked spectating (#183) */
  private out = new Set<number>();

  private constructor(o: {
    session: (port: Transport) => NetSession;
    remote: Transport | null;
    seat: number;
    peers: MatchPeer[];
    leader: string;
    clock: () => number;
    cleanup: () => void;
    clockSync?: () => void;
    heartbeat?: boolean;
    seq?: Partial<SequencerOptions>;
    gzip?: boolean;
  }) {
    this.remote = o.remote;
    this.self = o.remote?.self ?? '';
    this.mySeat = o.seat;
    this.peers = o.peers;
    this.leaderId = o.leader;
    this.clock = o.clock;
    this.cleanup = o.cleanup;
    this.clockSync = o.clockSync ?? null;
    this.heartbeat = o.heartbeat ?? false;
    this.seqOpts = o.seq ?? {};
    this.gzip = o.gzip ?? canGzip;
    this.started = this.clock();
    this.snaps = new SnapAssembler(this.clock);
    const remote = this.remote;
    this.port = {
      self: this.self,
      onMessage: null,
      onPeer: null,
      send: (peer, bytes) => {
        if (this.leading_ && peer === this.self) this.toSeq(HOST_SELF, bytes);
        else remote?.send(peer, bytes);
      },
      close: () => undefined,
    };
    this.session = o.session(this.port);
    if (remote) this.wire(remote);
    this.session.onCtrl = (_t, c: Ctrl) => {
      if (c.k === 'seat') this.events.onSeat?.(c.seat, c.state);
      else if (c.k === 'desync') this.events.onDesync?.(c.tick);
      else this.events.onPause?.(c.k === 'pause');
    };
    this.session.onDesyncNote = (t, text) => this.events.onDesyncNote?.(t, text);
  }

  /**
   * A match in a room (#162, #166): every player's side, hosting or not.
   * `leader` is whoever runs the sequencer at the start: us, when we host.
   */
  static create(remote: Transport, cfg: MatchConfig): NetMatch {
    const clock = cfg.clock ?? (() => performance.now());
    const m = new NetMatch({
      session: (port) => new NetSession({ setup: cfg.setup, seat: cfg.seat, transport: port, host: cfg.leader, clock, opts: cfg.net, resume: cfg.resume }),
      remote,
      seat: cfg.seat,
      peers: cfg.peers,
      leader: cfg.leader,
      clock,
      cleanup: () => remote.close(),
      heartbeat: cfg.heartbeat !== false,
      seq: { ...(cfg.botMs ? { botMs: cfg.botMs } : {}), ...cfg.seq },
      gzip: cfg.gzip,
    });
    if (cfg.leader === remote.self) {
      m.leading_ = true;
      m.makeSeq = () =>
        new Sequencer({
          limits: limitsOf(m.session.world),
          seats: cfg.peers.map((p) => ({ seat: p.seat, team: p.team, peer: p.peer === remote.self ? HOST_SELF : p.peer })),
          clock,
          send: (peer, msg) => m.seqSend(peer, msg),
          // only the host stops the match for everyone; guests' menus leave it running
          opts: { pausers: [cfg.seat], ...m.seqOpts },
        });
      // The sequencer is made on the first update or heartbeat, not here: its
      // turn clock starts then, once the game view is built, so the first
      // turns don't go out in a burst. The heartbeat starts now, so a host
      // that switches tabs right after Start still starts the match.
      if (m.heartbeat) m.startHeartbeat();
    }
    return m;
  }

  /** The room's host at the start (#162). */
  static host(
    remote: Transport,
    go: HostGo,
    o: { clock?: () => number; seq?: Partial<SequencerOptions>; net?: Partial<NetSessionOptions>; heartbeat?: boolean; gzip?: boolean } = {},
  ): NetMatch {
    const peers = go.seats.map((s) => ({ seat: s.seat, team: s.team, peer: s.peer ?? remote.self, mobile: s.mobile }));
    return NetMatch.create(remote, { setup: go.setup, seat: go.hostSeat, peers, leader: remote.self, botMs: go.botMs, ...o });
  }

  /** A guest's side (#162). `resume`: rejoining a match under way (#164). `peers`: every human seat, to take over hosting (#166). */
  static guest(
    t: Transport,
    setup: MatchSetup,
    seat: number,
    host: string,
    o: { clock?: () => number; net?: Partial<NetSessionOptions>; resume?: boolean; peers?: MatchPeer[]; botMs?: number; heartbeat?: boolean; gzip?: boolean } = {},
  ): NetMatch {
    return NetMatch.create(t, { setup, seat, peers: o.peers ?? [], leader: host, ...o });
  }

  /**
   * A match against bots with the sequencer behind a simulated link (`?lag=`,
   * #162): NetSession in the real game, with no other player. The fake
   * network's clock follows real time.
   */
  static local(setup: MatchSetup, seat: number, link: Partial<LinkSpec>): NetMatch {
    const clock = new VirtualClock();
    const net = new FakeNetwork(clock, 1);
    net.link('me', 'host', link);
    const hostT = net.transport('host');
    // virtual time starts with the first frame, like the sequencer
    let t0 = -1;
    const m = new NetMatch({
      session: () => new NetSession({ setup, seat, transport: net.transport('me'), host: 'host', clock: () => clock.now }),
      remote: null,
      seat,
      peers: [],
      leader: 'host',
      clock: () => clock.now,
      cleanup: () => undefined,
      clockSync: () => {
        if (t0 < 0) t0 = performance.now();
        clock.advanceTo(performance.now() - t0);
      },
    });
    m.makeSeq = () => hostSequencer(hostT, { limits: limitsOf(m.session.world), seats: [{ seat, team: seat, peer: 'me' }], clock: () => clock.now });
    return m;
  }

  // ---- what the app sees ----------------------------------------------------

  /** we run the match for everyone now (a `?lag=` match always does) */
  get host(): boolean {
    return this.leading_ || this.remote === null;
  }

  /** the sequencer, while we host and once the match has started */
  get seq(): Sequencer | null {
    return this.seq_;
  }

  /** the seat whose player hosts now */
  get leaderSeat(): number {
    return this.peers.find((p) => p.peer === this.leaderId)?.seat ?? -1;
  }

  /** The other players still connected (#166): who a room taken over starts with. */
  livePeers(): string[] {
    return this.others();
  }

  /** Who would take over hosting if we left now (#166): their seat, or -1. */
  successorSeat(): number {
    const succ = this.successor(this.clock());
    return this.peers.find((p) => p.peer === succ)?.seat ?? -1;
  }

  /** The first player in rank who could host now: connected, beating, shown, and with a world. */
  private successor(now: number): string | undefined {
    return rankOf(this.peers).find((p) => p !== this.self && !this.gone.has(p) && this.canHost(p, now));
  }

  /** The seats' players changed (a rejoin under a new peer id, #164): keep the election's list current. */
  updatePeers(peers: MatchPeer[]): void {
    this.peers = peers;
  }

  /** Our page was hidden or shown (#164): our seat goes away, and we can't help elect a host meanwhile. */
  setHidden(on: boolean): void {
    this.hidden = on;
    this.session.setHidden(on);
    if (on && this.remote) this.beatNow(this.clock());
  }

  /** Host: a player came back on a new connection (a reload, #164): their seat now answers to `peer`. */
  rebind(seat: number, peer: string): void {
    if (!this.seq_ && this.makeSeq) this.tick();
    this.seq_?.bindPeer(seat, peer);
    this.peers = this.peers.map((p) => (p.seat === seat ? { ...p, peer } : p));
  }

  /**
   * Host, leaving on purpose (#166): hand the sequencer to the first player
   * in rank who is still here, with every turn it lacks. False when there's
   * nobody to hand it to.
   */
  handOff(): boolean {
    const seq = this.seq_;
    const remote = this.remote;
    if (!this.leading_ || !seq || !remote) return false;
    const succ = this.successor(this.clock());
    if (!succ) return false;
    seq.sendRange(succ, seq.ackOf(succ) + 1, seq.closed);
    const epoch = epochFor(Math.floor(this.epoch / 8) + 1, rankOf(this.peers).indexOf(succ));
    const state = JSON.stringify(seq.exportState());
    // no longer ours before it goes out: whatever answers it finds us a follower
    this.stepDown();
    // our epoch stays: if the successor has to claim instead, its claim is above ours, and we answer it with our turns
    this.leaderId = succ;
    remote.send(succ, encodeMsg({ k: 'handoff', epoch, state }));
    return true;
  }

  /** Host: the last desync's report, once the worlds came in (#165). */
  get desyncReport(): DesyncReport | null {
    return this.report;
  }

  /** Host: every hash each seat reported lately, for the report bundle. */
  reportedHashes(): Record<number, [number, number][]> {
    return Object.fromEntries(this.reported);
  }

  /**
   * Host, after a desync (#165): send everyone the majority's world at the
   * tick it happened, have every client re-run its turns since on it, and
   * resume. False when there's no agreed world to send.
   */
  resync(): boolean {
    const r = this.report;
    const seq = this.seq_;
    if (!r || r.ref < 0 || !seq) return false;
    const bytes = r.snaps.get(r.ref)!;
    const meta = { tick: r.tick, pausedBy: -1, seqBase: 0, resync: true };
    // everyone else first, then ourselves; then watch for the next mismatch, and resume
    for (const s of Object.keys(r.hashes).map(Number)) {
      const peer = seq.peerOfSeat(s);
      if (!peer || peer === HOST_SELF) continue;
      settle(packSnap(meta, bytes, this.gzip), (packed) => chunkSnap(r.tick, packed).forEach((c) => this.seqSend(peer, c)), () => undefined);
    }
    this.session.adopt(restoreWorld(this.session.setup, decodeSnap(bytes)), meta, { restep: true });
    seq.clearDesync();
    this.report = null;
    this.session.setPaused(false);
    return true;
  }

  /** every frame, before the game view steps */
  update(): void {
    this.clockSync?.();
    this.tick();
  }

  close(): void {
    this.beat?.terminate();
    this.beat = null;
    this.cleanup();
  }

  // ---- plumbing ---------------------------------------------------------------

  /** One dispatcher owns the room's transport: the sequencer, the session and the election each get their part. */
  private wire(remote: Transport): void {
    remote.onMessage = (peer, bytes) => {
      const k = msgKind(bytes);
      if (!k) return;
      const now = this.clock();
      if (SEQ_OUT.has(k)) this.heardAt.set(peer, now);
      if (MESH.has(k)) {
        const m = decodeMsg(bytes);
        if (m) this.mesh(peer, m, now);
        return;
      }
      if (this.leading_ && TO_SEQ.has(k)) return this.toSeq(peer, bytes);
      if (k === 'turns' && peer !== this.leaderId) {
        // turns another player forwards while we take over
        if (this.candidate) {
          const m = decodeMsg(bytes);
          if (m?.k === 'turns') this.session.absorb(m.first, m.list);
        }
        return;
      }
      this.port.onMessage?.(peer, bytes);
    };
    remote.onPeer = (peer, up) => {
      if (up) {
        this.gone.delete(peer);
        return;
      }
      this.gone.add(peer);
      this.goneAt.set(peer, this.clock());
      if (this.leading_) this.seq_?.peerLost(peer);
    };
    remote.onLink = (peer, state) => {
      if (state === 'lost') this.linkLost.add(peer);
      else this.linkLost.delete(peer);
    };
  }

  /** From our sequencer: to our own session in-process, or to a player. */
  private seqSend(peer: string, msg: Msg): void {
    if (peer === HOST_SELF) this.port.onMessage?.(this.self, encodeMsg(msg));
    else this.remote?.send(peer, encodeMsg(msg));
  }

  /** To our sequencer: what the match answers itself (snapshots), or the sequencer's own business. */
  private toSeq(peer: string, bytes: Uint8Array): void {
    const seq = this.seq_;
    const m = decodeMsg(bytes);
    if (!seq || !m) return;
    if (m.k === 'snapreq') return this.serveSnap(peer, m.tick);
    if (m.k === 'snap') return this.snapIn(peer, m);
    seq.onMessage(peer, m);
  }

  /** Close any turns that are due (making the first sequencer, if this is the start), and keep an eye on the host. */
  private tick(): void {
    if (!this.seq_ && this.makeSeq && (this.leading_ || !this.remote)) {
      const seq = this.makeSeq();
      this.makeSeq = null;
      this.adoptSeq(seq);
    }
    this.seq_?.update();
    this.markSpectators();
    this.checkCollect();
    if (this.remote) this.elect(this.clock());
  }

  private adoptSeq(seq: Sequencer): void {
    this.seq_ = seq;
    seq.onHashes = (tick, hs) => {
      for (const [s, h] of hs) {
        const rows = this.reported.get(s) ?? [];
        rows.push([tick, h]);
        if (rows.length > 600) rows.shift();
        this.reported.set(s, rows);
      }
    };
    seq.onDesync = (tick, hashes, odd) => this.startCollect(tick, hashes, odd);
  }

  private startHeartbeat(): void {
    if (this.beat || typeof Worker === 'undefined' || typeof Blob === 'undefined') return;
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }));
      this.beat = new Worker(url);
      URL.revokeObjectURL(url);
      this.beat.onmessage = () => this.tick();
    } catch {
      this.beat = null; // no workers here: the frame loop alone drives it
    }
  }

  /**
   * Host: a seat whose faction is out watches the rest (#183). Read from the
   * host's own world: every world agrees on who is eliminated, so the
   * sequencer can stay world-less.
   */
  private markSpectators(): void {
    const seq = this.seq_;
    if (!seq) return;
    for (const f of this.session.world.factions) {
      if (!f.eliminated || this.out.has(f.id) || seq.seatState(f.id) === undefined) continue;
      this.out.add(f.id);
      seq.setSpectating(f.id);
    }
  }

  // ---- snapshots: a rejoining player's (#164), a desync's (#165) -------------

  /** A rejoining or forked player's world: ours, which every client agrees on up to its tick, then the closed turns after it. */
  private serveSnap(peer: string, tick: number): void {
    const seq = this.seq_;
    const seat = seq?.seatOfPeer(peer) ?? -1;
    if (!seq || seat < 0 || tick !== 0) return;
    const w = this.session.world;
    const meta = { tick: w.tick, pausedBy: this.session.pausedSeat, seqBase: seq.seatSeq(seat) };
    settle(
      packSnap(meta, serializeWorld(w), this.gzip),
      (packed) => {
        for (const c of chunkSnap(meta.tick, packed)) this.seqSend(peer, c);
        seq.sendRange(peer, meta.tick + 1, seq.closed);
      },
      () => undefined,
    );
  }

  private startCollect(tick: number, hashes: Map<number, number>, odd: number[]): void {
    const c = { tick, hashes, odd, got: new Map<number, Uint8Array>(), until: this.clock() + 5000 };
    this.collect = c;
    const own = this.session.keptSnap(tick);
    if (own) c.got.set(this.mySeat, own);
    for (const s of hashes.keys()) {
      const peer = this.seq_?.peerOfSeat(s);
      if (peer && peer !== HOST_SELF) this.seqSend(peer, { k: 'snapreq', tick });
    }
    this.checkCollect();
  }

  private snapIn(peer: string, msg: Extract<Msg, { k: 'snap' }>): void {
    const whole = this.snaps.add(peer, msg);
    const c = this.collect;
    if (!whole || !c || msg.tick !== c.tick) return;
    const seat = this.seq_?.seatOfPeer(peer) ?? -1;
    settle(
      unpackSnap(whole),
      (s) => {
        if (this.collect !== c || seat < 0) return;
        c.got.set(seat, s.world);
        this.checkCollect();
      },
      () => undefined,
    );
  }

  private checkCollect(): void {
    const c = this.collect;
    if (!c) return;
    if (![...c.hashes.keys()].every((s) => c.got.has(s)) && this.clock() < c.until) return;
    this.collect = null;
    const report = analyzeDesync(c.tick, c.hashes, c.odd, c.got, this.mySeat);
    this.report = report;
    this.events.onDesyncReport?.(report);
    const text = report.first ?? (report.ref < 0 ? 'no world to compare with came in' : 'no field differs (only the hash)');
    for (const s of c.hashes.keys()) {
      const peer = this.seq_?.peerOfSeat(s);
      if (peer && peer !== HOST_SELF) this.seqSend(peer, { k: 'desync', tick: c.tick, text });
    }
  }

  // ---- choosing a host (#166) --------------------------------------------------

  /** beating lately, shown, and not waiting for a snapshot: could run the sequencer */
  private canHost(peer: string, now: number): boolean {
    const b = this.beats.get(peer);
    return !!b && now - b.at <= ALIVE_MS && !b.hidden && !b.syncing;
  }

  /** every other player still connected */
  private others(): string[] {
    return this.peers.map((p) => p.peer).filter((p) => p !== this.self && !this.gone.has(p));
  }

  private broadcast(m: Msg): void {
    const bytes = encodeMsg(m);
    for (const p of this.others()) this.remote?.send(p, bytes);
  }

  private beatNow(now: number): void {
    this.beatAt = now;
    this.broadcast({ k: 'beat', epoch: this.epoch, ok: !this.suspect, hidden: this.hidden, syncing: this.session.syncing });
  }

  private elect(now: number): void {
    if (!this.peers.length) return;
    this.epoch = Math.max(this.epoch, this.session.currentEpoch);
    if (now - this.beatAt >= BEAT_MS) this.beatNow(now);
    if (this.leading_) return;
    if (this.candidate) {
      if (now >= this.candidate.until) this.promote(this.candidate.epoch);
      return;
    }
    if (this.awaiting) {
      if (now < this.awaiting.until) return;
      this.awaiting = null; // whoever claimed never led: look again
    }
    const leader = this.leaderId;
    const quiet = now - (this.heardAt.get(leader) ?? this.started);
    const left = this.gone.has(leader) && now - (this.goneAt.get(leader) ?? now) >= BYE_WAIT_MS;
    // a player waiting for a snapshot still says whether it hears the host: it votes, but can't lead
    const suspect = !this.hidden && (left || this.linkLost.has(leader) || quiet > SILENCE_MS);
    if (suspect !== this.suspect) {
      this.suspect = suspect;
      this.beatNow(now);
    }
    this.setStalled(suspect);
    if (!suspect) return;
    // everyone but the host who could still take part: not gone, not hidden
    const electorate = this.others().filter((p) => p !== leader && !this.beats.get(p)?.hidden);
    const voters = [
      this.self,
      ...electorate.filter((p) => {
        const b = this.beats.get(p);
        return !!b && now - b.at <= ALIVE_MS && b.epoch === this.epoch && !b.ok;
      }),
    ];
    if (voters.length < Math.floor((electorate.length + 1) / 2) + 1) return;
    // the first-ranked voter with a world to host from takes over
    const rank = rankOf(this.peers);
    const first = rank.find((p) => voters.includes(p) && (p === this.self ? !this.session.syncing : !this.beats.get(p)?.syncing));
    if (first !== this.self) return;
    const epoch = epochFor(Math.floor(this.epoch / 8) + 1, rank.indexOf(this.self));
    this.candidate = { epoch, until: now + COLLECT_MS };
    this.broadcast({ k: 'claim', epoch, held: this.session.heldTick });
  }

  private mesh(peer: string, m: Msg, now: number): void {
    switch (m.k) {
      case 'beat':
        this.beats.set(peer, { at: now, epoch: m.epoch, ok: m.ok, hidden: m.hidden, syncing: m.syncing });
        // a player still on an old epoch (back from a partition): tell it who hosts now
        if (this.leading_ && m.epoch < this.epoch) this.remote?.send(peer, encodeMsg({ k: 'lead', epoch: this.epoch, next: this.forkAt }));
        return;
      case 'claim': {
        if (m.epoch <= this.epoch || m.epoch <= (this.candidate?.epoch ?? -1) || m.epoch <= (this.awaiting?.epoch ?? -1)) {
          if (this.leading_ && m.epoch <= this.epoch) this.remote?.send(peer, encodeMsg({ k: 'lead', epoch: this.epoch, next: this.forkAt }));
          return;
        }
        // someone ranked higher takes over: give them every closed turn we hold beyond theirs
        const log = this.leading_ && this.seq_ ? this.seq_.closedTurns() : this.session.closedTurns();
        const from = Math.max(m.held + 1, log.first);
        const turns = log.turns.slice(from - log.first);
        for (let i = 0; i < turns.length; i += MAX_TURNS_PER_MSG) {
          this.remote?.send(peer, encodeMsg({ k: 'turns', epoch: this.epoch, first: from + i, list: turns.slice(i, i + MAX_TURNS_PER_MSG) }));
        }
        if (this.leading_) this.stepDown();
        this.candidate = null;
        this.awaiting = { epoch: m.epoch, until: now + LEAD_WAIT_MS };
        return;
      }
      case 'lead':
        if (m.epoch <= this.epoch && !(this.awaiting && m.epoch >= this.awaiting.epoch)) return;
        // we claimed above it: that leader steps down when our claim reaches it, and we lead
        if (this.candidate && m.epoch < this.candidate.epoch) return;
        this.follow(peer, m.epoch, m.next);
        return;
      case 'handoff': {
        if (peer !== this.leaderId || m.epoch <= this.epoch) return;
        let state: SequencerState;
        try {
          state = JSON.parse(m.state) as SequencerState;
        } catch {
          return;
        }
        // every turn it closed came first, on the same channel; if not, collect them the long way
        if (this.session.syncing || this.session.heldTick !== state.next - 1) {
          this.candidate = { epoch: m.epoch, until: now + COLLECT_MS };
          this.broadcast({ k: 'claim', epoch: m.epoch, held: this.session.heldTick });
          return;
        }
        this.promote(m.epoch, state);
        return;
      }
      default:
        return;
    }
  }

  /** Someone else hosts now. */
  private follow(peer: string, epoch: number, next: number): void {
    if (this.leading_) this.stepDown();
    this.candidate = null;
    this.awaiting = null;
    this.leaderId = peer;
    this.epoch = epoch;
    this.heardAt.set(peer, this.clock());
    this.session.follow(peer, epoch, next);
    this.suspect = false;
    this.setStalled(false);
    this.events.onLeader?.(this.leaderSeat, peer);
  }

  /** We host now: a sequencer from the handed-over state, or rebuilt from our log. */
  private promote(epoch: number, handed?: SequencerState): void {
    const old = this.leaderId;
    const hist = this.session.closedTurns();
    const next = hist.first + hist.turns.length;
    const seats = this.peers.map((p) => ({ seat: p.seat, team: p.team, peer: p.peer === this.self ? HOST_SELF : p.peer }));
    const state: SequencerState = handed
      ? {
          ...handed,
          epoch,
          // the old host's own seat was HOST_SELF there; ours is HOST_SELF here
          seats: handed.seats.map((r) => ({ ...r, peer: r.peer === HOST_SELF ? old : r.seat === this.mySeat ? HOST_SELF : r.peer })),
        }
      : rebuildState({ epoch, next, seats, history: hist, opts: this.seqOpts, lat: this.session.lat });
    const seq = new Sequencer({
      limits: limitsOf(this.session.world),
      seats: [],
      clock: this.clock,
      send: (peer, msg) => this.seqSend(peer, msg),
      opts: { ...this.seqOpts, pausers: [this.mySeat] },
      resume: { state, history: hist },
      epoch,
    });
    this.candidate = null;
    this.awaiting = null;
    this.leading_ = true;
    this.leaderId = this.self;
    this.epoch = epoch;
    this.forkAt = next;
    this.adoptSeq(seq);
    this.out.clear();
    // the old host's seat: away now, then the room's bot policy
    if (old !== this.self) seq.peerLost(old);
    this.session.follow(this.self, epoch, next);
    this.broadcast({ k: 'lead', epoch, next });
    if (this.heartbeat) this.startHeartbeat();
    this.suspect = false;
    this.setStalled(false);
    this.events.onLeader?.(this.mySeat, this.self);
  }

  private setStalled(on: boolean): void {
    if (on === this.stalled) return;
    this.stalled = on;
    this.events.onStall?.(on);
  }

  /** We no longer host. */
  private stepDown(): void {
    this.leading_ = false;
    this.seq_ = null;
    this.collect = null;
    this.beat?.terminate();
    this.beat = null;
  }
}
