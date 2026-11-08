import type { Transport } from './transport';

/**
 * Peers in other tabs of the same browser, over a BroadcastChannel (#162):
 * for development (`?net=local`) and for testing the lobby and a whole match
 * without public relays. Node has BroadcastChannel too, so it's unit-tested.
 *
 * Tabs announce themselves on open and then every `beatMs`; one not heard
 * from for `timeoutMs` is gone, as is one that says goodbye (on close, or
 * when its page is hidden for good).
 */

interface Wire {
  t: 'hi' | 'bye' | 'msg';
  from: string;
  to?: string;
  bytes?: Uint8Array;
  /** a 'hi' that answers another: no reply needed */
  re?: boolean;
}

export interface BroadcastOptions {
  beatMs?: number;
  timeoutMs?: number;
  /** this tab's id (default: random) */
  self?: string;
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

export function broadcastTransport(room: string, o: BroadcastOptions = {}): Transport {
  const beatMs = o.beatMs ?? 1000;
  const timeoutMs = o.timeoutMs ?? 4000;
  const self = o.self ?? randomId();
  const ch = new BroadcastChannel(`swarm-room:${room}`);
  const seen = new Map<string, number>();
  let open = true;

  const post = (w: Wire) => {
    if (open) ch.postMessage(w);
  };
  const lost = (peer: string) => {
    if (seen.delete(peer)) t.onPeer?.(peer, false);
  };

  const t: Transport = {
    self,
    onMessage: null,
    onPeer: null,
    send(peer, bytes) {
      post({ t: 'msg', from: self, to: peer, bytes });
    },
    close() {
      if (!open) return;
      post({ t: 'bye', from: self });
      open = false;
      clearInterval(beat);
      ch.close();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
    },
  };

  ch.onmessage = (e: MessageEvent<Wire>) => {
    const w = e.data;
    if (!w || typeof w.from !== 'string' || w.from === self) return;
    if (w.t === 'bye') return lost(w.from);
    const known = seen.has(w.from);
    seen.set(w.from, Date.now());
    if (!known) {
      t.onPeer?.(w.from, true);
      // let the newcomer know we're here without waiting for the next beat
      if (w.t === 'hi' && !w.re) post({ t: 'hi', from: self, re: true });
    }
    if (w.t === 'msg' && w.to === self && w.bytes instanceof Uint8Array) t.onMessage?.(w.from, w.bytes);
  };

  const beat = setInterval(() => {
    post({ t: 'hi', from: self, re: true });
    const now = Date.now();
    for (const [peer, at] of seen) if (now - at > timeoutMs) lost(peer);
  }, beatMs);
  const onHide = (e: PageTransitionEvent) => {
    if (!e.persisted) t.close();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);

  // announce once whoever owns us has had a chance to set onPeer/onMessage
  queueMicrotask(() => post({ t: 'hi', from: self }));
  return t;
}
