import type { Transport } from './transport';

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
}

/** Namespaces our rooms on the relays: bumped with the protocol so old clients never meet new ones there. */
const APP_ID = 'swarm-game.dibz15.v2';

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
  const t: Transport = {
    self: selfId,
    onMessage: null,
    onPeer: null,
    send(peer, bytes) {
      action.send(bytes, { target: peer }).catch(() => {
        /* the peer is gone: its leave event says so */
      });
    },
    close() {
      void room.leave();
    },
  };
  action.onMessage = (data, { peerId }) => {
    const v = data as ArrayBuffer | ArrayBufferView;
    const bytes = v instanceof Uint8Array ? v : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
    t.onMessage?.(peerId, bytes);
  };
  room.onPeerJoin = (peer) => t.onPeer?.(peer, true);
  room.onPeerLeave = (peer) => t.onPeer?.(peer, false);
  return t;
}
