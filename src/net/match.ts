import { limitsOf } from '../sim/sanitize';
import type { MatchSetup } from '../sim/setup';
import { decodeSnap, hashBytes, restoreWorld, serializeWorld } from '../sim/snapshot';
import { decodeMsg, encodeMsg, msgKind } from './codec';
import { analyzeDesync, type DesyncReport } from './desync';
import { FakeNetwork, VirtualClock, type LinkSpec } from './fakeTransport';
import type { HostGo } from './lobby';
import { NetSession, type NetSessionOptions } from './netSession';
import { MAX_TURNS_PER_MSG, type Ctrl, type Msg, type MsgKind } from './protocol';
import { oddOnes, rebuildState, Sequencer, SEQUENCER_DEFAULTS, type SequencerOptions, type SequencerState } from './sequencer';
import { canGzip, chunkSnap, packSnap, settle, SnapAssembler, unpackSnap } from './snapwire';
import { HOST_SELF, hostSequencer, type Transport } from './transport';

/**
 * One networked match from this peer's side (#162): the local NetSession,
 * and while this peer hosts, the Sequencer too. The app calls `update()`
 * every frame, before the game view steps; a host also runs off a worker
 * heartbeat, so a hidden host tab keeps closing turns (browsers throttle a
 * hidden tab's own timers to 1 Hz, but not a worker's).
 *
 * Two roles (#190): the match's *host* (the room's host: pause, restart,
 * end, the room) and its *runner*, whose browser runs the sequencer. They
 * start out the same player. The runner is a performance choice: every
 * order's delay includes its sender's round trip to the runner, so a few
 * seconds in, once links are measured, the sequencer moves to the player
 * with the smallest worst round trip to the others (or the one the host
 * pinned). The host keeps its controls: its pause goes to the runner like
 * anyone's, and only its seat may pause. When the host leaves, the runner
 * becomes host.
 *
 * Running the sequencer moves (#166): when the runner leaves it hands its
 * state to a successor, and when it vanishes the players elect one, with no
 * voting round:
 *
 * - Every player beats to every other twice a second: the epoch it follows,
 *   whether it still hears the runner, whether its page is hidden, and a
 *   timestamp echo that measures the link (#190).
 * - Rank: the runner's published ranking (#190, a control entry in the turn
 *   log, so every peer ranks the same way), and before the first one,
 *   desktop before phone, then seat order.
 * - A player suspects the host after SILENCE_MS without a word from it (the
 *   host says something every second, even paused), or at once when its
 *   link drops. It claims only if a majority of the electorate (everyone
 *   but the host, minus the gone and the hidden) suspects it too, and it
 *   ranks first among them: an isolated player never takes over while the
 *   others are still reachable.
 * - The claimant collects the closed turns the others hold beyond its own,
 *   rebuilds the sequencer's state from the log, and leads from the first
 *   tick nobody holds. Epochs encode (round, seat), so no two claimants
 *   ever share one (even two that ranked differently, #190) and the highest
 *   always wins; a deposed host that hears it steps down,
 *   and a player that ran past the fork resyncs from the new host's world.
 */

export interface NetMatchEvents {
  /** a seat went away, was taken by a bot, or came back */
  onSeat?: (seat: number, state: 'human' | 'away' | 'bot') => void;
  /** the host paused or resumed */
  onPause?: (paused: boolean) => void;
  /** another player runs the match now (#166): the seat they play, and their peer id (ours when it's us) */
  onLeader?: (seat: number, peer: string) => void;
  /** the match has a new host (#190: the old one left): their seat, and their peer id (ours when it's us) */
  onOwner?: (seat: number, peer: string) => void;
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
  /** on mobile data, where the browser says (#190) */
  cell?: boolean;
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
  /** the match's host: pause, restart, end (#190). Default: the leader's seat */
  owner?: number;
  /** …or by peer, when the list of players doesn't have them yet (a rejoin before the lobby came in) */
  ownerPeer?: string;
  /** "Runs the match" (#190): the seat the host chose to run it; absent: Auto, by measured links */
  runnerSeat?: number;
}

/** what the host may get from a player */
const TO_SEQ = new Set<MsgKind>(['cmd', 'ack', 'ping', 'hash', 'pause', 'reclaim', 'away', 'snapreq', 'snap']);
/** players talking among themselves about who hosts (#166) */
const MESH = new Set<MsgKind>(['beat', 'claim', 'lead', 'handoff', 'links', 'ask', 'rebind']);
/**
 * what only a running sequencer sends: hearing these, and not a player's
 * beats, is what tells us the host still hosts (#166)
 */
const SEQ_OUT = new Set<MsgKind>(['turns', 'status', 'lat', 'pong', 'snap', 'snapreq', 'desync']);

