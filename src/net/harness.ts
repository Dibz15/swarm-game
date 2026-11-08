import { Proxy } from '../proxy/proxy';
import { limitsOf } from '../sim/sanitize';
import type { MatchSetup } from '../sim/setup';
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
  /** duplicates: only with `mode: 'hostile'` (a reliable channel never duplicates) */
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
  /**
   * Every hash any client computed, compared here directly (late, lost or
   * thawed reports included): ticks seen by at least two clients, and the
   * first ticks where they disagreed.
   */
  hashTicks: number;
  mismatches: number[];
  /** ticks the sequencer itself flagged */
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
  for (const p of o.peers) {
    const pl = o.setup.players.find((q) => q.faction === p.seat);
    if (!pl) throw new Error(`net-sim: seat ${p.seat} is not in the match`);
    if (!pl.human) throw new Error(`net-sim: seat ${p.seat} is a bot's`);
  }
  const clock = new VirtualClock();
  const net = new FakeNetwork(clock, o.seed ?? 1);
  const frame = o.frameMs ?? 1000 / 60;
  const hostT = net.transport('host');

  // every hash every client computes: tick -> seat -> hash
  const hashes = new Map<number, Map<number, number>>();
  const clients = o.peers.map((p) => {
    const id = `p${p.seat}`;
    net.link(id, 'host', { latency: p.rtt / 2, jitter: p.jitter ?? 0, loss: p.loss ?? 0, dup: p.dup ?? 0, mode: p.mode ?? 'reliable' });
    // a NetSession sends nothing until its first update, so the sequencer can come after
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
    session.onHash = (t, h) => {
      let m = hashes.get(t);
      if (!m) hashes.set(t, (m = new Map()));
      m.set(p.seat, h);
    };
    for (const [a, b] of p.freeze ?? []) clock.at(a, () => net.freeze(id, b));
    return { spec: p, id, session, effects, proxy: new Proxy(p.seat, { skill: p.skill ?? 1 }), thought: -1 };
  });

  const seq = hostSequencer(hostT, {
    limits: limitsOf(clients[0].session.world),
    seats: o.peers.map((p) => ({ seat: p.seat, team: o.setup.players.find((q) => q.faction === p.seat)!.team, peer: `p${p.seat}` })),
    clock: () => clock.now,
    opts: o.seq,
  });
  const desyncs: number[] = [];
  seq.onDesync = (t) => desyncs.push(t);

  /** one frame: `play` lets the Proxies give orders, `close` lets the sequencer close turns */
  const frameAll = (play: boolean, close: boolean) => {
    clock.advance(frame);
    if (close) seq.update();
    for (const c of clients) {
      if (net.isFrozen(c.id)) continue;
      const w = c.session.world;
      // once per sim tick at most (the Proxy catches up on any it missed)
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
  while (clock.now < end) frameAll(true, true);

  const seconds = clock.now / 1000;
  const closed = seq.closed;
  const stats = clients.map((c) => ({ stallMs: c.session.stallMs, caughtUp: c.session.caughtUp, target: c.session.target, bufferHist: c.session.bufferHist.slice() }));
  const downBytes = net.sent.get('host')?.bytes ?? 0;

  // Drain, part 1: no new orders, but turns keep closing until every order
  // still on its way (a retransmit, a long PvP hold) has a place in one.
  const live = () => clients.filter((c) => !c.session.world.over);
  for (let k = 0; k < 60 * 60 && live().some((c) => c.session.queued > 0); k++) frameAll(false, true);
  // Part 2: no more turns close. Time still passes, so messages land and
  // clients ask again for turns they lost; everyone steps to the last closed one.
  for (let k = 0; k < 60 * 60 && live().some((c) => c.session.world.tick < seq.closed); k++) frameAll(false, false);
  const finals = new Set(clients.map((c) => `${c.session.world.tick}:${fullHash(c.session.world)}`));

  let hashTicks = 0;
  const mismatches: number[] = [];
  for (const [t, m] of [...hashes].sort((x, y) => x[0] - y[0])) {
    if (m.size < 2) continue;
    hashTicks++;
    if (new Set(m.values()).size > 1 && mismatches.length < 20) mismatches.push(t);
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
    closed,
  };
}
