import { Rng } from '../sim/rng';
import type { Transport } from './transport';

/**
 * A network in one process on a virtual clock (#160), for testing netcode
 * without real sockets: per-link latency, jitter, loss, duplication,
 * reordering and partitions, and peers that freeze (a background tab).
 */

/** Time that only moves when told to, running whatever falls due in order. */
export class VirtualClock {
  now = 0;
  private q: { at: number; n: number; fn: () => void }[] = [];
  private n = 0;

  /** run fn at time t (or at the next advance if t has passed) */
  at(t: number, fn: () => void): void {
    const e = { at: t, n: this.n++, fn };
    // keep the queue sorted by (at, n): inserts are near the end in practice
    let i = this.q.length;
    while (i > 0 && (this.q[i - 1].at > t || (this.q[i - 1].at === t && this.q[i - 1].n > e.n))) i--;
    this.q.splice(i, 0, e);
  }

  /** move to t, running everything due on the way, in time order */
  advanceTo(t: number): void {
    while (this.q.length && this.q[0].at <= t) {
      const e = this.q.shift()!;
      this.now = Math.max(this.now, e.at);
      e.fn();
    }
    this.now = Math.max(this.now, t);
  }

  advance(ms: number): void {
    this.advanceTo(this.now + ms);
  }
}

/**
 * One direction of a link. `latency` and `jitter` are one-way ms; jitter is
 * spread so most delays sit near `latency` with a tail up to `+jitter`.
 *
 * - `reliable` (the default, like a WebRTC reliable channel): messages
 *   arrive once and in order; a loss costs a retransmit (another
 *   round trip), and everything behind it waits (head-of-line blocking).
 * - `hostile`: losses drop the message, `dup` sends it twice, and each
 *   copy takes its own delay, so messages overtake each other.
 */
export interface LinkSpec {
  latency: number;
  jitter: number;
  loss: number;
  dup: number;
  mode: 'reliable' | 'hostile';
}

export const PERFECT: LinkSpec = { latency: 0, jitter: 0, loss: 0, dup: 0, mode: 'reliable' };

interface Dir {
  spec: LinkSpec;
  /** last delivery time (reliable mode keeps order) */
  last: number;
  /** [from, to): nothing gets through; reliable traffic waits it out */
  cuts: [number, number][];
}

export class FakeNetwork {
  private readonly peers = new Map<string, Transport>();
  private readonly links = new Map<string, Dir>();
  private readonly frozen = new Map<string, number>();
  private readonly rng: Rng;
  /** messages and bytes sent, per sender */
  readonly sent = new Map<string, { msgs: number; bytes: number }>();

  constructor(
    readonly clock: VirtualClock,
    seed = 1,
    private readonly fallback: LinkSpec = PERFECT,
  ) {
    this.rng = new Rng(seed);
  }

  private dir(a: string, b: string): Dir {
    const k = `${a}>${b}`;
    let d = this.links.get(k);
    if (!d) this.links.set(k, (d = { spec: this.fallback, last: 0, cuts: [] }));
    return d;
  }

  /** set both directions between a and b (each one-way `latency`) */
  link(a: string, b: string, spec: Partial<LinkSpec>): void {
    for (const [x, y] of [[a, b], [b, a]]) {
      const d = this.dir(x, y);
      d.spec = { ...this.fallback, ...spec };
    }
  }

  /** nothing gets between a and b during [from, to) ms */
  partition(a: string, b: string, from: number, to: number): void {
    this.dir(a, b).cuts.push([from, to]);
    this.dir(b, a).cuts.push([from, to]);
  }

  /** the peer runs nothing until `until`; what reaches it waits in order */
  freeze(peer: string, until: number): void {
    this.frozen.set(peer, until);
  }

  isFrozen(peer: string): boolean {
    return (this.frozen.get(peer) ?? -1) > this.clock.now;
  }

  transport(self: string): Transport {
    if (this.peers.has(self)) throw new Error(`fake network: ${self} exists`);
    const net = this;
    const t: Transport = {
      self,
      onMessage: null,
      onPeer: null,
      send(peer, bytes) {
        net.deliver(self, peer, bytes);
      },
      close() {
        net.peers.delete(self);
        for (const p of net.peers.values()) p.onPeer?.(self, false);
      },
    };
    this.peers.set(self, t);
    return t;
  }

  private delay(s: LinkSpec): number {
    // most samples near the base, a tail to +jitter (cubed uniform)
    const u = this.rng.next();
    return s.latency + s.jitter * u * u * u;
  }

  private deliver(from: string, to: string, bytes: Uint8Array): void {
    const stat = this.sent.get(from) ?? { msgs: 0, bytes: 0 };
    stat.msgs++;
    stat.bytes += bytes.length;
    this.sent.set(from, stat);
    const d = this.dir(from, to);
    const s = d.spec;
    const now = this.clock.now;
    const copy = bytes.slice();
    if (s.mode === 'reliable') {
      let at = now + this.delay(s);
      // each loss costs a retransmit timeout, at least 200 ms like SCTP's floor
      while (this.rng.next() < s.loss) at += Math.max(200, 2 * s.latency);
      at = this.afterCuts(d, at);
      at = Math.max(at, d.last);
      d.last = at;
      this.schedule(to, from, copy, at);
      return;
    }
    const copies = this.rng.next() < s.dup ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      if (this.rng.next() < s.loss) continue;
      const at = now + this.delay(s);
      if (d.cuts.some(([a, b]) => at >= a && at < b) || d.cuts.some(([a, b]) => now >= a && now < b)) continue;
      this.schedule(to, from, copy, at);
    }
  }

  private afterCuts(d: Dir, at: number): number {
    for (const [a, b] of d.cuts) if (at >= a && at < b) at = b + (at - a);
    return at;
  }

  private schedule(to: string, from: string, bytes: Uint8Array, at: number): void {
    this.clock.at(at, () => {
      const until = this.frozen.get(to) ?? -1;
      if (until > this.clock.now) {
        // frozen: wait in line until it thaws (keeping order, after anything already waiting)
        const thaw = this.thawQueue.get(to) ?? [];
        thaw.push([from, bytes]);
        if (thaw.length === 1) {
          this.thawQueue.set(to, thaw);
          this.clock.at(until, () => this.thaw(to));
        }
        return;
      }
      this.peers.get(to)?.onMessage?.(from, bytes);
    });
  }

  private thawQueue = new Map<string, [string, Uint8Array][]>();

  private thaw(to: string): void {
    const q = this.thawQueue.get(to) ?? [];
    this.thawQueue.delete(to);
    for (const [from, b] of q) this.peers.get(to)?.onMessage?.(from, b);
  }
}