export const BEAT_MS = 500;
/**
 * The host's own session holds one turn (#198): its turns come in-process,
 * with no network jitter, so it never needs more; with none, its steps fall
 * out of phase with the turn clock and stutter.
 */
const HOST_BUFFER = 1;
/**
 * The heartbeat that closes turns while hosting, ms (#198): often enough
 * that a turn goes out within a few ms of its time, even when frames are
 * slow; a beat with nothing due costs next to nothing.
 */
const CLOCK_MS = 8;

/** a player beat within this is alive */
export const ALIVE_MS = 2000;
/** no word from the host this long: suspect it */
export const SILENCE_MS = 1500;
/**
 * before the host's first word: it may still be building its world (a big
 * map, a phone), so wait longer. A host that crashed meanwhile drops off the
 * mesh, and that is suspected at once.
 */
export const START_SILENCE_MS = 10_000;
/** a claimant waits this long for the others' turns */
export const COLLECT_MS = 400;
/** after someone claims: wait this long for their `lead` before looking again */
export const LEAD_WAIT_MS = 1000;
/** the host said goodbye: its handoff may still be on its way (another channel) */
export const BYE_WAIT_MS = 150;

/** players report their round trips to the runner this often (#190) */
export const LINKS_MS = 2000;
/** the runner publishes a new ranking at most this often (#190) */
export const RANK_MS = 10_000;
/** how far into a match the runner looks for a better-placed player (#190) */
export const SETTLE_MS = 3000;
/** …and how long it waits for everyone's measurements before deciding without them */
export const SETTLE_WAIT_MS = 8000;
/** …and how long after that it keeps trying to hand over, when the one it chose can't take it yet (hidden, syncing) */
export const SETTLE_TRY_MS = 30_000;
/**
 * The host silent this long, page not hidden (a frozen tab, a link the
 * transport never reports down): whoever runs the match becomes host (#190)
 */
export const OWNER_QUIET_MS = 5000;
/** a better runner must beat the current one's worst round trip by this much, ms, and by RANK_GAIN of it (#190) */
export const RANK_MARGIN_MS = 20;
export const RANK_GAIN = 0.15;
/** scores within about this of each other count as a tie, ms (#190): measurement noise never reorders the ranking */
const RANK_STEP_MS = 25;
/** a desync report with no agreed world to resync from */
const NO_WORLD = 'no world to compare with came in';
/** what an unmeasured link counts as, ms (#190) */
const UNKNOWN_MS = 1000;
/** what a phone, and a link on mobile data, add to a runner's score, ms (#190) */
const MOBILE_MS = 60;
const CELL_MS = 60;
/** round-trip samples kept per link (#190) */
const SAMPLES = 8;

/**
 * Who takes over first. With a published ranking (#190): its order, seats
 * it doesn't name after; without: desktop before phone, then seat order.
 */
export function rankOf(peers: readonly MatchPeer[], order?: readonly number[] | null): string[] {
  const at = (s: number) => {
    const i = order ? order.indexOf(s) : -1;
    return i < 0 ? Infinity : i;
  };
  return [...peers].sort((a, b) => at(a.seat) - at(b.seat) || Number(a.mobile) - Number(b.mobile) || a.seat - b.seat).map((p) => p.peer);
}

/** A round-trip table between seats (#190): undefined where nobody measured. */
export type RttOf = (a: number, b: number) => number | undefined;

/** A would-be runner's score (#190), ms: the worst round trip it would give anyone, plus what a phone or mobile data costs. Lower is better. */
export function runnerScore(p: MatchPeer, peers: readonly MatchPeer[], rtt: RttOf): number {
  let worst = 0;
  for (const q of peers) if (q.seat !== p.seat) worst = Math.max(worst, rtt(p.seat, q.seat) ?? UNKNOWN_MS);
  return worst + (p.mobile ? MOBILE_MS : 0) + (p.cell ? CELL_MS : 0);
}

/**
 * The ranking by measured links (#190): seats, best runner first. It starts
 * from `prev` (then the default order), and a player moves ahead of one
 * before it only when it scores at least RANK_STEP_MS better, so
 * near-equal links never reorder it. A `pin` goes first.
 */
