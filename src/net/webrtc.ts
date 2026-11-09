import { PeerGrace, type Transport } from './transport';

/**
 * Peers over WebRTC data channels (#162), found through Trystero's Nostr
 * strategy: peers in the same room id find each other on public Nostr
 * relays, then talk directly, end-to-end encrypted. No server of ours.
 *
 * - The room secret is Trystero's `password`: signaling is encrypted with
 *   it, so only people with the link can join.
 * - Every message goes through one binary action. Trystero's channels are
 *   reliable and ordered, which is what v1 needs.
 * - Trystero connects every peer to every other (a full mesh). A match only
 *   uses the links to the host; the rest wait for host migration (#166).
 * - A dropped link is held for `graceMs` (PeerGrace): over mobile data links
 *   drop for a moment and Trystero reconnects them by itself. A peer that
 *   leaves on purpose says goodbye first, so its loss is reported at once.
 * - Loaded with a dynamic import, so single player never downloads it.
 */

export interface IceOptions {
  /** TURN servers (#163); without them only direct and STUN routes are tried */
  turn?: RTCIceServer[];
  /** relay everything through TURN, so peers never see each other's IP */
  relayOnly?: boolean;
}

export interface WebRtcRoom {
  room: string;
  secret: string;
  ice?: IceOptions;
  /** a peer was found but no connection could be made (usually: TURN needed) */
  onError?: (error: string) => void;
  /** how long a dropped peer has to reconnect before it's reported lost (ms) */
  graceMs?: number;
}

/** Trystero needs ~5 s to give up on a link and ~5 s to announce and reconnect; leave room for a slow relay. */
export const RECONNECT_GRACE_MS = 20_000;

/** Namespaces our rooms on the relays: bumped with the protocol so old clients never meet new ones there. */
const APP_ID = 'swarm-game.fourthcontact.v7';

export async function webrtcTransport(o: WebRtcRoom): Promise<Transport> {
  const { joinRoom, selfId } = await import('trystero/nostr');
  const room = joinRoom(
    {
      appId: APP_ID,
      password: o.secret,
      turnConfig: o.ice?.turn?.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })),
      ...(o.ice?.relayOnly ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {}),
    },
    o.room,
    { onJoinError: (d) => o.onError?.(String(d.error)) },
  );
  const action = room.makeAction<Uint8Array>('n');
  // "I'm leaving on purpose": peers report us gone at once instead of waiting for a reconnect
  const bye = room.makeAction<string>('b');
  let open = true;
  const sayBye = () => {
    if (open) bye.send('').catch(() => undefined);
  };
  const t: Transport = {
    self: selfId,
    onMessage: null,
    onPeer: null,
    onLink: null,
    send(peer, bytes) {
      // a dropped link can't take it (Trystero would warn on every message); the protocol resends once it's back
      if (grace.isHeld(peer)) return;
      action.send(bytes, { target: peer }).catch(() => {
        /* the peer is gone for now: a reconnect resumes, or its loss is reported */
      });
    },
    async linkInfo(peer) {
      if (!open || grace.isHeld(peer)) return {};
      const [rtt, relay] = await Promise.all([
        withTimeout(room.ping(peer), 2000).catch(() => undefined),
        relayed(room.getPeers()[peer]).catch(() => undefined),
      ]);
      return { rtt: rtt === undefined ? undefined : Math.round(rtt), relay };
    },
    close() {
      if (!open) return;
      sayBye();
      open = false;
      grace.close();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
      void room.leave();
    },
  };
  const grace = new PeerGrace(
    (peer, up) => t.onPeer?.(peer, up),
    (peer, state) => t.onLink?.(peer, state),
    o.graceMs ?? RECONNECT_GRACE_MS,
  );
  // closing or leaving the page: Trystero leaves the room on its own, but say goodbye first
  const onHide = (e: PageTransitionEvent) => {
    if (!e.persisted) sayBye();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
  bye.onMessage = (_d, { peerId }) => grace.bye(peerId);
  action.onMessage = (data, { peerId }) => {
    const v = data as ArrayBuffer | ArrayBufferView;
    const bytes = v instanceof Uint8Array ? v : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
    t.onMessage?.(peerId, bytes);
  };
  room.onPeerJoin = (peer) => grace.up(peer);
  room.onPeerLeave = (peer) => grace.down(peer);
  return t;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
}

/** Whether the link in use to a peer goes through a TURN relay: its chosen candidate pair's ends, either side. */
async function relayed(pc: RTCPeerConnection | undefined): Promise<boolean | undefined> {
  if (!pc) return undefined;
  const stats = await pc.getStats();
  let pairId: string | undefined;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
  });
  // Firefox has no transport stats: the nominated, succeeded pair is the one in use
  if (!pairId) stats.forEach((s) => {
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id;
  });
  const pair = pairId ? stats.get(pairId) : undefined;
  if (!pair) return undefined;
  const type = (id: string) => stats.get(id)?.candidateType;
  return type(pair.localCandidateId) === 'relay' || type(pair.remoteCandidateId) === 'relay';
}
