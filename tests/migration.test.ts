import { describe, expect, it } from 'vitest';
import { HostLobby, type StartInfo } from '../src/net/lobby';
import { epochFor, rankOf, type NetMatch } from '../src/net/match';
import { rebuildState } from '../src/net/sequencer';
import { LOBBY_KINDS } from '../src/net/transport';
import { DT } from '../src/sim/constants';
import { play, prefs } from './rig';

/** Every hash each peer reports from now on, by tick, and the longest wait each saw between new turns. */
function watch(matches: Map<string, NetMatch>, clock: { now: number }) {
  const hashes = new Map<string, Map<number, number>>();
  const gap = new Map<string, number>();
  for (const [id, m] of matches) {
    const mine = new Map<number, number>();
    hashes.set(id, mine);
    m.session.onHash = (t, h) => mine.set(t, h);
    let last = clock.now, worst = 0;
    let tick = m.session.world.tick;
    gap.set(id, 0);
    m.session.beforeStep = (t) => {
      if (t <= tick) return;
      tick = t;
      worst = Math.max(worst, clock.now - last);
      last = clock.now;
      gap.set(id, worst);
    };
  }
  /** among these peers: ticks all reported, and those where they disagreed */
  const agree = (ids: string[]) => {
    const maps = ids.map((id) => hashes.get(id)!);
    const common = [...maps[0].keys()].filter((t) => maps.every((x) => x.has(t)));
    return { common: common.length, bad: common.filter((t) => new Set(maps.map((x) => x.get(t))).size > 1) };
  };
  return { agree, gap };
}

/** Orders a seat gave that never ran, after everything in flight has had time to land. */
function unrun(m: NetMatch): number {
  const s = m.session;
  const mine = s.log.filter((e) => e.cmd.p === s.localSeat).length;
  return s.issued - mine - s.queued;
}

describe('who takes over (#166)', () => {
  it('ranks desktop before phone, then seat; epochs put the round first and the best rank highest', () => {
    const peers = [
      { seat: 3, team: 3, peer: 'c', mobile: false },
      { seat: 1, team: 1, peer: 'a', mobile: true },
      { seat: 2, team: 2, peer: 'b', mobile: false },
    ];
    expect(rankOf(peers)).toEqual(['b', 'c', 'a']);
    expect(epochFor(1, 0)).toBeGreaterThan(epochFor(1, 1));
    expect(epochFor(2, 5)).toBeGreaterThan(epochFor(1, 0));
    expect(epochFor(1, 0)).toBeGreaterThan(0);
  });

  it('a state rebuilt from the turn log matches the live sequencer’s', () => {
    const { matches, run, orders } = play();
    run(20_000);
    orders(false);
    run(3000); // nothing pending: every order taken is in a closed turn
    const seq = matches.get('H')!.seq!;
    const live = seq.exportState();
    const seats = live.seats.map((r) => ({ seat: r.seat, team: r.team, peer: r.peer }));
    const built = rebuildState({ epoch: live.epoch, next: live.next, seats, history: seq.closedTurns() });
    expect(built.next).toBe(live.next);
    expect(live.pending).toEqual([]);
    for (const r of live.seats) {
      const b = built.seats.find((x) => x.seat === r.seat)!;
      expect(b.highSeq).toBe(r.highSeq);
      expect(new Set(b.seen)).toEqual(new Set(r.seen.filter((s) => s > r.highSeq - 512)));
      expect(b.state).toBe(r.state);
      expect(b.peer).toBe(r.peer);
    }
    expect(built.pause).toEqual(live.pause);
  });
});