export function rankByLinks(peers: readonly MatchPeer[], rtt: RttOf, prev: readonly number[] | null, pin?: number): number[] {
  const order = rankOf(peers, prev).map((peer) => peers.find((p) => p.peer === peer)!.seat);
  const score = new Map(peers.map((p) => [p.seat, runnerScore(p, peers, rtt)]));
  // a bubble sort that swaps only on a clear gain: each swap removes an inversion of the scores, so it ends
  for (let swapped = true; swapped; ) {
    swapped = false;
    for (let i = 0; i + 1 < order.length; i++) {
      if (order[i] === pin) continue;
      const a = order[i], b = order[i + 1];
      if (b === pin || score.get(a)! - score.get(b)! >= RANK_STEP_MS) {
        order[i] = b;
        order[i + 1] = a;
        swapped = true;
      }
    }
  }
  return order;
}

/** Whether `to` would run the match enough better than `from` to move it (#190). */
export function worthMoving(from: number, to: number, margin = RANK_MARGIN_MS, gain = RANK_GAIN): boolean {
  return from - to >= Math.max(margin, from * gain);
}

/**
 * Epoch for a takeover: the round, then the claimant's seat (#190), so two
 * claimants never share one, even when they ranked each other differently;
 * the highest epoch always wins.
 */
