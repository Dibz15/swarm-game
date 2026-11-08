import { describe, expect, it } from 'vitest';
import type { Msg, Turn } from '../src/net/protocol';
import { Sequencer, type SequencerConfig, type SequencerOptions } from '../src/net/sequencer';
import type { Command } from '../src/sim/commands';
import { DT } from '../src/sim/constants';

const TICK = DT * 1000;
const LIMITS = { width: 1000, height: 800, nests: { length: 10 }, endless: false };

/** A sequencer on a fake clock, with every message it sends kept per peer. */
function rig(opts: Partial<SequencerOptions> = {}, teams: [number, number] = [0, 0], extra: Partial<SequencerConfig> = {}, start = 0) {
  const clock = { now: start };
  const inbox = new Map<string, Msg[]>([['a', []], ['b', []]]);
  const seq = new Sequencer({
    limits: LIMITS,
    seats: [{ seat: 0, team: teams[0], peer: 'a' }, { seat: 1, team: teams[1], peer: 'b' }],
    clock: () => clock.now,
    send: (peer, m) => inbox.get(peer)?.push(m),
    opts,
    ...extra,
  });
  const turns = new Map<number, Turn>();
  seq.onTurn = (t, turn) => turns.set(t, turn);
  /** move time on by ms, a frame at a time, keeping both peers heard from unless told otherwise */
  const advance = (ms: number, quiet: string[] = []) => {
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + 16);
      for (const p of ['a', 'b']) if (!quiet.includes(p) && clock.now % 1000 < 16) seq.onMessage(p, { k: 'ping', t: clock.now });
      seq.update();
    }
  };
  return { seq, clock, inbox, turns, advance };
}

const move = (x: number, p = 0): Command => ({ t: 'move', p, units: [1, 2], x, y: 5, nest: -1 });
const ctrlOf = (turns: Map<number, Turn>) => [...turns].flatMap(([t, turn]) => (turn.ctrl ?? []).map((c) => ({ t, ...c })));

