import { limitsOf } from '../sim/sanitize';
import type { MatchSetup } from '../sim/setup';
import { serializeWorld } from '../sim/snapshot';
import { encodeMsg } from './codec';
import { FakeNetwork, VirtualClock, type LinkSpec } from './fakeTransport';
import type { HostGo } from './lobby';
import { NetSession, type NetSessionOptions } from './netSession';
import type { Ctrl } from './protocol';
import type { Sequencer, SequencerOptions } from './sequencer';
import { canGzip, chunkSnap, packSnap, settle } from './snapwire';
import { HOST_SELF, hostSequencer, splitHost, type Transport } from './transport';

/**
 * One networked match from this peer's side (#162): the local NetSession,
 * and on the host the Sequencer too. The app calls `update()` every frame,
 * before the game view steps; the host also runs the sequencer off a worker
 * heartbeat, so a hidden host tab keeps closing turns (browsers throttle a
 * hidden tab's own timers to 1 Hz, but not a worker's).
 */

export interface NetMatchEvents {
  /** a seat went away, was taken by a bot, or came back */
  onSeat?: (seat: number, state: 'human' | 'away' | 'bot') => void;
  /** the host paused or resumed */
  onPause?: (paused: boolean) => void;
  /**
   * guests: the host is gone (Phase 2 ends the match; #166 migrates it):
   * it left, or its link dropped and didn't come back in time
   */
  onHostLost?: (why: 'left' | 'lost') => void;
  /** guests: the link to the host dropped (the match waits for it), or came back */
  onHostLink?: (state: 'lost' | 'back') => void;
  /** host: clients disagree about the world at `tick` */
  onDesync?: (tick: number) => void;
}

export class NetMatch {
  readonly session: NetSession;
  readonly host: boolean;
  events: NetMatchEvents = {};
  private seq_: Sequencer | null = null;
  private beat: Worker | null = null;
  private readonly makeSeq: (() => Sequencer) | null;
  private readonly heartbeat: boolean;
  private readonly clockSync: (() => void) | null;
  private readonly cleanup: () => void;

  /**
   * The host's sequencer is made on the first `update()` or heartbeat, not
   * here: its turn clock starts then, once the game view is built (the
   * heartbeat's first message can't run before the code building it
   * returns), so the first turns don't go out in a burst that would swell
   * everyone's jitter buffer. The heartbeat starts now, so a host that
   * switches tabs right after Start (no frames) still starts the match.
   */
  private constructor(session: NetSession, makeSeq: (() => Sequencer) | null, cleanup: () => void, o: { clockSync?: () => void; heartbeat?: boolean } = {}) {
    this.session = session;
    this.makeSeq = makeSeq;
    this.host = makeSeq !== null;
    this.cleanup = cleanup;
    this.clockSync = o.clockSync ?? null;
    this.heartbeat = o.heartbeat ?? false;
    if (this.heartbeat) this.startHeartbeat();
    session.onCtrl = (_t, c: Ctrl) => {
      if (c.k === 'seat') this.events.onSeat?.(c.seat, c.state);
      else this.events.onPause?.(c.k === 'pause');
    };
  }

  /** Host: a player came back on a new connection (a reload, #164): their seat now answers to `peer`. */
  rebind(seat: number, peer: string): void {
    if (!this.seq_ && this.makeSeq) this.tick();
    this.seq_?.bindPeer(seat, peer);
  }

  /** the host's sequencer, once the match has started */
  get seq(): Sequencer | null {
    return this.seq_;
  }

