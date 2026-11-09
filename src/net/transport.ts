import { decodeMsg, encodeMsg, msgKind } from './codec';
import type { Msg, MsgKind } from './protocol';
import { Sequencer, type SequencerConfig } from './sequencer';

/**
 * Moves bytes between peers (#152's `Transport` seam). Implementations:
 * `LoopbackHub` (in-process, this file), `FakeNetwork` (virtual latency and
 * loss, #160), and later WebRTC (#162) or a WebSocket relay (#167).
 *
 * v1 has one reliable, ordered channel. Messages are whole: a transport never
 * splits or merges them.
 */
export interface Transport {
  /** this peer's id */
  readonly self: string;
  send(peer: string, bytes: Uint8Array): void;
  /** a whole message from a peer */
  onMessage: ((peer: string, bytes: Uint8Array) => void) | null;
  /** a peer connected (true) or was lost (false) */
  onPeer: ((peer: string, up: boolean) => void) | null;
  /**
   * Optional: a peer's link dropped and is being held open for it ('lost'),
   * then it reconnected ('back') or the wait ran out ('gone', just before
   * `onPeer(peer, false)`). Transports that never drop links don't call it.
   */
  onLink?: ((peer: string, state: LinkState) => void) | null;
  close(): void;
}

export type LinkState = 'lost' | 'back' | 'gone';

/**
 * Holds a lost peer for `graceMs` before reporting it gone. WebRTC links
 * over mobile data drop for a moment and Trystero reconnects them within
 * seconds (same peer id): that mustn't end a match. A peer back in time is
 * reported up again (never down), and the protocol recovers what was lost
 * in between (the guest asks for missing turns, orders are resent). A peer
 * that said goodbye (`bye`) is reported gone at once.
 */
export class PeerGrace {
  private readonly held = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly leaving = new Set<string>();

  constructor(
    private readonly emit: (peer: string, up: boolean) => void,
    private readonly link: (peer: string, state: LinkState) => void,
    private readonly graceMs: number,
  ) {}

  up(peer: string): void {
    const h = this.held.get(peer);
    this.leaving.delete(peer);
    if (h !== undefined) {
      clearTimeout(h);
      this.held.delete(peer);
      this.link(peer, 'back');
    }
    this.emit(peer, true);
  }

  down(peer: string): void {
    if (this.held.has(peer)) return;
    if (this.leaving.delete(peer) || this.graceMs <= 0) return this.emit(peer, false);
    this.link(peer, 'lost');
    this.held.set(
      peer,
      setTimeout(() => {
        this.held.delete(peer);
        this.link(peer, 'gone');
        this.emit(peer, false);
      }, this.graceMs),
    );
  }

  /** its link is down and being held: nothing sent to it can arrive */
  isHeld(peer: string): boolean {
    return this.held.has(peer);
  }

  /** the peer is leaving on purpose: its next loss (or the one being held) is final */
  bye(peer: string): void {
    const h = this.held.get(peer);
    if (h === undefined) return void this.leaving.add(peer);
    clearTimeout(h);
    this.held.delete(peer);
    this.emit(peer, false);
  }

  close(): void {
    for (const h of this.held.values()) clearTimeout(h);
    this.held.clear();
    this.leaving.clear();
  }
}

/**
 * Peers in one process, delivering synchronously: what the host's own client
 * uses to reach the host's sequencer, and what the loopback tests use.
 */
export class LoopbackHub {
  private readonly peers = new Map<string, Transport>();

  link(self: string): Transport {
    if (this.peers.has(self)) throw new Error(`loopback: ${self} is already linked`);
    const hub = this.peers;
    const t: Transport = {
      self,
      onMessage: null,
      onPeer: null,
      send(peer, bytes) {
        hub.get(peer)?.onMessage?.(self, bytes);
      },
      close() {
        hub.delete(self);
        for (const p of hub.values()) p.onPeer?.(self, false);
      },
    };
    for (const p of hub.values()) p.onPeer?.(self, true);
    hub.set(self, t);
    return t;
  }
}

