import { Proxy } from '../proxy/proxy';
import { limitsOf } from '../sim/sanitize';
import { createWorld, type MatchSetup } from '../sim/setup';
import { fullHash } from '../sim/snapshot';
import { FakeNetwork, VirtualClock, type LinkSpec } from './fakeTransport';
import { NetSession, type NetSessionOptions } from './netSession';
import type { SequencerOptions } from './sequencer';
import { hostSequencer } from './transport';

/**
 * A whole networked match in one process (#160): a host sequencer, one
 * NetSession per human seat behind its own simulated link, Proxy players
 * issuing through `issue()`, and bots in the other seats. Everything runs
 * on a virtual clock, so a 5-minute match over a 300 ms link takes as long
 * as simulating it does.
 */

export interface PeerSpec {
  seat: number;
  /** round trip to the host, ms (the host's own client: 0) */
  rtt: number;
  /** extra one-way delay at the tail, ms */
  jitter?: number;
  loss?: number;
  dup?: number;
  mode?: LinkSpec['mode'];
  /** the Proxy's skill (default 1) */
  skill?: number;
  /** [from, to) ms windows where this peer runs nothing (a background tab) */
  freeze?: [number, number][];
}

export interface NetMatchOptions {
  setup: MatchSetup;
  peers: PeerSpec[];
  secs: number;
  frameMs?: number;
  seed?: number;
  seq?: Partial<SequencerOptions>;
  net?: Partial<NetSessionOptions>;
  /** the virtual cost of one step for catch-up budgets (default 1 ms) */
  stepCostMs?: number;
}

export interface SeatReport {
  seat: number;
  rtt: number;
  /** issue → the step that ran it, ms */
  effect: { n: number; p50: number; p95: number; max: number };
  stallMs: number;
  caughtUp: number;
  /** final jitter-buffer target, and how often each buffered count was seen */
  target: number;
  bufferHist: number[];
  tick: number;
  issued: number;
  ran: number;
  /** bytes sent up to the host */
  upBytes: number;
}

export interface NetMatchReport {
  seats: SeatReport[];
  /** ticks at which the sequencer compared hashes from at least two clients */
  hashTicks: number;
  /** ticks at which they disagreed */
  desyncs: number[];
  /** after the last turn, every client ends on the same tick with the same fullHash */
  finalAgree: boolean;
  /** bytes the host sent per client per second */
  downBps: number;
  /** turns closed by the end of the match (before the drain) */
  closed: number;
}

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);

export function runNetMatch(o: NetMatchOptions): NetMatchReport {
  const clock = new VirtualClock();
  const net = new FakeNetwork(clock, o.seed ?? 1);
  const frame = o.frameMs ?? 1000 / 60;
  const hostT = net.transport('host');
  const seq = hostSequencer(hostT, {
    limits: limitsOf(createWorld(o.setup)),
    seats: o.peers.map((p) => ({ seat: p.seat, team: o.setup.players.find((q) => q.faction === p.seat)!.team ?? p.seat, peer: `p${p.seat}` })),
    clock: () => clock.now,
    opts: o.seq,
  });
  const desyncs: number[] = [];
  seq.onDesync = (t) => desyncs.push(t);
  let hashTicks = 0;
  seq.onHashes = (_t, m) => {
    if (m.size >= 2) hashTicks++;
  };

  const clients = o.peers.map((p) => {
    const id = `p${p.seat}`;
    net.link(id, 'host', { latency: p.rtt / 2, jitter: p.jitter ?? 0, loss: p.loss ?? 0, dup: p.dup ?? 0, mode: p.mode ?? 'reliable' });
    const session = new NetSession({
      setup: o.setup,
      seat: p.seat,
      transport: net.transport(id),
      host: 'host',
      clock: () => clock.now,
      opts: { stepCostMs: o.stepCostMs ?? 1, ...o.net },
    });
    const effects: number[] = [];
    session.onEffect = (_s, ms) => effects.push(ms);
    for (const [a, b] of p.freeze ?? []) clock.at(a, () => net.freeze(id, b));
    return { spec: p, id, session, effects, proxy: new Proxy(p.seat, { skill: p.skill ?? 1 }), thought: -1 };
  });

  const frameAll = (play: boolean) => {
    clock.advance(frame);
    seq.update();
    for (const c of clients) {
      if (net.isFrozen(c.id)) continue;
      const w = c.session.world;
      // the Proxy decides once per sim tick, as it does in front of step()
      if (play && !w.over && w.tick !== c.thought) {
        c.thought = w.tick;
        for (const cmd of c.proxy.think(w)) c.session.issue(cmd);
      }
      c.session.update(frame / 1000);
      w.fx = [];
      w.deaths = [];
    }
  };

  const end = o.secs * 1000;
  while (clock.now < end) frameAll(true);

  const seconds = clock.now / 1000;
  const closed = seq.closed;
  const stats = clients.map((c) => ({ stallMs: c.session.stallMs, caughtUp: c.session.caughtUp, target: c.session.target, bufferHist: c.session.bufferHist.slice() }));
  const downBytes = net.sent.get('host')?.bytes ?? 0;

  // Drain, part 1: no new orders, but turns keep closing until every order
  // still on its way (a retransmit, a long PvP hold) has a place in one.
  const live = () => clients.filter((c) => !c.session.world.over);
  for (let k = 0; k < 60 * 60 && live().some((c) => c.session.queued > 0); k++) frameAll(false);
  // Part 2: the clock stops; everyone steps what it holds, or still has on the way, up to the last closed turn.
  for (let k = 0; k < 60 * 60 && live().some((c) => c.session.world.tick < seq.closed); k++) {
    clock.advance(frame);
    for (const c of clients) {
      if (net.isFrozen(c.id)) continue;
      c.session.update(frame / 1000);
      c.session.world.fx = [];
      c.session.world.deaths = [];
    }
  }
  const finals = new Set(clients.map((c) => `${c.session.world.tick}:${fullHash(c.session.world)}`));

  return {
    seats: clients.map((c, i) => {
      const e = [...c.effects].sort((a, b) => a - b);
      const s = c.session;
      return {
        seat: c.spec.seat,
        rtt: c.spec.rtt,
        effect: { n: e.length, p50: pct(e, 0.5), p95: pct(e, 0.95), max: e.at(-1) ?? 0 },
        ...stats[i],
        tick: s.world.tick,
        issued: s.issued,
        ran: s.log.filter((x) => x.cmd.p === c.spec.seat).length,
        upBytes: net.sent.get(c.id)?.bytes ?? 0,
      };
    }),
    hashTicks,
    desyncs,
    finalAgree: finals.size === 1,
    downBps: downBytes / clients.length / seconds,
    closed,
  };
}
