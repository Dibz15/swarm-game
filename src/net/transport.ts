import { decodeMsg, encodeMsg } from './codec';
import type { Msg } from './protocol';
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
  close(): void;
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
export function hostSequencer(transport: Transport, cfg: Omit<SequencerConfig, 'send'>): Sequencer {
  const seq = new Sequencer({ ...cfg, send: (peer, m: Msg) => transport.send(peer, encodeMsg(m)) });
  transport.onMessage = (peer, bytes) => {
    const m = decodeMsg(bytes);
    if (m) seq.onMessage(peer, m);
  };
  transport.onPeer = (peer, up) => {
    if (!up) seq.peerLost(peer);
  };
  return seq;
}