/**
 * A Sequencer speaking bytes over a transport: decodes what peers send (bad
 * bytes are dropped), encodes what it sends, and marks lost peers away.
 */
export function hostSequencer(transport: Transport, cfg: Omit<SequencerConfig, 'send'>, intercept?: (peer: string, m: Msg) => boolean): Sequencer {
  const seq = new Sequencer({ ...cfg, send: (peer, m: Msg) => transport.send(peer, encodeMsg(m)) });
  transport.onMessage = (peer, bytes) => {
    const m = decodeMsg(bytes);
    // what the match itself answers (a snapshot request, #164) never reaches the sequencer
    if (m && !intercept?.(peer, m)) seq.onMessage(peer, m);
  };
  transport.onPeer = (peer, up) => {
    if (!up) seq.peerLost(peer);
  };
  return seq;
}

/**
 * One transport shared by several listeners, each seeing only the message
 * kinds it asked for (#162: the lobby and the match run over the same room).
 * Routing reads the kind from the first byte, so nothing is decoded twice.
 * Every view hears every connect and disconnect; closing a view does nothing,
 * closing the router closes the transport.
 */
export class Router {
  private views: { kinds: ReadonlySet<MsgKind>; t: Transport }[] = [];

  constructor(readonly transport: Transport) {
    transport.onMessage = (peer, bytes) => {
      const k = msgKind(bytes);
      if (!k) return;
      for (const v of this.views) if (v.kinds.has(k)) v.t.onMessage?.(peer, bytes);
    };
    transport.onPeer = (peer, up) => {
      for (const v of this.views) v.t.onPeer?.(peer, up);
    };
    transport.onLink = (peer, state) => {
      for (const v of this.views) v.t.onLink?.(peer, state);
    };
  }

  view(kinds: readonly MsgKind[]): Transport {
    const base = this.transport;
    const t: Transport = { self: base.self, onMessage: null, onPeer: null, onLink: null, send: (peer, bytes) => base.send(peer, bytes), close: () => this.drop(t) };
    this.views.push({ kinds: new Set(kinds), t });
    return t;
  }

  private drop(t: Transport): void {
    this.views = this.views.filter((v) => v.t !== t);
  }

  close(): void {
    this.views = [];
    this.transport.close();
  }
}

/** The kinds a match's sequencer and sessions use; the rest belong to the lobby. */
export const MATCH_KINDS: readonly MsgKind[] = ['cmd', 'turns', 'ack', 'ping', 'pong', 'hash', 'snap', 'pause', 'status', 'reclaim', 'lat', 'away', 'snapreq'];
export const LOBBY_KINDS: readonly MsgKind[] = ['hello', 'refuse', 'seats', 'start', 'lobby', 'pick', 'ready'];

/** The id the host's own client has on the host's sequencer transport. */
export const HOST_SELF = '~host';

/**
 * The host's sequencer talks to remote peers over `remote` and to the host's
 * own client in-process: returns the sequencer's transport and that client's.
 * The client reaches the sequencer as `remote.self`.
 */
export function splitHost(remote: Transport): { seq: Transport; client: Transport } {
  const hub = new LoopbackHub();
  const local = hub.link(remote.self);
  const client = hub.link(HOST_SELF);
  const seq: Transport = {
    self: remote.self,
    onMessage: null,
    onPeer: null,
    send(peer, bytes) {
      if (peer === HOST_SELF) local.send(peer, bytes);
      else remote.send(peer, bytes);
    },
    close() {
      local.close();
      client.close();
    },
  };
  local.onMessage = (peer, bytes) => seq.onMessage?.(peer, bytes);
  remote.onMessage = (peer, bytes) => seq.onMessage?.(peer, bytes);
  remote.onPeer = (peer, up) => seq.onPeer?.(peer, up);
  return { seq, client };
}
