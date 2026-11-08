import { describe, expect, it } from 'vitest';
import { FakeNetwork, VirtualClock } from '../src/net/fakeTransport';
import { runNetMatch, type NetMatchReport } from '../src/net/harness';
import { DT, TICK_HZ } from '../src/sim/constants';
import type { MatchSetup } from '../src/sim/setup';

const TICK = DT * 1000;

/** `humans` seats on the given teams, the rest of 0..3 Normal bots, each on its own team. */
function table(humans: [seat: number, team: number][], seed = 7): MatchSetup {
  const players: MatchSetup['players'] = [];
  for (let f = 0; f < 4; f++) {
    const h = humans.find(([s]) => s === f);
    players.push(h ? { faction: f, team: h[1], human: true } : { faction: f, team: 10 + f, human: false, bot: { difficulty: 1, personality: 'expander' } });
  }
  return { seed, size: 'small', players };
}

/** No desync anywhere, everyone ends on the same world, and every order issued ran. */
function healthy(r: NetMatchReport): void {
  expect(r.desyncs).toEqual([]);
  expect(r.mismatches).toEqual([]);
  expect(r.finalAgree).toBe(true);
  for (const s of r.seats) {
    expect(s.ran).toBe(s.issued);
    expect(s.issued).toBeGreaterThan(0);
  }
}

describe('net-sim (#160)', () => {
  it('a 5-minute match, host plus 3 friends at 300 ± 80 ms with 2% loss: every hash matches', () => {
    const friend = { rtt: 300, jitter: 80, loss: 0.02 };
    const r = runNetMatch({
      setup: table([[0, 0], [1, 1], [2, 2], [3, 3]]),
      secs: 300,
      peers: [{ seat: 0, rtt: 0 }, { seat: 1, ...friend, skill: 0.8 }, { seat: 2, ...friend, skill: 0.6 }, { seat: 3, ...friend }],
    });
    healthy(r);
    expect(r.closed).toBe(300 * TICK_HZ);
    // every client hashed every 30th tick it reached (the match may be won before the 5 minutes are up)
    expect(r.seats[0].tick).toBeGreaterThan(200 * TICK_HZ);
    expect(r.hashTicks).toBe(Math.floor(r.seats[0].tick / 30));
    // a dropped turn now and then, but nobody waits for long
    for (const s of r.seats) expect(s.stallMs).toBeLessThan(10000);
    // an idle turn stream is cheap: a few hundred bytes a second
    expect(r.downBps).toBeLessThan(1000);
  }, 120_000);

  it('a peer frozen for 10 s stalls nobody else, then catches up', () => {
    const r = runNetMatch({
      setup: table([[0, 0], [1, 1], [2, 2]]),
      secs: 60,
      peers: [{ seat: 0, rtt: 0 }, { seat: 1, rtt: 150, jitter: 30, freeze: [[25_000, 35_000]] }, { seat: 2, rtt: 200, jitter: 40 }],
    });
    healthy(r);
    const [host, frozen, other] = r.seats;
    expect(host.stallMs).toBe(0);
    expect(other.stallMs).toBeLessThan(500);
    // 10 s behind is 300 turns, stepped back to back once it thaws
    expect(frozen.caughtUp).toBeGreaterThan(250);
    expect(frozen.tick).toBe(host.tick);
  }, 60_000);

  it('fair in PvP: the host waits as long as its 300 ms rival; fast in co-op', () => {
    const peers = [{ seat: 0, rtt: 0 }, { seat: 1, rtt: 300, jitter: 80 }];
    const pvp = runNetMatch({ setup: table([[0, 0], [1, 1]]), secs: 180, peers });
    healthy(pvp);
    const [host, friend] = pvp.seats;
    expect(Math.abs(host.effect.p50 - friend.effect.p50)).toBeLessThanOrEqual(TICK + 1);

    const coop = runNetMatch({ setup: table([[0, 0], [1, 0]]), secs: 120, peers });
    healthy(coop);
    // the host's own orders: D + its buffer, about 4 ticks
    expect(coop.seats[0].effect.p50).toBeLessThan(6 * TICK);
    expect(coop.seats[1].effect.p50).toBeGreaterThan(300);
  }, 60_000);

  it('refuses a seat that is not a human player in the match', () => {
    const s = table([[0, 0]]);
    expect(() => runNetMatch({ setup: s, secs: 1, peers: [{ seat: 0, rtt: 0 }, { seat: 1, rtt: 50 }] })).toThrow(/bot/);
    expect(() => runNetMatch({ setup: s, secs: 1, peers: [{ seat: 7, rtt: 50 }] })).toThrow(/not in the match/);
  });

  it('a hostile link (loss, duplicates, reordering) still converges', () => {
    const bad = { mode: 'hostile' as const, rtt: 180, jitter: 120, loss: 0.05, dup: 0.05 };
    const r = runNetMatch({
      setup: table([[0, 0], [1, 1], [2, 2]]),
      secs: 60,
      peers: [{ seat: 0, rtt: 0 }, { seat: 1, ...bad }, { seat: 2, ...bad, skill: 0.5 }],
      seed: 4,
    });
    healthy(r);
  }, 60_000);
});

