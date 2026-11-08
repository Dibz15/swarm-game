import { describe, expect, it } from 'vitest';
import { LocalSession } from '../src/game/session';
import { NetSession, type NetSessionOptions } from '../src/net/netSession';
import type { SequencerOptions } from '../src/net/sequencer';
import { hostSequencer, LoopbackHub, type Transport } from '../src/net/transport';
import { Proxy } from '../src/proxy/proxy';
import { DT, TICK_HZ } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { limitsOf } from '../src/sim/sanitize';
import { seatHasBot } from '../src/sim/seats';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { fullHash } from '../src/sim/snapshot';
import type { World } from '../src/sim/world';

const DT_MS = DT * 1000;
const FRAME = 1000 / 60;

const tidy = (w: World) => {
  w.fx = [];
  w.deaths = [];
};

/** Human seats (FFA) plus two Normal bots. */
function setup(humans: number[], seed = 3): MatchSetup {
  const players: MatchSetup['players'] = humans.map((f) => ({ faction: f, team: f, human: true }));
  for (const f of [1, 3]) players.push({ faction: f, team: f, human: false, bot: { difficulty: 1, personality: f === 1 ? 'expander' : 'rusher' } });
  return { seed, size: 'small', players };
}

/** A host sequencer and one NetSession per seat, over a loopback hub. `wrap` can mess with a client's link. */
function table(s: MatchSetup, seats: number[], seqOpts: Partial<SequencerOptions> = {}, netOpts: Partial<NetSessionOptions> = {}, wrap?: (t: Transport, seat: number) => Transport) {
  const clock = { now: 0 };
  const hub = new LoopbackHub();
  const seq = hostSequencer(hub.link('host'), {
    limits: limitsOf(createWorld(s)),
    seats: seats.map((f) => ({ seat: f, team: f, peer: `p${f}` })),
    clock: () => clock.now,
    opts: seqOpts,
  });
  const desyncs: number[] = [];
  seq.onDesync = (t) => desyncs.push(t);
  const nets = seats.map((f) => {
    const raw = hub.link(`p${f}`);
    const t = wrap ? wrap(raw, f) : raw;
    return new NetSession({ setup: s, seat: f, transport: t, host: 'host', clock: () => clock.now, opts: netOpts });
  });
  return { clock, seq, nets, desyncs };
}

/**
 * A client link that loses, duplicates and reorders messages on a fixed
 * pattern (both ways), as a lossy unreliable channel would.
 */
function chaos(t: Transport, salt: number): Transport {
  let n = salt, m = salt;
  const held: [string, Uint8Array][] = [];
  const out: Transport = {
    self: t.self,
    onMessage: null,
    onPeer: null,
    send(peer, bytes) {
      if (++m % 13 === 0) return; // lost on the way up
      t.send(peer, bytes);
    },
    close: () => t.close(),
  };
  t.onMessage = (peer, bytes) => {
    n++;
    if (n % 9 === 0) return; // lost
    if (n % 11 === 0) {
      held.push([peer, bytes]); // delivered after the next one
      return;
    }
    out.onMessage?.(peer, bytes);
    if (n % 7 === 0) out.onMessage?.(peer, bytes); // duplicated
    while (held.length) {
      const [p, b] = held.shift()!;
      out.onMessage?.(p, b);
    }
  };
  return out;
}

