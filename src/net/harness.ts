import { Proxy } from '../proxy/proxy';
import { limitsOf } from '../sim/sanitize';
import { createWorld, type MatchSetup } from '../sim/setup';
import { fullHash } from '../sim/snapshot';
import { decodeMsg } from './codec';
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
  /** ticks at which at least two clients reported a hash, and how many of those disagreed */
  hashTicks: number;
  mismatches: number[];
  desyncs: number[];
  /** after the last turn, every client ends on the same tick with the same fullHash */
  finalAgree: boolean;
  /** bytes the host sent per client per second */
  downBps: number;
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
  // watch the hash reports on their way in
  const reports = new Map<number, Map<number, number>>();
  const inner = hostT.onMessage!;
  hostT.onMessage = (peer, bytes) => {
    const m = decodeMsg(bytes);
    if (m?.k === 'hash') {
      let r = reports.get(m.tick);
      if (!r) reports.set(m.tick, (r = new Map()));
      r.set(Number(peer.slice(1)), m.hash);
    }
    inner(peer, bytes);
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
    return { spec: p, id, session, effects, proxy: new Proxy(p.seat, { skill: p.skill ?? 1 }) };
  });

  const end = o.secs * 1000;
  while (clock.now < end) {
    clock.advance(frame);
    seq.update();
    for (const c of clients) {
      if (net.isFrozen(c.id)) continue;
      const w = c.session.world;
      if (!w.over) for (const cmd of c.proxy.think(w)) c.session.issue(cmd);
      c.session.update(frame / 1000);
      w.fx = [];
      w.deaths = [];
    }
  }

  const seconds = clock.now / 1000;
  const stats = clients.map((c) => ({ stallMs: c.session.stallMs, caughtUp: c.session.caughtUp, target: c.session.target, bufferHist: c.session.bufferHist.slice() }));
  const downBytes = net.sent.get('host')?.bytes ?? 0;

  // Drain: no new turns; everyone steps what it holds (or still has on the way) up to the last closed tick.
  for (let k = 0; k < 2000 && clients.some((c) => !c.session.world.over && c.session.world.tick < seq.closed); k++) {
    clock.advance(frame);
    for (const c of clients) {
      if (net.isFrozen(c.id)) continue;
      c.session.update(frame / 1000);
      c.session.world.fx = [];
      c.session.world.deaths = [];
    }
  }
  const finals = new Set(clients.map((c) => `${c.session.world.tick}:${fullHash(c.session.world)}`));

  let hashTicks = 0;
  const mismatches: number[] = [];
  for (const [t, r] of [...reports].sort((x, y) => x[0] - y[0])) {
    if (r.size < 2) continue;
    hashTicks++;
    if (new Set(r.values()).size > 1 && mismatches.length < 20) mismatches.push(t);
  }

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
    mismatches,
    desyncs,
    finalAgree: finals.size === 1,
    downBps: downBytes / clients.length / seconds,
    closed: seq.closed,
  };
}