export function epochFor(round: number, seat: number): number {
  return round * 8 + (7 - Math.min(7, seat));
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
  /** how long the host may say nothing before its first word: long at a match's start, normal when rejoining one under way */
  private readonly firstWordMs: number;
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
  /** we handed hosting on and are about to leave: no more say in who hosts */
  private leaving = false;

  // ---- roles and links (#190)
  /** the match's host: pause, restart, end, the room */
  private owner: number;
  /** the seat the host chose to run the match (absent: Auto) */
  private readonly pin: number | undefined;
  /** the latest published ranking: seats, best runner first (null: none yet) */
  private rank: number[] | null = null;
  /** each peer's last beat stamp, and when it came */
  private stamps = new Map<string, { t: number; at: number }>();
  /** round-trip samples to each peer, ms, newest last */
  private samples = new Map<string, number[]>();
  private linksAt = -Infinity;
  /** runner: each seat's reported round trips to the others*/
  private reports = new Map<number, { at: number; rtt: Map<number, number> }>();
  private rankAt = -Infinity;
  /** runner: the last ranking we put in the log */
  private rankSent: number[] | null = null;
  /** runner, at the start: when to look for a better-placed runner (-1: done), and the latest we wait for everyone's links */
  private settleAt = -1;
  private settleBy = -1;
  private settleEnd = -1;
  /** runner: the host asked for a resync before the desync report was ready (#190) */
  private resyncAsked = false;
  /** host: the match's host by peer, until the list of players has them (#190) */
  private ownerPeer: string | null = null;
  /** host: rejoiners' new connections, told to whoever runs the match until they're in (#190) */
  private rebinds = new Map<number, string>();
  /** runner: rejoiners who asked for a snapshot before the host told us their new connection (#190) */
  private snapWait = new Set<string>();

  // ---- desyncs (#165)
  private readonly snaps: SnapAssembler;
  private reported = new Map<number, [number, number][]>();
  /** `seats`: whose worlds we wait for; `derive`: no hashes came with it (a halt we inherited), so read them off the worlds */
  private collect: { tick: number; seats: number[]; hashes: Map<number, number>; odd: number[]; derive: boolean; got: Map<number, Uint8Array>; until: number } | null = null;
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
    resume?: boolean;
    owner?: number;
    ownerPeer?: string;
    pin?: number;
  }) {
    this.remote = o.remote;
    const ownerPeer = o.ownerPeer ?? o.leader;
    this.owner = o.owner ?? (ownerPeer === o.remote?.self ? o.seat : (o.peers.find((p) => p.peer === ownerPeer)?.seat ?? -1));
    // not in the list yet: found once it is
    if (this.owner < 0 && o.ownerPeer) this.ownerPeer = o.ownerPeer;
    this.pin = o.pin;
    this.firstWordMs = o.resume ? SILENCE_MS : START_SILENCE_MS;
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
      else if (c.k === 'desync') {
        // a halt from the host before us reaching us now that we host: we need its report
        if (this.leading_ && this.collect?.tick !== c.tick && this.report?.tick !== c.tick) this.recollect(c.tick);
        this.events.onDesync?.(c.tick);
      } else if (c.k === 'rank') this.rank = c.seats.slice();
      else if (c.k === 'owner') this.setOwner(c.seat);
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
      session: (port) =>
        new NetSession({ setup: cfg.setup, seat: cfg.seat, transport: port, host: cfg.leader, clock, opts: { ...cfg.net, ...(cfg.leader === remote.self ? { fixedBuffer: HOST_BUFFER } : {}) }, resume: cfg.resume }),
      remote,
      seat: cfg.seat,
      peers: cfg.peers,
      leader: cfg.leader,
      clock,
      cleanup: () => remote.close(),
      heartbeat: cfg.heartbeat !== false,
      seq: { ...(cfg.botMs ? { botMs: cfg.botMs } : {}), ...cfg.seq },
      gzip: cfg.gzip,
      resume: cfg.resume,
      owner: cfg.owner,
      ownerPeer: cfg.ownerPeer,
      pin: cfg.runnerSeat,
    });
    if (cfg.leader === remote.self) {
      // a few seconds in, once links are measured: is someone better placed to run it? (#190)
      if (!cfg.resume) {
        m.settleFrom(m.started);
      }
      m.leading_ = true;
      m.makeSeq = () =>
        new Sequencer({
          limits: limitsOf(m.session.world),
          seats: cfg.peers.map((p) => ({ seat: p.seat, team: p.team, peer: p.peer === remote.self ? HOST_SELF : p.peer })),
          clock,
          send: (peer, msg) => m.seqSend(peer, msg),
          // only the match's host stops it for everyone; guests' menus leave it running
          opts: { pausers: [m.owner], ...m.seqOpts },
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
    const peers = go.seats.map((s) => ({ seat: s.seat, team: s.team, peer: s.peer ?? remote.self, mobile: s.mobile, ...(s.cell ? { cell: true } : {}) }));
    return NetMatch.create(remote, { setup: go.setup, seat: go.hostSeat, peers, leader: remote.self, botMs: go.botMs, owner: go.hostSeat, runnerSeat: go.runnerSeat, ...o });
  }

  /** A guest's side (#162). `resume`: rejoining a match under way (#164). `peers`: every human seat, to take over hosting (#166). */
  static guest(
    t: Transport,
    setup: MatchSetup,
    seat: number,
    host: string,
    o: { clock?: () => number; net?: Partial<NetSessionOptions>; resume?: boolean; peers?: MatchPeer[]; botMs?: number; heartbeat?: boolean; gzip?: boolean; owner?: number; ownerPeer?: string; runnerSeat?: number } = {},
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

  /**
   * We're the match's host (#190): ours are pause, restart, end and the
   * room, wherever the sequencer runs. A `?lag=` match is always ours.
   */
  get host(): boolean {
    return this.remote === null || this.owner === this.mySeat;
  }

  /** We run the sequencer now (#166; a `?lag=` match always does). */
  get runner(): boolean {
    return this.leading_ || this.remote === null;
  }

  /** who runs the match now (#190): a player rejoining it talks to them */
  get runnerPeer(): string {
    return this.leaderId;
  }

  /** the match's host's seat (#190) */
  get ownerSeat(): number {
    return this.remote === null ? this.mySeat : this.owner;
  }

  /** Who'd run the match, best first (#190): the published ranking, as seats. */
  get ranking(): number[] {
    return rankOf(this.peers, this.rank).map((peer) => this.peers.find((p) => p.peer === peer)!.seat);
  }

  /** Our measured round trip to each other seat's player, ms (#190). */
  links(): Map<number, number> {
    const out = new Map<number, number>();
    for (const p of this.peers) {
      if (p.peer === this.self) continue;
      const ms = this.rttTo(p.peer);
      if (ms !== undefined) out.set(p.seat, ms);
    }
    return out;
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
    return rankOf(this.peers, this.rank).find((p) => p !== this.self && !this.gone.has(p) && this.canHost(p, now));
  }

  /** The seats' players changed (a rejoin under a new peer id, #164): keep the election's list current. */
  updatePeers(peers: MatchPeer[]): void {
    this.peers = peers;
    const seat = this.ownerPeer ? this.seatOf(this.ownerPeer) : -1;
    if (seat >= 0) {
      this.ownerPeer = null;
      this.setOwner(seat);
    }
  }

  /** Our page was hidden or shown (#164): our seat goes away, and we can't help elect a host meanwhile. */
  setHidden(on: boolean): void {
    this.hidden = on;
    this.session.setHidden(on);
    if (on && this.remote) this.beatNow(this.clock());
  }

  /**
   * Host: a player came back on a new connection (a reload, #164): their
   * seat now answers to `peer`. When someone else runs the match, they're
   * told (#190).
   */
  rebind(seat: number, peer: string): void {
    this.peers = this.peers.map((p) => (p.seat === seat ? { ...p, peer } : p));
    if (this.leading_ || !this.remote) {
      if (!this.seq_ && this.makeSeq) this.tick();
      if (this.seq_?.seatOfPeer(peer) !== seat) {
        this.seq_?.bindPeer(seat, peer);
        this.restate();
      }
      // their snapshot request may have beaten the host's word here (another channel)
      if (this.snapWait.delete(peer)) this.serveSnap(peer, 0);
    } else if (this.host) {
      // said again until they're in: whoever runs the match may go before it hears (they reloaded, or handed over)
      this.rebinds.set(seat, peer);
      this.remote.send(this.leaderId, encodeMsg({ k: 'rebind', seat, peer }));
    }
  }

  /**
   * Runner (#190): who hosts and the ranking, in the log again, for a
   * player whose world came from a snapshot taken after they were (a
   * rejoin, a fork healed): they'd never see them otherwise.
   */
  private restate(): void {
    const seq = this.seq_;
    if (!seq) return;
    if (this.rank) seq.addCtrl({ k: 'rank', seats: this.rank.slice() });
    if (this.owner >= 0) seq.addCtrl({ k: 'owner', seat: this.owner });
  }

  /**
   * Host, after a desync (#165): resync everyone from the majority's world.
   * True when it's done here; false when it's asked of whoever runs the
   * match (#190; the card goes once turns flow again), or can't be done.
   */
  requestResync(): boolean {
    if (this.leading_ || !this.remote) return this.resync();
    if (this.host) this.remote.send(this.leaderId, encodeMsg({ k: 'ask', what: 'resync' }));
    return false;
  }

  /**
   * Runner, leaving on purpose (#166): hand the sequencer to the first
   * player in rank who is still here, with every turn it lacks. False when
   * there's nobody to hand it to. `to` (#190): hand it to this player, who
   * runs the match better, and stay on as a player (`stay`).
   */
  handOff(o: { to?: string; stay?: boolean } = {}): boolean {
    const seq = this.seq_;
    const remote = this.remote;
    if (!this.leading_ || !seq || !remote) return false;
    const now = this.clock();
    const succ = o.to ?? this.successor(now);
    const seat = succ ? this.seatOf(succ) : -1;
    if (!succ || seat < 0 || succ === this.self || this.gone.has(succ) || !this.canHost(succ, now)) return false;
    seq.sendRange(succ, seq.ackOf(succ) + 1, seq.closed);
    const epoch = epochFor(Math.floor(this.epoch / 8) + 1, seat);
    const state = JSON.stringify(seq.exportState());
    // no longer ours before it goes out: whatever answers it finds us a follower
    this.stepDown();
    // our epoch stays: if the successor has to claim instead, its claim is above ours, and we answer it with our turns
    this.leaderId = succ;
    this.heardAt.set(succ, this.clock());
    // on our way out: never suspect the successor in the moments before we go
    if (!o.stay) this.leaving = true;
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
    // on the host's behalf: the host may be someone else (#190), and only the host's seat may resume
    seq.resume();
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
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${CLOCK_MS});`], { type: 'text/javascript' }));
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
    if (!seq || tick !== 0) return;
    // a rejoiner the host hasn't told us about yet (#190): served once it does
    if (seat < 0) return void (this.remote && this.snapWait.add(peer));
    this.restate();
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

  /**
   * Halted by a desync the host before us found (#166): its report didn't
   * come with hosting, so look again from everyone's kept worlds at that
   * tick; then we can resync or resume from here.
   */
  private recollect(tick: number): void {
    const seats = this.peers.filter((p) => p.peer === this.self || !this.gone.has(p.peer)).map((p) => p.seat);
    this.startCollect(tick, new Map(), [], seats);
  }

  private startCollect(tick: number, hashes: Map<number, number>, odd: number[], seats = [...hashes.keys()]): void {
    const c = { tick, seats, hashes, odd, derive: !hashes.size, got: new Map<number, Uint8Array>(), until: this.clock() + 5000 };
    this.collect = c;
    const own = this.session.keptSnap(tick);
    if (own) c.got.set(this.mySeat, own);
    for (const s of seats) {
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
    if (!c.seats.every((s) => c.got.has(s)) && this.clock() < c.until) return;
    this.collect = null;
    if (c.derive) {
      // each world's hash is the hash of its bytes; the odd ones out are those outside the largest group
      for (const [s, b] of c.got) c.hashes.set(s, hashBytes(b));
      c.odd.push(...oddOnes(c.hashes));
    }
    const report = analyzeDesync(c.tick, c.hashes, c.odd, c.got, this.mySeat);
    this.report = report;
    this.events.onDesyncReport?.(report);
    const text = report.first ?? (report.ref < 0 ? NO_WORLD : 'no field differs (only the hash)');
    for (const s of c.seats) {
      const peer = this.seq_?.peerOfSeat(s);
      if (peer && peer !== HOST_SELF) this.seqSend(peer, { k: 'desync', tick: c.tick, text });
    }
    // the host asked while we were still collecting (#190)
    if (this.resyncAsked) {
      const host = this.peers.find((p) => p.seat === this.owner)?.peer;
      if (host) this.askedResync(host);
    }
  }

  /**
   * Runner: the host asked for a resync (#190). Done now if we can; if the
   * report is still coming, once it's in; if there's no agreed world, the
   * host is told why (on its card), and can resume instead.
   */
  private askedResync(host: string): void {
    this.resyncAsked = false;
    if (this.resync()) return;
    const r = this.report;
    if (!r && this.collect) this.resyncAsked = true;
    // no agreed world: say so. No report and nothing halted: a second ask after the first one worked
    else if (host !== this.self && (r || this.session.halted >= 0)) {
      const tick = r?.tick ?? this.session.halted;
      this.remote?.send(host, encodeMsg({ k: 'desync', tick, text: r ? NO_WORLD : 'nothing to resync from' }));
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

  /** A beat to every other player, each with its own timestamp echo (#190). */
  private beatNow(now: number): void {
    this.beatAt = now;
    const t = Math.round(now) & 0xffff;
    for (const p of this.others()) {
      const st = this.stamps.get(p);
      const m: Msg = { k: 'beat', epoch: this.epoch, ok: !this.suspect, hidden: this.hidden, syncing: this.session.syncing, t, echo: st ? st.t : -1, held: st ? now - st.at : 0 };
      this.remote?.send(p, encodeMsg(m));
    }
  }

  /** Our round trip to `peer` lately, ms (#190): the median of the last few beats' echoes. */
  private rttTo(peer: string): number | undefined {
    const s = this.samples.get(peer);
    if (!s?.length) return undefined;
    const sorted = [...s].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  private seatOf(peer: string): number {
    return this.peers.find((p) => p.peer === peer)?.seat ?? -1;
  }

  /** The round trip between two seats (#190): the larger of what either end measured lately. */
  private rttBetween(a: number, b: number, now: number): number | undefined {
    const one = (from: number, to: number): number | undefined => {
      if (from === this.mySeat) {
        const peer = this.peers.find((p) => p.seat === to)?.peer;
        return peer ? this.rttTo(peer) : undefined;
      }
      const r = this.reports.get(from);
      return r && now - r.at <= LINKS_MS * 3 ? r.rtt.get(to) : undefined;
    };
    const x = one(a, b), y = one(b, a);
    return x === undefined ? y : y === undefined ? x : Math.max(x, y);
  }

  /** The players still here (us included), ranked by measured links (#190). */
  private measuredRank(now: number): { order: number[]; live: MatchPeer[] } {
    const live = this.peers.filter((p) => p.peer === this.self || !this.gone.has(p.peer));
    const order = rankByLinks(live, (a, b) => this.rttBetween(a, b, now), this.rank, this.pin);
    // the ones gone keep their place after, in case they're back
    for (const s of this.rank ?? []) if (!order.includes(s)) order.push(s);
    return { order, live };
  }

  /**
   * Runner (#190): take over as host when the host left; publish the
   * ranking when it changes (looked at every RANK_MS); and, a few seconds
   * after taking over, hand the sequencer to a better-placed player.
   */
  private runnerChores(now: number): void {
    const seq = this.seq_;
    if (!seq) return;
    if (this.owner !== this.mySeat && this.hostLeft(now)) {
      // ours at once (a halted or paused match closes no turns: someone must be able to resume it); the rest hear it in the log
      seq.addCtrl({ k: 'owner', seat: this.mySeat });
      this.setOwner(this.mySeat);
    }
    if (now - this.rankAt >= RANK_MS) this.publishRank(now);
    if (this.settleAt >= 0 && now >= this.settleAt) this.settle(now);
  }

  /**
   * The host is gone (#190): its connection dropped, or it has been silent
   * a while with its page shown (frozen, or a link the transport never
   * reports down). A hidden host stays host.
   */
  private hostLeft(now: number): boolean {
    const host = this.peers.find((p) => p.seat === this.owner);
    if (!host) return true;
    if (host.peer === this.self) return false;
    if (this.gone.has(host.peer)) return now - (this.goneAt.get(host.peer) ?? now) >= BYE_WAIT_MS;
    const b = this.beats.get(host.peer);
    return !b?.hidden && now - (b?.at ?? this.started) >= OWNER_QUIET_MS;
  }

  /** Rank the players by their links and publish it if it changed (#190). */
  private publishRank(now: number): { order: number[]; live: MatchPeer[] } {
    this.rankAt = now;
    const r = this.measuredRank(now);
    // against the last one out, not yet back in a closed turn; none while no turns close (paused, halted)
    const last = this.rankSent ?? this.rank;
    const still = this.session.paused || this.session.halted >= 0;
    if (!still && (!last || r.order.length !== last.length || r.order.some((s, i) => s !== last[i]))) {
      this.rankSent = r.order;
      this.seq_?.addCtrl({ k: 'rank', seats: r.order });
    }
    return r;
  }

  /** Look for a better-placed runner from `at` on: a match's start, or a takeover (#190). */
  private settleFrom(at: number): void {
    this.settleAt = at + SETTLE_MS;
    this.settleBy = at + SETTLE_WAIT_MS;
    this.settleEnd = this.settleBy + SETTLE_TRY_MS;
  }

  /**
   * Runner (#190): the host's choice runs the match, if they're here; else
   * the best-placed player, if it's worth the move. Once everyone's links
   * are in (or we've waited long enough); tried again while the one chosen
   * can't take it yet, until SETTLE_TRY_MS.
   */
  private settle(now: number): void {
    this.settleAt = now + BEAT_MS;
    if (now >= this.settleEnd) return void (this.settleAt = -1);
    if (this.session.halted >= 0) return;
    const others = this.peers.filter((p) => p.peer !== this.self && !this.gone.has(p.peer));
    const measured = others.every((p) => this.rttBetween(this.mySeat, p.seat, now) !== undefined && this.reports.has(p.seat));
    if (!measured && now < this.settleBy) return;
    const { order, live } = this.publishRank(now);
    const pinned = this.pin !== undefined ? live.find((p) => p.seat === this.pin) : undefined;
    let to: MatchPeer | undefined;
    if (pinned) to = pinned.peer === this.self ? undefined : pinned;
    else {
      const best = live.find((p) => p.seat === order[0]);
      const me = live.find((p) => p.peer === this.self)!;
      const rtt: RttOf = (a, b) => this.rttBetween(a, b, now);
      if (best && best.peer !== this.self && worthMoving(runnerScore(me, live, rtt), runnerScore(best, live, rtt))) to = best;
    }
    // nobody better: done. Else done once it's handed over; until then, again shortly
    if (!to || this.handOff({ to: to.peer, stay: true })) this.settleAt = -1;
  }

  /** The match has a new host (#190): only they may pause now. */
  private setOwner(seat: number): void {
    if (seat === this.owner) return;
    this.owner = seat;
    this.seq_?.setPausers([seat]);
    const peer = this.peers.find((p) => p.seat === seat)?.peer ?? '';
    this.events.onOwner?.(seat, peer);
  }

  private elect(now: number): void {
    if (!this.peers.length || this.leaving) return;
    this.epoch = Math.max(this.epoch, this.session.currentEpoch);
    if (now - this.beatAt >= BEAT_MS) this.beatNow(now);
    if (this.leading_) return this.runnerChores(now);
    // our round trips, for whoever runs the match to rank us by (#190)
    if (now - this.linksAt >= LINKS_MS && !this.gone.has(this.leaderId)) {
      this.linksAt = now;
      const rtt = [...this.links()];
      if (rtt.length) this.remote?.send(this.leaderId, encodeMsg({ k: 'links', rtt }));
      // a rejoiner beating with a world is in; until then, whoever runs the match hears again
      for (const [seat, peer] of this.rebinds) {
        const b = this.beats.get(peer);
        if (b && !b.syncing) this.rebinds.delete(seat);
        else this.remote?.send(this.leaderId, encodeMsg({ k: 'rebind', seat, peer }));
      }
    }
    if (this.candidate) {
      if (now < this.candidate.until) return;
      // a snapshot we were waiting for since claiming means our world can't be hosted from: give way
      if (this.session.syncing) this.candidate = null;
      else this.promote(this.candidate.epoch);
      return;
    }
    if (this.awaiting) {
      if (now < this.awaiting.until) return;
      this.awaiting = null; // whoever claimed never led: look again
    }
    const leader = this.leaderId;
    const heard = this.heardAt.get(leader);
    const quiet = now - (heard ?? this.started);
    const left = this.gone.has(leader) && now - (this.goneAt.get(leader) ?? now) >= BYE_WAIT_MS;
    // a player waiting for a snapshot still says whether it hears the host: it votes, but can't lead
    const suspect = !this.hidden && (left || this.linkLost.has(leader) || quiet > (heard === undefined ? this.firstWordMs : SILENCE_MS));
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
    const rank = rankOf(this.peers, this.rank);
    const first = rank.find((p) => voters.includes(p) && (p === this.self ? !this.session.syncing : !this.beats.get(p)?.syncing));
    if (first !== this.self) return;
    const epoch = epochFor(Math.floor(this.epoch / 8) + 1, this.mySeat);
    this.candidate = { epoch, until: now + COLLECT_MS };
    this.broadcast({ k: 'claim', epoch, held: this.session.heldTick });
  }

  private mesh(peer: string, m: Msg, now: number): void {
    switch (m.k) {
      case 'beat': {
        this.beats.set(peer, { at: now, epoch: m.epoch, ok: m.ok, hidden: m.hidden, syncing: m.syncing });
        this.stamps.set(peer, { t: m.t, at: now });
        // our stamp, back: the round trip, less how long they held it (#190)
        if (m.echo >= 0) {
          const ms = ((Math.round(now) - m.echo) & 0xffff) - m.held;
          if (ms >= 0 && ms < 10_000) {
            const s = this.samples.get(peer) ?? [];
            s.push(ms);
            if (s.length > SAMPLES) s.shift();
            this.samples.set(peer, s);
          }
        }
        // a player still on an old epoch (back from a partition): tell it who hosts now
        if (this.leading_ && m.epoch < this.epoch) this.remote?.send(peer, encodeMsg({ k: 'lead', epoch: this.epoch, next: this.forkAt }));
        return;
      }
      case 'links': {
        const seat = this.seatOf(peer);
        if (this.leading_ && seat >= 0) this.reports.set(seat, { at: now, rtt: new Map(m.rtt) });
        return;
      }
      case 'ask':
        if (this.leading_ && this.seatOf(peer) === this.owner && m.what === 'resync') this.askedResync(peer);
        return;
      case 'rebind':
        if (this.leading_ && this.seatOf(peer) === this.owner && m.seat !== this.owner) this.rebind(m.seat, m.peer);
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
        if (this.leading_) {
          this.stepDown();
          // the claimant is the one to hear from now: if it never leads, it's the one suspected, not us
          this.leaderId = peer;
          this.heardAt.set(peer, now);
        }
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
        // no world to host from (rejoining, or resyncing after a fork): let it lapse; once the old host
        // is gone the others elect someone who has one
        if (this.session.syncing) return;
        // every turn it closed came first, on the same channel; if not, collect them the long way
        if (this.session.heldTick !== state.next - 1) {
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
      : rebuildState({ epoch, next, seats, history: hist, opts: this.seqOpts, lat: this.session.lat, pauseMsLeft: this.pauseMsLeft() });
    const seq = new Sequencer({
      limits: limitsOf(this.session.world),
      seats: [],
      clock: this.clock,
      send: (peer, msg) => this.seqSend(peer, msg),
      opts: { ...this.seqOpts, pausers: [this.owner] },
      resume: { state, history: hist },
      epoch,
    });
    this.candidate = null;
    this.awaiting = null;
    // our own sequencer starts from the current list of players
    this.rebinds.clear();
    this.leading_ = true;
    this.leaderId = this.self;
    this.rankAt = this.clock();
    this.rankSent = null;
    // taken over by election (#190): whoever claimed first may not be the best placed (two claimed at once, or
    // rankings differed): look again a few seconds in, as at a match's start. Handed over: chosen already
    if (handed) this.settleAt = -1;
    else this.settleFrom(this.clock());
    this.epoch = epoch;
    this.forkAt = next;
    this.adoptSeq(seq);
    this.out.clear();
    // the old host's seat: away now, then the room's bot policy; unless it handed over and plays on (#190).
    // One that handed over on its way out drops off the mesh, and that's when its seat goes away
    if (old !== this.self && (!handed || this.gone.has(old))) seq.peerLost(old);
    this.session.follow(this.self, epoch, next);
    // our own turns come in-process now: no network jitter to buffer against (#198)
    this.session.setFixedBuffer(HOST_BUFFER);
    this.broadcast({ k: 'lead', epoch, next });
    if (this.heartbeat) this.startHeartbeat();
    this.suspect = false;
    this.setStalled(false);
    if (this.session.halted >= 0) this.recollect(this.session.halted);
    this.events.onLeader?.(this.mySeat, this.self);
  }

  /**
   * What's left of each seat's pause allowance, as the old host last said
   * while it counted down (#166). The pause still running (if any) has spent
   * more since.
   */
  private pauseMsLeft(): Map<number, number> {
    const resumeMs = { ...SEQUENCER_DEFAULTS, ...this.seqOpts }.resumeMs;
    const now = this.clock();
    const left = new Map<number, number>();
    for (const [seat, s] of this.session.pauseSeen) {
      const spent = seat === this.session.pausedSeat ? now - s.at : 0;
      left.set(seat, Math.max(0, s.auto - resumeMs - spent));
    }
    return left;
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
    // turns come over the network again: measure the buffer from their jitter
    this.session.setFixedBuffer(null);
    this.collect = null;
    this.resyncAsked = false;
    this.snapWait.clear();
    this.beat?.terminate();
    this.beat = null;
  }
}

