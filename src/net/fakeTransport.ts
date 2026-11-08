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
  /** a binary min-heap on (at, n): ties run in the order they were scheduled */
  private q: { at: number; n: number; fn: () => void }[] = [];
  private n = 0;

  /** run fn at time t (or at the next advance if t has passed) */
  at(t: number, fn: () => void): void {
    const q = this.q;
    const e = { at: t, n: this.n++, fn };
    let i = q.length;
    q.push(e);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.before(e, q[up])) break;
      q[i] = q[up];
      i = up;
    }
    q[i] = e;
  }

  /** move to t, running everything due on the way, in time order */
  advanceTo(t: number): void {
    while (this.q.length && this.q[0].at <= t) {
      const e = this.pop();
      this.now = Math.max(this.now, e.at);
      e.fn();
    }
    this.now = Math.max(this.now, t);
  }

  advance(ms: number): void {
    this.advanceTo(this.now + ms);
  }

  private before(a: { at: number; n: number }, b: { at: number; n: number }): boolean {
    return a.at < b.at || (a.at === b.at && a.n < b.n);
  }

  private pop(): { at: number; n: number; fn: () => void } {
    const q = this.q;
    const top = q[0];
    const last = q.pop()!;
    if (q.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= q.length) break;
        const c = l + 1 < q.length && this.before(q[l + 1], q[l]) ? l + 1 : l;
        if (!this.before(q[c], last)) break;
        q[i] = q[c];
        i = c;
      }
      q[i] = last;
    }
    return top;
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
 *
 * A `loss` of 1 is a dead link: nothing arrives, in either mode.
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

  /** the peer runs nothing until `until`; what reaches it waits in order (a later call can extend it) */
  freeze(peer: string, until: number): void {
    this.frozen.set(peer, Math.max(until, this.frozen.get(peer) ?? -1));
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
    for (const p of this.peers.values()) p.onPeer?.(self, true);
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
    if (s.loss >= 1) return;
    const now = this.clock.now;
    const copy = bytes.slice();
    if (s.mode === 'reliable') {
      let at = now + this.delay(s);
      // each loss costs a retransmit timeout, at least 200 ms like SCTP's floor
      while (this.rng.next() < s.loss) at += Math.max(200, 2 * s.latency);
      at = this.afterCuts(d, now, at);
      at = Math.max(at, d.last);
      d.last = at;
      this.schedule(to, from, copy, at);
      return;
    }
    const copies = this.rng.next() < s.dup ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      if (this.rng.next() < s.loss) continue;
      const at = now + this.delay(s);
      if (d.cuts.some(([a, b]) => (at >= a && at < b) || (now >= a && now < b))) continue;
      this.schedule(to, from, copy, at);
    }
  }

  /**
   * Reliable traffic waits out the cuts: one sent during a cut leaves when it
   * ends, and one that would land in a cut is retransmitted after it. Shifting
   * past one cut can land in another, so this repeats until nothing moves.
   */
  private afterCuts(d: Dir, sent: number, at: number): number {
    for (let moved = true; moved; ) {
      moved = false;
      for (const [a, b] of d.cuts) {
        if (sent >= a && sent < b) {
          at += b - sent;
          sent = b;
          moved = true;
        }
        if (at >= a && at < b) {
          at = b + (at - a);
          moved = true;
        }
      }
    }
    return at;
  }

  /** what reaches a frozen peer, waiting in arrival order */
  private thawQueue = new Map<string, [string, Uint8Array][]>();

  private schedule(to: string, from: string, bytes: Uint8Array, at: number): void {
    this.clock.at(at, () => {
      // anything already waiting goes first, even if this one is due right at the thaw
      const waiting = this.thawQueue.get(to);
      if (waiting) {
        waiting.push([from, bytes]);
        return;
      }
      const until = this.frozen.get(to) ?? -1;
      if (until > this.clock.now) {
        this.thawQueue.set(to, [[from, bytes]]);
        this.clock.at(until, () => this.thaw(to));
        return;
      }
      this.peers.get(to)?.onMessage?.(from, bytes);
    });
  }

  private thaw(to: string): void {
    // frozen again for longer since this was scheduled: wait for the new end
    const until = this.frozen.get(to) ?? -1;
    if (until > this.clock.now) {
      this.clock.at(until, () => this.thaw(to));
      return;
    }
    const q = this.thawQueue.get(to) ?? [];
    this.thawQueue.delete(to);
    for (const [from, b] of q) this.peers.get(to)?.onMessage?.(from, b);
  }
}
