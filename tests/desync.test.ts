import { describe, expect, it } from 'vitest';
import { analyzeBundle, buildBundle, nudgeWorld, type DesyncReport } from '../src/net/desync';
import type { NetMatch } from '../src/net/match';
import type { Turn } from '../src/net/protocol';
import { Sequencer } from '../src/net/sequencer';
import { DT } from '../src/sim/constants';
import { play } from './rig';

const TICK = DT * 1000;
const LIMITS = { width: 1000, height: 800, nests: { length: 10 }, endless: false };

function seqOf(seats: number) {
  const clock = { now: 0 };
  const peers = Array.from({ length: seats }, (_, i) => `p${i}`);
  const seq = new Sequencer({ limits: LIMITS, seats: peers.map((peer, seat) => ({ seat, team: seat, peer })), clock: () => clock.now, send: () => undefined, opts: {} });
  const turns = new Map<number, Turn>();
  seq.onTurn = (t, turn) => turns.set(t, turn);
  const found: [number, number[]][] = [];
  seq.onDesync = (t, _m, odd) => found.push([t, odd]);
  return { seq, clock, peers, turns, found };
}

describe('desync detection (#165)', () => {
  it('names the odd one out against a majority, and every seat when there is none; once only', () => {
    const three = seqOf(3);
    three.clock.now = 100 * TICK;
    three.seq.update();
    three.peers.forEach((p, i) => three.seq.onMessage(p, { k: 'hash', tick: 60, hash: i === 1 ? 7 : 5 }));
    three.peers.forEach((p) => three.seq.onMessage(p, { k: 'hash', tick: 90, hash: Math.random() }));
    expect(three.found).toEqual([[60, [1]]]);
    const two = seqOf(2);
    two.clock.now = 100 * TICK;
    two.seq.update();
    two.peers.forEach((p, i) => two.seq.onMessage(p, { k: 'hash', tick: 60, hash: i }));
    expect(two.found).toEqual([[60, [0, 1]]]);
  });

  it('halts every client on the same turn, never resumes by itself, and resumes on the host’s word without a resume entry', () => {
    const { seq, clock, peers, turns } = seqOf(2);
    clock.now = 100 * TICK;
    seq.update();
    peers.forEach((p, i) => seq.onMessage(p, { k: 'hash', tick: 60, hash: i }));
    clock.now += 5 * TICK;
    seq.update();
    const halt = [...turns].find(([, t]) => t.ctrl?.some((c) => c.k === 'desync'));
    expect(halt?.[1].ctrl).toEqual([{ k: 'desync', tick: 60 }]);
    const stopped = seq.closed;
    expect(stopped).toBe(halt![0]);
    clock.now += 600_000; // ten minutes: no allowance runs out, it just stays stopped
    seq.update();
    expect(seq.closed).toBe(stopped);
    expect(seq.paused).toBe(true);
    seq.onMessage('p0', { k: 'pause', on: false });
    clock.now += 4000;
    seq.update();
    expect(seq.closed).toBeGreaterThan(stopped);
    expect([...turns.values()].flatMap((t) => t.ctrl ?? []).filter((c) => c.k === 'resume')).toEqual([]);
  });
});

/** Everyone's reported hashes, by peer. */
function watch(matches: Map<string, NetMatch>) {
  const seen = new Map<string, Map<number, number>>();
  for (const [id, m] of matches) {
    const mine = new Map<number, number>();
    seen.set(id, mine);
    const prev = m.session.onHash;
    m.session.onHash = (t, h) => {
      prev?.(t, h);
      mine.set(t, h);
    };
  }
  return seen;
}