  /**
   * The host's side, once every guest is ready: the sequencer over `remote`
   * (the match view of the room) plus the host's own client in-process.
   */
  static host(
    remote: Transport,
    go: HostGo,
    o: { clock?: () => number; seq?: Partial<SequencerOptions>; net?: Partial<NetSessionOptions>; heartbeat?: boolean; gzip?: boolean } = {},
  ): NetMatch {
    const clock = o.clock ?? (() => performance.now());
    const gzip = o.gzip ?? canGzip;
    const { seq: seqT, client } = splitHost(remote);
    const session = new NetSession({ setup: go.setup, seat: go.hostSeat, transport: client, host: remote.self, clock, opts: o.net });
    let seqRef: Sequencer | null = null;
    /**
     * A rejoining player's snapshot (#164): the host's own world, which every
     * client agrees on up to its tick, then the closed turns after it.
     */
    const serveSnap = (peer: string, tick: number) => {
      const seq = seqRef;
      const seat = seq?.seatOfPeer(peer) ?? -1;
      if (!seq || seat < 0 || tick !== 0) return;
      const w = session.world;
      const meta = { tick: w.tick, pausedBy: session.pausedSeat, seqBase: seq.seatSeq(seat) };
      settle(
        packSnap(meta, serializeWorld(w), gzip),
        (packed) => {
          for (const c of chunkSnap(meta.tick, packed)) seqT.send(peer, encodeMsg(c));
          seq.sendRange(peer, meta.tick + 1, seq.closed);
        },
        () => undefined,
      );
    };
    const makeSeq = () =>
      (seqRef = hostSequencer(
        seqT,
        {
          limits: limitsOf(session.world),
          seats: go.seats.map((s) => ({ seat: s.seat, team: s.team, peer: s.peer ?? HOST_SELF })),
          clock,
          // only the host stops the match for everyone; guests' menus leave it running
          opts: { pausers: [go.hostSeat], botMs: go.botMs, ...o.seq },
        },
        (peer, m) => {
          if (m.k !== 'snapreq') return false;
          serveSnap(peer, m.tick);
          return true;
        },
      ));
    return new NetMatch(
      session,
      makeSeq,
      () => {
        seqT.close();
        remote.close();
      },
      { heartbeat: o.heartbeat !== false },
    );
  }

  /** A guest's side: its NetSession, talking to the host's sequencer. `resume`: rejoining a match under way (#164). */
  static guest(t: Transport, setup: MatchSetup, seat: number, host: string, o: { clock?: () => number; net?: Partial<NetSessionOptions>; resume?: boolean } = {}): NetMatch {
    const session = new NetSession({ setup, seat, transport: t, host, clock: o.clock ?? (() => performance.now()), opts: o.net, resume: o.resume });
    const m = new NetMatch(session, null, () => {
      t.onMessage = null;
      t.close();
    });
    const prev = t.onPeer;
    let dropped = false;
    t.onPeer = (peer, up) => {
      prev?.(peer, up);
      if (!up && peer === host) m.events.onHostLost?.(dropped ? 'lost' : 'left');
    };
    const prevLink = t.onLink;
    t.onLink = (peer, state) => {
      prevLink?.(peer, state);
      if (peer !== host) return;
      dropped = state !== 'back';
      if (state !== 'gone') m.events.onHostLink?.(state);
    };
    return m;
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
    const session = new NetSession({ setup, seat, transport: net.transport('me'), host: 'host', clock: () => clock.now });
    // virtual time starts with the first frame, like the sequencer
    let t0 = -1;
    const clockSync = () => {
      if (t0 < 0) t0 = performance.now();
      clock.advanceTo(performance.now() - t0);
    };
    const makeSeq = () => hostSequencer(hostT, { limits: limitsOf(session.world), seats: [{ seat, team: seat, peer: 'me' }], clock: () => clock.now });
    return new NetMatch(session, makeSeq, () => undefined, { clockSync });
  }

  /** every frame, before the game view steps */
  update(): void {
    this.clockSync?.();
    this.tick();
  }

  /** close any turns that are due (making the sequencer first, if this is the start) */
  private tick(): void {
    if (!this.seq_ && this.makeSeq) {
      this.seq_ = this.makeSeq();
      this.seq_.onDesync = (t) => this.events.onDesync?.(t);
    }
    this.seq_?.update();
    this.markSpectators();
  }

  /** seats already marked spectating */
  private out = new Set<number>();

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

  private startHeartbeat(): void {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return;
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }));
      this.beat = new Worker(url);
      URL.revokeObjectURL(url);
      this.beat.onmessage = () => this.tick();
    } catch {
      this.beat = null; // no workers here: the frame loop alone drives it
    }
  }

  close(): void {
    this.beat?.terminate();
    this.beat = null;
    this.cleanup();
  }
}
