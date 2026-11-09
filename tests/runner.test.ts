import { describe, expect, it } from 'vitest';
import { epochFor, rankByLinks, rankOf, runnerScore, worthMoving, type MatchPeer, type NetMatch, type RttOf } from '../src/net/match';
import { nudgeWorld } from '../src/net/desync';
import { play } from './rig';

/**
 * Who runs the match (#190): the sequencer moves to the best-placed player
 * by measured round trips, every peer ranks the same way, and the match's
 * host keeps pause, resync and the rest wherever it runs.
 */

const peer = (seat: number, o: Partial<MatchPeer> = {}): MatchPeer => ({ seat, team: seat, peer: `p${seat}`, mobile: false, ...o });

/** a symmetric table from pairs: "0-1": 40 */
const table =
  (t: Record<string, number>): RttOf =>
  (a, b) =>
    t[`${a}-${b}`] ?? t[`${b}-${a}`];

/** every peer's view of the ranking, and the hashes they reported per tick */
function views(matches: Map<string, NetMatch>) {
  return [...matches.values()].map((m) => m.ranking.join(','));
}

function hashes(matches: Map<string, NetMatch>) {
  const by = new Map<string, Map<number, number>>();
  for (const [id, m] of matches) {
    const mine = new Map<number, number>();
    by.set(id, mine);
    m.session.onHash = (t, h) => mine.set(t, h);
  }
  return () => {
    const maps = [...by.values()];
    const common = [...maps[0].keys()].filter((t) => maps.every((x) => x.has(t)));
    return { common: common.length, bad: common.filter((t) => new Set(maps.map((x) => x.get(t))).size > 1).length };
  };
}

/** H is far from A, a little less far from B and C; A, B and C are close to each other. B or C should run it. */
function uneven(o: { runner?: string } = {}) {
  const r = play({ guests: ['A', 'B', 'C'], bot: false, ...o });
  r.lag('H', 'A', 300);
  r.lag('H', 'B', 200);
  r.lag('H', 'C', 200);
  for (const [a, b] of [
    ['A', 'B'],
    ['A', 'C'],
    ['B', 'C'],
  ])
    r.lag(a, b, 40);
  return r;
}

describe('ranking by links (#190)', () => {
  it('scores a runner by the worst round trip it gives anyone, plus a phone or mobile data', () => {
    const peers = [peer(0), peer(1), peer(2, { mobile: true }), peer(3, { cell: true })];
    const rtt = table({ '0-1': 50, '0-2': 120, '0-3': 80, '1-2': 30, '1-3': 40, '2-3': 60 });
    expect(runnerScore(peers[0], peers, rtt)).toBe(120);
    expect(runnerScore(peers[1], peers, rtt)).toBe(50);
    expect(runnerScore(peers[2], peers, rtt)).toBe(120 + 60);
    expect(runnerScore(peers[3], peers, rtt)).toBe(80 + 60);
    // a link nobody measured counts as bad
    expect(runnerScore(peers[0], peers, () => undefined)).toBeGreaterThanOrEqual(1000);
    expect(rankByLinks(peers, rtt, null)).toEqual([1, 0, 3, 2]);
  });

  it('keeps its order for near-equal links, and puts a pinned seat first', () => {
    const peers = [peer(0), peer(1), peer(2)];
    // within a 10 ms step of each other: the order before stands
    const near = table({ '0-1': 41, '0-2': 44, '1-2': 38 });
    expect(rankByLinks(peers, near, [2, 0, 1])).toEqual([2, 0, 1]);
    expect(rankByLinks(peers, near, [0, 1, 2])).toEqual([0, 1, 2]);
    expect(rankByLinks(peers, near, null, 1)).toEqual([1, 0, 2]);
    // seats the ranking doesn't name go after, in the default order
    expect(rankOf(peers, [2])).toEqual(['p2', 'p0', 'p1']);
  });

  it('moves only for a real gain', () => {
    expect(worthMoving(300, 200)).toBe(true);
    expect(worthMoving(60, 45)).toBe(false); // 15 ms: under the margin
    expect(worthMoving(400, 350)).toBe(false); // 12%: under the gain
    expect(worthMoving(400, 330)).toBe(true);
  });

  it('gives each seat its own takeover epoch, so two claimants never tie', () => {
    const e = new Set([0, 1, 2, 3, 4, 5].map((s) => epochFor(3, s)));
    expect(e.size).toBe(6);
    expect(Math.min(...e)).toBeGreaterThan(epochFor(2, 0));
  });
});

