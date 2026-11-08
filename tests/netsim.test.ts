import { describe, expect, it } from 'vitest';
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
    expect(r.hashTicks).toBeGreaterThanOrEqual(290);
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