describe('Sequencer (#158)', () => {
  it('closes a turn every tick, empty or not, and never waits for anyone', () => {
    const { seq, clock, inbox, turns } = rig();
    clock.now = 10 * TICK + 1;
    seq.update();
    expect([...turns.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...turns.values()].every((t) => t.entries.length === 0 && !t.ctrl)).toBe(true);
    const sent = inbox.get('b')!.filter((m) => m.k === 'turns');
    expect(sent.map((m) => m.k === 'turns' && m.first)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // a stalled host catches up in one go when it runs again
    clock.now = 40 * TICK + 1;
    seq.update();
    expect(seq.closed).toBe(40);
  });

  it('binds p to the sender, keeps arrival order, and schedules S + D', () => {
    const { seq, clock, turns } = rig({ dMin: 2 });
    clock.now = 4 * TICK + 1;
    seq.update(); // turns 1..4 closed: 5 is open
    seq.onMessage('a', { k: 'cmd', seq: 1, cmd: move(10, 5) }); // claims faction 5
    seq.onMessage('b', { k: 'cmd', seq: 1, cmd: move(20, 0) }); // claims faction 0
    seq.onMessage('a', { k: 'cmd', seq: 2, cmd: move(30, -1) });
    clock.now = 8 * TICK + 1;
    seq.update();
    expect(turns.get(5)!.entries).toEqual([]);
    expect(turns.get(7)!.entries.map((e) => [e.seat, e.seq, e.cmd.p, (e.cmd as { x: number }).x])).toEqual([
      [0, 1, 0, 10],
      [1, 1, 1, 20],
      [0, 2, 0, 30],
    ]);
  });

  it('drops duplicates, throttled bursts, bad commands, and commands from seats it does not drive', () => {
    const { seq, clock, turns } = rig({ dMin: 0 });
    for (const s of [1, 2, 2, 1, 3]) seq.onMessage('a', { k: 'cmd', seq: s, cmd: move(s) });
    expect(seq.dropped.dup).toBe(2);
    seq.onMessage('a', { k: 'cmd', seq: 4, cmd: { t: 'move', p: 0, units: [1], x: NaN, y: 1, nest: 0 } });
    seq.onMessage('a', { k: 'cmd', seq: 5, cmd: { t: 'summon', p: 0, secs: 3 } }); // not an endless world
    expect(seq.dropped.invalid).toBe(2);
    seq.onMessage('x', { k: 'cmd', seq: 1, cmd: move(1) }); // no such peer
    // 60 tokens a seat: 5 spent above, 55 more get in, the rest wait
    for (let s = 10; s < 110; s++) seq.onMessage('b', { k: 'cmd', seq: s, cmd: move(s) });
    for (let s = 10; s < 70; s++) seq.onMessage('a', { k: 'cmd', seq: s, cmd: move(s) });
    expect(seq.dropped.rate).toBe(40 + 5);
    clock.now = 1000;
    seq.update();
    // a second later 30 more fit, and a throttled seq can be resent
    for (let s = 65; s < 100; s++) seq.onMessage('a', { k: 'cmd', seq: s, cmd: move(s) });
    expect(seq.dropped.rate).toBe(45 + 5);
    clock.now = 2000;
    seq.update();
    const all = [...turns.values()].flatMap((t) => t.entries);
    expect(all.filter((e) => e.seat === 0).length).toBe(3 + 55 + 30);
    expect(all.filter((e) => e.seat === 1).length).toBe(60);
    // every entry passed sanitize and kept its seat
    expect(all.every((e) => e.cmd.p === e.seat)).toBe(true);
  });

  it('co-op: every seat gets dMin, whatever its latency', () => {
    const { seq, advance } = rig({ dMin: 2 }, [0, 0]);
    seq.onMessage('b', { k: 'ack', tick: 0, seq: 0, rtt: 400, buffer: 6 });
    advance(5000);
    expect([seq.delayOf(0), seq.delayOf(1)]).toEqual([2, 2]);
  });

  it('PvP: holds the faster seat so both humans wait about the same, one tick at a time, capped', () => {
    const { seq, advance } = rig({ dMin: 2, dStepMs: 500 }, [0, 1]);
    const ack = (rttA: number, rttB: number) => {
      seq.onMessage('a', { k: 'ack', tick: seq.closed, seq: 0, rtt: rttA, buffer: 2 });
      seq.onMessage('b', { k: 'ack', tick: seq.closed, seq: 0, rtt: rttB, buffer: 4 });
    };
    ack(0, 300);
    advance(600);
    expect(seq.delayOf(0)).toBe(3); // moving, one tick per 500 ms
    advance(6000);
    // host: 0 + 2 buffered ticks; remote: 300 ms + 4 ticks. Totals within a tick.
    const total = (rtt: number, buffer: number, d: number) => rtt + (buffer + d) * TICK;
    expect(seq.delayOf(1)).toBe(2);
    expect(seq.delayOf(0)).toBe(13);
    expect(Math.abs(total(0, 2, seq.delayOf(0)) - total(300, 4, seq.delayOf(1)))).toBeLessThan(TICK);
    ack(0, 3000);
    advance(10000);
    expect(seq.delayOf(0)).toBe(15); // dMax
  });

  it('keeps a seat in order when its delay drops', () => {
    const { seq, clock, turns } = rig({ dMin: 2, dStepMs: 0 }, [0, 1]);
    seq.onMessage('a', { k: 'ack', tick: 0, seq: 0, rtt: 0, buffer: 2 });
    seq.onMessage('b', { k: 'ack', tick: 0, seq: 0, rtt: 600, buffer: 2 });
    seq.update();
    seq.update();
    seq.update();
    const high = seq.delayOf(0);
    expect(high).toBeGreaterThan(4);
    seq.onMessage('a', { k: 'cmd', seq: 1, cmd: move(1) });
    seq.onMessage('b', { k: 'ack', tick: 0, seq: 0, rtt: 0, buffer: 2 });
    for (let i = 0; i < 20; i++) seq.update();
    expect(seq.delayOf(0)).toBe(2);
    seq.onMessage('a', { k: 'cmd', seq: 2, cmd: move(2) });
    clock.now = 40 * TICK;
    seq.update();
    const at = (s: number) => [...turns].find(([, t]) => t.entries.some((e) => e.seq === s))![0];
    expect(at(1)).toBe(1 + high);
    expect(at(2)).toBeGreaterThanOrEqual(at(1));
  });

  it('pauses after the open turn, resumes after a countdown, and counts each seat’s allowance', () => {
    const { seq, clock, inbox, turns, advance } = rig({ resumeMs: 3000, pauses: 2 });
    advance(200);
    seq.onMessage('a', { k: 'pause', on: true });
    const pausedAt = seq.next;
    advance(5000);
    expect(seq.closed).toBe(pausedAt); // the turn carrying the pause closed, then nothing
    expect(turns.get(pausedAt)!.ctrl).toEqual([{ k: 'pause', seat: 0 }]);
    expect(inbox.get('b')!.some((m) => m.k === 'status' && m.paused && m.by === 0 && m.resumeIn === -1)).toBe(true);
    seq.onMessage('b', { k: 'pause', on: false }); // anyone may resume
    const resumeAt = clock.now + 3000;
    advance(1500);
    expect(seq.closed).toBe(pausedAt);
    expect(inbox.get('a')!.some((m) => m.k === 'status' && m.paused && m.resumeIn > 0 && m.resumeIn <= 3000)).toBe(true);
    advance(1600);
    expect(seq.paused).toBe(false);
    expect(turns.get(pausedAt + 1)!.ctrl).toEqual([{ k: 'resume', seat: 0 }]);
    // the clock picked up where it stopped: one turn per tick since play resumed
    expect(seq.closed - pausedAt).toBe(Math.floor((clock.now - resumeAt) / TICK));
    // two pauses each: the third from seat 0 is ignored
    seq.onMessage('a', { k: 'pause', on: true });
    advance(100);
    seq.onMessage('a', { k: 'pause', on: false });
    advance(3500);
    seq.onMessage('a', { k: 'pause', on: true });
    advance(500);
    expect(seq.paused).toBe(false);
    expect(ctrlOf(turns).filter((c) => c.k === 'pause').length).toBe(2);
  });

  it('resumes by itself when the pauser’s pause time runs out', () => {
    const { seq, advance } = rig({ pauseMs: 4000, resumeMs: 1000 });
    advance(100);
    seq.onMessage('b', { k: 'pause', on: true });
    advance(4500);
    expect(seq.paused).toBe(true);
    advance(1000);
    expect(seq.paused).toBe(false);
  });

  it('a silent seat goes away, then an Easy bot takes it, and its player can reclaim it', () => {
    const { seq, turns, advance } = rig({ awayMs: 5000, botMs: 60000 });
    advance(6000, ['b']);
    expect(seq.seatState(1)).toBe('away');
    advance(61000, ['b']);
    expect(seq.seatState(1)).toBe('bot');
    // seat 1 heard again: with a bot in its seat it stays a bot, and its commands are ignored
    seq.onMessage('b', { k: 'cmd', seq: 1, cmd: move(1) });
    expect(seq.seatState(1)).toBe('bot');
    expect(seq.dropped.seat).toBe(1);
    seq.onMessage('b', { k: 'reclaim' });
    advance(100);
    expect(seq.seatState(1)).toBe('human');
    expect(ctrlOf(turns).map((c) => (c.k === 'seat' ? [c.seat, c.state, c.bot?.difficulty] : c.k))).toEqual([
      [1, 'away', undefined],
      [1, 'bot', 0],
      [1, 'human', undefined],
    ]);
    // away comes back to human as soon as the peer is heard
    advance(6000, ['a']);
    expect(seq.seatState(0)).toBe('away');
    seq.onMessage('a', { k: 'ping', t: 0 });
    expect(seq.seatState(0)).toBe('human');
    // and a lost connection goes away at once
    seq.peerLost('a');
    expect(seq.seatState(0)).toBe('away');
  });

  it('flags clients that disagree about a tick', () => {
    const { seq, clock } = rig();
    const desyncs: [number, number[]][] = [];
    seq.onDesync = (t, m) => desyncs.push([t, [...m.values()]]);
    clock.now = 100 * TICK;
    seq.update();
    seq.onMessage('a', { k: 'hash', tick: 30, hash: 111 });
    seq.onMessage('b', { k: 'hash', tick: 30, hash: 111 });
    seq.onMessage('a', { k: 'hash', tick: 60, hash: 5 });
    seq.onMessage('b', { k: 'hash', tick: 60, hash: 6 });
    expect(desyncs).toEqual([[60, [5, 6]]]);
  });

  it('resends what a client asks for, in batches', () => {
    const { seq, clock, inbox } = rig();
    clock.now = 200 * TICK;
    seq.update();
    inbox.get('b')!.length = 0;
    seq.onMessage('b', { k: 'ack', tick: 1, seq: 0, rtt: 50, buffer: 2, want: [2, 150] });
    const got = inbox.get('b')!.flatMap((m) => (m.k === 'turns' ? [[m.first, m.list.length]] : []));
    expect(got).toEqual([[2, 64], [66, 64], [130, 21]]);
  });

  it('a successor carries on from exported state exactly as the original would', () => {
    const a = rig({ dMin: 3 }, [0, 1]);
    a.seq.onMessage('b', { k: 'ack', tick: 0, seq: 0, rtt: 200, buffer: 3 });
    a.advance(2000);
    a.seq.onMessage('a', { k: 'cmd', seq: 1, cmd: move(1) });
    a.seq.onMessage('b', { k: 'cmd', seq: 1, cmd: move(2) });
    a.seq.onMessage('a', { k: 'pause', on: true });
    const state = a.seq.exportState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state); // plain data
    // a successor started at the same moment closes the open turn when a would
    const b = rig({ dMin: 3 }, [0, 1], { resume: { state, history: a.seq.closedTurns() }, epoch: a.seq.epoch }, a.clock.now);
    expect(b.seq.next).toBe(a.seq.next);
    const script = (r: typeof a) => {
      r.seq.onMessage('a', { k: 'cmd', seq: 1, cmd: move(9) }); // a dupe
      r.advance(1000);
      r.seq.onMessage('b', { k: 'pause', on: false });
      r.advance(4000);
      r.seq.onMessage('a', { k: 'cmd', seq: 2, cmd: move(3) });
      r.advance(1000);
    };
    a.turns.clear();
    script(a);
    script(b);
    expect([...b.turns]).toEqual([...a.turns]);
    expect(b.seq.turn(1)).toEqual(a.seq.turn(1));
    // a successor by default moves to the next epoch
    const c = rig({}, [0, 1], { resume: { state } });
    expect(c.seq.epoch).toBe(state.epoch + 1);
  });
});