describe('the best-placed player runs the match (#190)', () => {
  it('moves the sequencer a few seconds in, every peer ranks the same way, and the worlds agree', () => {
    const { matches, run } = uneven();
    const agree = hashes(matches);
    const seatOf = (id: string) => matches.get(id)!.session.localSeat;
    run(2000);
    expect(matches.get('H')!.runner).toBe(true);
    run(10_000);
    expect(matches.get('B')!.runner).toBe(true);
    expect(matches.get('H')!.runner).toBe(false);
    for (const m of matches.values()) expect(m.runnerPeer).toBe('B');
    expect(new Set(views(matches)).size).toBe(1);
    expect(matches.get('B')!.ranking[0]).toBe(seatOf('B'));
    // whoever takes over next is the next best placed, not the next seat
    expect(matches.get('B')!.successorSeat()).toBe(seatOf('C'));
    const { common, bad } = agree();
    expect(common).toBeGreaterThan(5);
    expect(bad).toBe(0);
  });

  it('cuts the worst order delay', () => {
    const { matches, run } = uneven();
    run(15_000);
    const lat = matches.get('A')!.session.lat;
    const worst = Math.max(...lat.filter((r) => r.state === 'human').map((r) => r.rtt));
    // A is 300 ms from H, 40 ms from B
    expect(worst).toBeLessThan(250);
  });

  it('stays put when nobody is clearly better placed', () => {
    const r = play({ guests: ['A', 'B'], bot: false });
    r.lag('H', 'A', 50);
    r.lag('H', 'B', 60);
    r.lag('A', 'B', 45);
    r.run(20_000);
    expect(r.matches.get('H')!.runner).toBe(true);
    expect(new Set(views(r.matches)).size).toBe(1);
  });

  it('the host’s choice runs it, even when it isn’t the best placed; when they leave, the measured order takes over', () => {
    const { matches, run, quit, h } = uneven({ runner: 'A' });
    run(10_000);
    expect(matches.get('A')!.runner).toBe(true);
    expect(matches.get('H')!.host).toBe(true);
    quit('A');
    run(10_000);
    // B and C are best placed
    expect(['B', 'C'].some((id) => matches.get(id)!.runner)).toBe(true);
    expect(matches.get('H')!.host).toBe(true);
    expect(h.lobby.state.host).toBe('H');
  });

  it('a runner that vanishes is replaced by the best-ranked survivor', () => {
    const { matches, run, kill } = uneven();
    run(10_000);
    expect(matches.get('B')!.runner).toBe(true);
    kill('B');
    matches.delete('B');
    run(8000);
    expect(matches.get('C')!.runner).toBe(true);
    expect(matches.get('H')!.host).toBe(true);
  });
});

describe('the host keeps the controls (#190)', () => {
  it('pauses and resumes the match another player runs; that player can’t', () => {
    const { matches, run } = uneven();
    run(10_000);
    const h = matches.get('H')!, b = matches.get('B')!;
    expect(b.runner).toBe(true);
    expect(h.host).toBe(true);
    expect(b.host).toBe(false);
    b.session.setPaused(true);
    run(1000);
    for (const m of matches.values()) expect(m.session.paused).toBe(false);
    h.session.setPaused(true);
    run(1000);
    for (const m of matches.values()) expect(m.session.paused).toBe(true);
    h.session.setPaused(false);
    run(4000);
    for (const m of matches.values()) expect(m.session.paused).toBe(false);
  });

  it('asks the runner to resync after a desync', () => {
    const { matches, run } = uneven();
    run(10_000);
    const c = matches.get('C')!;
    const t0 = c.session.world.tick + 30;
    c.session.beforeStep = (t, w) => void (t === t0 && nudgeWorld(w));
    run(25_000);
    for (const m of matches.values()) expect(m.session.halted).toBeGreaterThan(0);
    const h = matches.get('H')!;
    // the runner has the report; the host only asks
    expect(h.runner).toBe(false);
    expect(h.requestResync()).toBe(false);
    const agree = hashes(matches);
    run(15_000);
    for (const m of matches.values()) {
      expect(m.session.halted).toBe(-1);
      expect(m.session.paused).toBe(false);
    }
    const { common, bad } = agree();
    expect(common).toBeGreaterThan(3);
    expect(bad).toBe(0);
  });

  it('when the host leaves, the runner becomes host', () => {
    const { matches, run, quit } = uneven();
    run(10_000);
    const b = matches.get('B')!;
    const owners: number[] = [];
    for (const id of ['A', 'C']) matches.get(id)!.events.onOwner = (seat) => owners.push(seat);
    quit('H');
    run(3000);
    expect(b.runner).toBe(true);
    expect(b.host).toBe(true);
    expect(owners).toEqual([b.session.localSeat, b.session.localSeat]);
    expect(matches.get('A')!.ownerSeat).toBe(b.session.localSeat);
    // and pauses for everyone
    b.session.setPaused(true);
    run(1000);
    for (const m of matches.values()) expect(m.session.paused).toBe(true);
  });

  it('a player who reloads gets back in through the host, and plays on with whoever runs it', () => {
    const { matches, run, reload } = uneven();
    run(10_000);
    expect(matches.get('B')!.runner).toBe(true);
    reload('A', 'A2');
    run(10_000);
    const a2 = matches.get('A2')!;
    expect(a2.session.syncing).toBe(false);
    expect(a2.runnerPeer).toBe('B');
    const agree = hashes(matches);
    run(5000);
    const { common, bad } = agree();
    expect(common).toBeGreaterThan(3);
    expect(bad).toBe(0);
  });
});