describe('hosting moves (#166)', () => {
  it('graceful: the host leaves, the next player carries on from its state, and nobody waits', () => {
    const { matches, run, clock, leave } = play();
    run(20_000);
    const { agree, gap } = watch(matches, clock);
    const seatA = matches.get('A')!.session.localSeat;
    const leaders: number[] = [];
    matches.get('B')!.events.onLeader = (seat) => leaders.push(seat);
    const h = matches.get('H')!;
    expect(h.handOff()).toBe(true);
    matches.delete('H');
    run(150);
    h.close();
    leave('H');
    run(15_000);
    expect(matches.get('A')!.host).toBe(true);
    expect(leaders).toEqual([seatA]);
    // a turn every tick, as if nothing happened
    expect(gap.get('B')!).toBeLessThan(250);
    expect(gap.get('A')!).toBeLessThan(250);
    const { common, bad } = agree(['A', 'B']);
    expect(common).toBeGreaterThan(10);
    expect(bad).toEqual([]);
    for (const m of matches.values()) expect(m.session.paused).toBe(false);
  });

  it('ungraceful: the host vanishes, the players notice within seconds, elect one, and lose no orders', () => {
    const { matches, run, clock, kill, orders } = play();
    run(20_000);
    const { agree, gap } = watch(matches, clock);
    const lost: string[] = [];
    for (const id of ['A', 'B']) matches.get(id)!.session.onReject = (_s, why) => why === 'lost' && lost.push(id);
    const epoch0 = matches.get('A')!.session.currentEpoch;
    kill('H');
    run(15_000);
    orders(false);
    run(5000);
    expect(matches.get('A')!.host).toBe(true);
    expect(matches.get('B')!.session.currentEpoch).toBeGreaterThan(epoch0);
    expect(gap.get('B')!).toBeLessThan(2500);
    const { common, bad } = agree(['A', 'B']);
    expect(common).toBeGreaterThan(10);
    expect(bad).toEqual([]);
    expect(lost).toEqual([]);
    for (const id of ['A', 'B']) expect(unrun(matches.get(id)!)).toBe(0);
  });

  it('a partition: the cut-off side elects, the host on its own steps down when it hears, and resyncs once', () => {
    const { matches, run, clock, silence, heal } = play({ guests: ['A', 'B', 'C'], bot: false });
    run(15_000);
    let resyncs = 0;
    matches.get('H')!.session.onAdopt = () => resyncs++;
    silence('H', 'A');
    silence('H', 'B');
    run(10_000);
    // A and B miss the host, C still hears it: a majority of the rest, so A leads, and C goes with it
    expect(matches.get('A')!.host).toBe(true);
    expect(matches.get('C')!.session.leader).toBe(matches.get('A')!.session.leader);
    heal('H', 'A');
    heal('H', 'B');
    run(10_000);
    expect(matches.get('H')!.host).toBe(false);
    expect(resyncs).toBe(1);
    // from here on (the stretch H played alone was replaced by the resync), all four agree
    const { agree } = watch(matches, clock);
    run(10_000);
    const { common, bad } = agree(['H', 'A', 'B', 'C']);
    expect(common).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('chained: the host vanishes, then the new one leaves too; the third carries on', () => {
    const { matches, run, kill, leave } = play();
    run(10_000);
    kill('H');
    run(8000);
    expect(matches.get('A')!.host).toBe(true);
    const a = matches.get('A')!;
    expect(a.handOff()).toBe(true);
    matches.delete('A');
    run(150);
    a.close();
    leave('A');
    run(8000);
    const b = matches.get('B')!;
    expect(b.host).toBe(true);
    expect(Math.floor(b.session.currentEpoch / 8)).toBe(2);
    const t = b.session.world.tick;
    run(3000);
    expect(b.session.world.tick).toBeGreaterThan(t + 2 / DT);
  });

  it('two players: the one left hosts itself and plays on against the other’s Easy bot', () => {
    const { matches, run, kill } = play({ guests: ['A'], botSecs: 30 });
    run(10_000);
    const seatH = matches.get('H')!.session.localSeat;
    const seen: [number, string][] = [];
    matches.get('A')!.events.onSeat = (seat, state) => seen.push([seat, state]);
    kill('H');
    run(40_000);
    expect(matches.get('A')!.host).toBe(true);
    expect(seen).toEqual([
      [seatH, 'away'],
      [seatH, 'bot'],
    ]);
  });

  it('a phone takes over last: with A on a phone, B hosts next', () => {
    const { matches, run, kill } = play({ mobile: ['A'] });
    run(10_000);
    kill('H');
    run(8000);
    expect(matches.get('B')!.host).toBe(true);
    expect(matches.get('A')!.host).toBe(false);
    expect(matches.get('A')!.leaderSeat).toBe(matches.get('B')!.session.localSeat);
  });

  it('the room moves with hosting: the new host ends the match, everyone is back in its lobby, and it starts the next one', () => {
    const { matches, run, gs, leave } = play();
    run(10_000);
    const host = matches.get('H')!;
    expect(host.handOff()).toBe(true);
    matches.delete('H');
    run(150);
    host.close();
    leave('H');
    run(3000);
    const [a, b] = gs;
    expect(matches.get('A')!.host).toBe(true);
    // what main.ts does on `onLeader`: A runs the room from its last state, B follows A's lobby
    a.lobby.close();
    const room = new HostLobby(a.r.view(LOBBY_KINDS), {
      build: 'test',
      char: 0,
      prefs: prefs(),
      seed: a.lobby.state!.seed,
      clock: () => 0,
      takeOver: { state: a.lobby.state!, connected: matches.get('A')!.livePeers() },
    });
    b.lobby.follow('A');
    room.announce();
    expect(b.lobby.state!.host).toBe('A');
    // End match: back to the lobby; the old host's seat opens up
    room.backToLobby();
    expect(b.lobby.state!.phase).toBe('lobby');
    expect(room.state.rows.some((r) => r.k === 'human' && r.peer === 'H')).toBe(false);
    room.setMap({ size: 'medium' });
    const starts: StartInfo[] = [];
    b.lobby.onStart = (s) => starts.push(s);
    const setup = room.start()!;
    expect(setup.size).toBe('medium');
    expect(starts.length).toBe(1);
    expect(starts[0].host).toBe('A');
  });
});