describe('NetSession (#159)', () => {
  it('over loopback with no delay, plays exactly like LocalSession', () => {
    const s = setup([0]);
    const secs = 60;

    const local = new LocalSession(s);
    const pa = new Proxy(0, { skill: 1 });
    for (let f = 0; f < secs * TICK_HZ; f++) {
      for (const c of pa.think(local.world)) local.issue(c);
      local.update(DT);
      tidy(local.world);
    }

    const { clock, seq, nets } = table(s, [0], { dMin: 0 }, { minBuffer: 0 });
    const net = nets[0];
    const pb = new Proxy(0, { skill: 1 });
    for (let f = 0; f < secs * TICK_HZ; f++) {
      for (const c of pb.think(net.world)) net.issue(c);
      clock.now = (f + 1) * DT_MS + 1;
      seq.update();
      net.update(DT);
      tidy(net.world);
    }

    expect(local.log.length).toBeGreaterThan(20);
    expect(net.world.tick).toBe(local.world.tick);
    expect(net.log).toEqual(local.log);
    expect(worldHash(net.world)).toBe(worldHash(local.world));
    expect(fullHash(net.world)).toBe(fullHash(local.world));
    expect(net.queued).toBe(0);
    expect(net.stallMs).toBe(0);
  });

  it('survives lost, duplicated and reordered messages: same turns, same worlds, every order lands', () => {
    const s = setup([0, 2]);
    const { clock, seq, nets, desyncs } = table(s, [0, 2], {}, {}, (t, f) => chaos(t, f));
    const proxies = [new Proxy(0, { skill: 1 }), new Proxy(2, { skill: 0.6 })];
    for (let f = 0; f < 50 * 60; f++) {
      nets.forEach((n, i) => {
        for (const c of proxies[i].think(n.world)) n.issue(c);
      });
      clock.now += FRAME;
      seq.update();
      for (const n of nets) {
        n.update(FRAME / 1000);
        tidy(n.world);
      }
    }
    expect(desyncs).toEqual([]);
    const [a, b] = nets;
    expect(Math.min(a.world.tick, b.world.tick)).toBeGreaterThan(45 * TICK_HZ);
    const upTo = Math.min(a.world.tick, b.world.tick);
    expect(a.log.filter((e) => e.tick <= upTo)).toEqual(b.log.filter((e) => e.tick <= upTo));
    for (const n of nets) {
      expect(n.badMessages).toBe(0);
      const ran = n.log.filter((e) => e.cmd.p === n.localSeat).length;
      expect(ran).toBeGreaterThan(10);
      expect(ran + n.queued).toBe(n.issued);
    }
    // and the hash reports do get compared: a world nudged out of step is caught
    b.world.hp[b.world.alive.indexOf(1)] -= 1;
    for (let f = 0; f < 3 * 60; f++) {
      clock.now += FRAME;
      seq.update();
      for (const n of nets) {
        n.update(FRAME / 1000);
        tidy(n.world);
      }
    }
    expect(desyncs.length).toBeGreaterThan(0);
  });

  it('a frozen client catches up, and both apply its seat’s bot at the same tick', () => {
    const s = setup([0, 2]);
    const { clock, seq, nets, desyncs } = table(s, [0, 2], { awayMs: 1000, botMs: 2000 }, { stepCostMs: 1 });
    const [a, b] = nets;
    const run = (ms: number, frozen: NetSession | null) => {
      for (const end = clock.now + ms; clock.now < end; ) {
        clock.now += FRAME;
        seq.update();
        for (const n of nets) {
          if (n === frozen) continue;
          n.update(FRAME / 1000);
          tidy(n.world);
        }
      }
    };
    run(3000, null);
    const stalled = a.stallMs;
    run(4000, b);
    expect(a.stallMs - stalled).toBeLessThan(50); // nobody waits for b
    expect(seq.seatState(2)).toBe('bot');
    expect(b.buffered).toBeGreaterThan(100);
    run(1500, null);
    expect(b.caughtUp).toBeGreaterThan(100);
    expect(b.buffered).toBeLessThanOrEqual(b.target + 1);
    expect(seq.seatState(2)).toBe('bot'); // heard again, but the bot keeps the seat until reclaimed
    run(2000, null);
    expect(desyncs).toEqual([]);
    const seatCtrl = (n: NetSession) => n.ctrlLog.filter((c) => c.ctrl.k === 'seat');
    expect(seatCtrl(a).map((c) => [c.ctrl.k === 'seat' && c.ctrl.state])).toEqual([['away'], ['bot']]);
    expect(seatCtrl(b)).toEqual(seatCtrl(a));
    expect(seatHasBot(a.world, 2) && seatHasBot(b.world, 2)).toBe(true);
    // reclaimed: the bot leaves on every client at the same tick
    b.reclaim();
    run(1000, null);
    expect(seq.seatState(2)).toBe('human');
    expect(seatHasBot(a.world, 2) || seatHasBot(b.world, 2)).toBe(false);
    expect(seatCtrl(b)).toEqual(seatCtrl(a));
  });

  it('pauses and resumes through the sequencer', () => {
    const s = setup([0, 2]);
    const { clock, seq, nets } = table(s, [0, 2], { resumeMs: 2000 });
    const run = (ms: number) => {
      for (const end = clock.now + ms; clock.now < end; ) {
        clock.now += FRAME;
        seq.update();
        for (const n of nets) n.update(FRAME / 1000);
      }
    };
    run(2000);
    nets[1].setPaused(true);
    expect(nets[1].paused).toBe(false); // not until the sequencer's turn says so
    run(1000);
    const t = nets[0].world.tick;
    expect(nets.every((n) => n.paused)).toBe(true);
    expect(nets[0].status).toMatchObject({ paused: true, by: 2 });
    run(3000);
    expect(nets[0].world.tick).toBe(t);
    nets[0].setPaused(false);
    run(2500);
    expect(nets.every((n) => !n.paused)).toBe(true);
    run(1000);
    expect(nets[0].world.tick).toBeGreaterThan(t + 20);
    expect(nets.every((n) => n.stallMs < 100)).toBe(true);
  });
});