describe('a desync, end to end (#165)', () => {
  function nudged(what: 'energy' | 'x') {
    const p = play();
    const { matches, run } = p;
    const host = matches.get('H')!;
    const seatA = matches.get('A')!.session.localSeat;
    let nudgeTick = -1, field = '';
    matches.get('A')!.session.beforeStep = (t, w) => {
      if (t === 301) {
        nudgeTick = t;
        field = nudgeWorld(w, what);
      }
    };
    const halts: [string, number][] = [];
    for (const [id, m] of matches) m.events.onDesync = (t) => halts.push([id, t]);
    const notes: string[] = [];
    matches.get('B')!.events.onDesyncNote = (_t, text) => notes.push(text);
    let report: DesyncReport | null = null;
    host.events.onDesyncReport = (r) => (report = r);
    run(30_000);
    return { ...p, host, seatA, nudgeTick, field, halts, notes, report: report as DesyncReport | null };
  }

  it('a one-bit nudge to one player’s energy: caught within 30 ticks, everyone halts on one tick, the diff names the field, and the bundle reproduces it', () => {
    const { matches, host, seatA, nudgeTick, field, halts, notes, report, run } = nudged('energy');
    expect(nudgeTick).toBe(301);
    expect(report).not.toBeNull();
    const r = report!;
    expect(r.tick).toBeGreaterThan(nudgeTick);
    expect(r.tick - nudgeTick).toBeLessThanOrEqual(30);
    expect(r.odd).toEqual([seatA]);
    expect(r.missing).toEqual([]);
    expect(r.first).toBe(field); // factions[k].energy
    // every client heard it once, and stopped on the same tick
    expect(new Set(halts.map(([id]) => id))).toEqual(new Set(matches.keys()));
    expect(new Set(halts.map(([, t]) => t))).toEqual(new Set([r.tick]));
    const ticks = [...matches.values()].map((m) => m.session.world.tick);
    expect(new Set(ticks).size).toBe(1);
    run(5000);
    expect([...matches.values()].map((m) => m.session.world.tick)).toEqual(ticks);
    expect(notes).toEqual([r.first]);
    // the host's bundle, through JSON as a download would be, replays to the same finding
    const seq = host.seq!;
    const bundle = JSON.parse(JSON.stringify(buildBundle({ setup: host.session.setup, seat: host.session.localSeat, host: true, report: r, reported: host.reportedHashes(), turns: seq.closedTurns() })));
    const a = analyzeBundle(bundle);
    expect(a.partial).toBe(false);
    const bySeat = new Map(a.findings.map((f) => [f.seat, f]));
    expect(bySeat.get(seatA)!.divergedAt).toBe(r.tick);
    expect(bySeat.get(seatA)!.paths[0]).toBe(r.first);
    for (const [s, f] of bySeat) if (s !== seatA) expect(f.divergedAt).toBeNull();
    // a guest's bundle can't be replayed: it says so
    const b = matches.get('B')!.session;
    const guest = buildBundle({ setup: b.setup, seat: b.localSeat, host: false, report: { tick: r.tick, hashes: {}, odd: [], snaps: new Map(), diffs: {} }, reported: {}, turns: { first: 5, turns: [] } });
    expect(analyzeBundle(guest).partial).toBe(true);
  });

  it('a nudge to one unit: the diff names the unit array and its uid', () => {
    const { report, seatA } = nudged('x');
    expect(report!.odd).toEqual([seatA]);
    expect(report!.first).toMatch(/^x\[\d+\] \(uid \d+/);
  });

  it('resync: everyone takes the agreed world, re-runs its turns since, and plays on in step', () => {
    const { matches, host, run } = nudged('energy');
    const seen = watch(matches);
    expect(host.resync()).toBe(true);
    run(15_000);
    expect(host.seq!.desyncs.length).toBe(1);
    for (const m of matches.values()) expect(m.session.paused).toBe(false);
    const maps = [...seen.values()];
    const common = [...maps[0].keys()].filter((t) => maps.every((x) => x.has(t)));
    expect(common.length).toBeGreaterThan(10);
    expect(common.filter((t) => new Set(maps.map((x) => x.get(t))).size > 1)).toEqual([]);
  });
});