describe('FakeNetwork', () => {
  /** a and b on one link; returns what b received, as [time, byte] */
  function pair(spec: Parameters<FakeNetwork['link']>[2]) {
    const clock = new VirtualClock();
    const net = new FakeNetwork(clock, 1);
    net.link('a', 'b', spec);
    const a = net.transport('a');
    const b = net.transport('b');
    const got: [number, number][] = [];
    b.onMessage = (_p, bytes) => got.push([clock.now, bytes[0]]);
    return { clock, net, a, b, got };
  }

  it('runs events in time order, ties in the order they were scheduled', () => {
    const clock = new VirtualClock();
    const out: number[] = [];
    for (const [t, v] of [[30, 3], [10, 1], [30, 4], [20, 2], [10, 9], [0, 0]]) clock.at(t, () => out.push(v));
    clock.advance(25);
    expect(out).toEqual([0, 1, 9, 2]);
    clock.at(5, () => out.push(5)); // already past: runs at the next advance
    clock.advance(10);
    expect(out).toEqual([0, 1, 9, 2, 5, 3, 4]);
  });

  it('a thawed peer gets what waited first, even a message due right at the thaw', () => {
    const clock = new VirtualClock();
    const net = new FakeNetwork(clock, 1);
    net.link('slow', 'b', { latency: 200 });
    net.link('fast', 'b', { latency: 50 });
    const slow = net.transport('slow');
    const fast = net.transport('fast');
    const b = net.transport('b');
    const got: [number, string][] = [];
    b.onMessage = (p, _bytes) => got.push([clock.now, p]);
    net.freeze('b', 200);
    // scheduled for 200 before the thaw is (the thaw is set when fast's message reaches b at 50)
    slow.send('b', new Uint8Array([1]));
    fast.send('b', new Uint8Array([2]));
    clock.advanceTo(300);
    expect(got).toEqual([[200, 'fast'], [200, 'slow']]);
  });

  it('a freeze extended while messages wait holds them until the new end', () => {
    const { clock, net, a, got } = pair({ latency: 10 });
    net.freeze('b', 100);
    a.send('b', new Uint8Array([1]));
    clock.advanceTo(50);
    net.freeze('b', 300);
    clock.advanceTo(200);
    expect(got).toEqual([]);
    clock.advanceTo(400);
    expect(got).toEqual([[300, 1]]);
  });

  it('reliable traffic sent during a partition waits for it to end, across back-to-back cuts', () => {
    const { clock, net, a, got } = pair({ latency: 300 });
    net.partition('a', 'b', 2400, 3000);
    net.partition('a', 'b', 1000, 2000);
    clock.advanceTo(1500);
    a.send('b', new Uint8Array([7]));
    clock.advanceTo(10_000);
    // sent mid-cut: leaves when it ends at 2000, lands at 2300, between the cuts
    expect(got).toEqual([[2300, 7]]);

    const r = pair({ latency: 600 });
    r.net.partition('a', 'b', 2400, 3000);
    r.net.partition('a', 'b', 1000, 2000);
    r.clock.advanceTo(1500);
    r.a.send('b', new Uint8Array([8]));
    r.clock.advanceTo(10_000);
    // leaves at 2000, would land at 2600 inside the later cut: retransmitted past it
    expect(r.got[0][0]).toBeGreaterThanOrEqual(3000);
  });

  it('a dead link (loss 1) delivers nothing and does not hang', () => {
    for (const mode of ['reliable', 'hostile'] as const) {
      const { clock, a, got } = pair({ latency: 10, loss: 1, mode });
      a.send('b', new Uint8Array([1]));
      clock.advanceTo(1000);
      expect(got).toEqual([]);
    }
  });

  it('a link with no delay delivers at once, behind anything still on its way', () => {
    const z = pair({ latency: 0 });
    z.a.send('b', new Uint8Array([1]));
    expect(z.got).toEqual([[0, 1]]); // no advance needed
    const j = pair({ latency: 0, jitter: 40 });
    j.clock.advanceTo(100);
    for (let i = 0; i < 20; i++) j.a.send('b', new Uint8Array([i]));
    j.clock.advanceTo(1000);
    expect(j.got.map(([, v]) => v)).toEqual([...Array(20).keys()]);
  });

  it('a reopened peer gets nothing meant for the old one, and starts unfrozen', () => {
    const { clock, net, a, b } = pair({ latency: 100 });
    net.freeze('b', 500);
    a.send('b', new Uint8Array([1])); // waits for the thaw
    clock.advanceTo(50);
    a.send('b', new Uint8Array([2])); // still on its way
    clock.advanceTo(200);
    b.close();
    const b2 = net.transport('b');
    const got: number[] = [];
    b2.onMessage = (_p, bytes) => got.push(bytes[0]);
    expect(net.isFrozen('b')).toBe(false);
    a.send('b', new Uint8Array([3]));
    clock.advanceTo(1000);
    expect(got).toEqual([3]);
  });

  it('refuses duplicates on a reliable link', () => {
    expect(() => pair({ latency: 10, dup: 0.1 })).toThrow(/hostile/);
  });

  it('announces a new peer to the ones already there', () => {
    const net = new FakeNetwork(new VirtualClock());
    const a = net.transport('a');
    const seen: [string, boolean][] = [];
    a.onPeer = (p, up) => seen.push([p, up]);
    const b = net.transport('b');
    b.close();
    expect(seen).toEqual([['b', true], ['b', false]]);
  });
});
