import { describe, expect, it } from 'vitest';
import { replayLog } from '../src/game/replay';
import { parseLobby } from '../src/net/lobby';
import type { NetMatch } from '../src/net/match';
import { SNAP_CHUNK } from '../src/net/protocol';
import { chunkSnap, packSnap, SnapAssembler, unpackSnap, type SnapMeta } from '../src/net/snapwire';
import { DT } from '../src/sim/constants';
import { fullHash } from '../src/sim/snapshot';
import { play } from './rig';

/** Every hash each peer reported, by tick. */
function hashes(matches: Map<string, NetMatch>) {
  const seen = new Map<string, Map<number, number>>();
  const watch = (id: string, m: NetMatch) => {
    const mine = new Map<number, number>();
    seen.set(id, mine);
    m.session.onHash = (t, h) => mine.set(t, h);
  };
  for (const [id, m] of matches) watch(id, m);
  /** ticks every listed peer reported, and whether they all agreed on each */
  const agree = (ids: string[]) => {
    const maps = ids.map((id) => seen.get(id)!);
    const common = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t)));
    const bad = common.filter((t) => new Set(maps.map((m) => m.get(t))).size > 1);
    return { common: common.length, bad };
  };
  return { watch, agree };
}

describe('snapshots on the wire (#164)', () => {
  const meta: SnapMeta = { tick: 4321, pausedBy: -1, seqBase: 17 };
  const world = new Uint8Array(70_000).map((_, i) => (i * 7) & 255);

  it('pack, chunk, reassemble in any order, unpack: the same bytes and meta', () => {
    const packed = packSnap(meta, world, false) as Uint8Array;
    const msgs = chunkSnap(meta.tick, packed);
    expect(msgs.length).toBe(Math.ceil(packed.length / SNAP_CHUNK));
    const asm = new SnapAssembler(() => 0);
    let whole: Uint8Array | null = null;
    for (const m of [...msgs].reverse()) if (m.k === 'snap') whole = asm.add('H', m) ?? whole;
    const back = unpackSnap(whole!) as { meta: SnapMeta; world: Uint8Array };
    expect(back.meta).toEqual(meta);
    expect([...back.world]).toEqual([...world]);
  });

  it('gzips (much smaller here) and unzips', async () => {
    const packed = await packSnap(meta, world, true);
    expect(packed.length).toBeLessThan(world.length / 4);
    const back = await unpackSnap(packed);
    expect(back.meta).toEqual(meta);
    expect([...back.world]).toEqual([...world]);
  });

  it('starts over on a different snapshot under the same tick, drops a stale one, refuses garbage', () => {
    let now = 0;
    const asm = new SnapAssembler(() => now, 10_000);
    const a = chunkSnap(9, packSnap(meta, world, false) as Uint8Array);
    const b = chunkSnap(9, packSnap(meta, world.subarray(0, 20_000), false) as Uint8Array);
    expect(asm.add('H', a[0] as never)).toBeNull();
    // b has fewer parts: a's half is thrown away, b completes on its own
    let done: Uint8Array | null = null;
    for (const m of b) done = asm.add('H', m as never) ?? done;
    expect((unpackSnap(done!) as { world: Uint8Array }).world.length).toBe(20_000);
    // a half-sent snapshot is forgotten after the timeout
    expect(asm.add('H', a[0] as never)).toBeNull();
    now = 20_000;
    for (const m of a.slice(1)) expect(asm.add('H', m as never)).toBeNull();
    expect(() => unpackSnap(new Uint8Array([9, 1, 2]))).toThrow();
    expect(() => unpackSnap(new Uint8Array([0, 0, 0, 0, 99]))).toThrow();
  });
});

describe('away, drop and rejoin (#164)', () => {
  it('a hidden page goes away at once, an Easy bot takes over after the room’s timeout, and the seat comes back by itself', () => {
    const { matches, run } = play({ botSecs: 30 });
    const { agree } = hashes(matches);
    const seatB = matches.get('B')!.session.localSeat;
    const seen: [number, string, number][] = [];
    matches.get('A')!.events.onSeat = (seat, state) => seen.push([seat, state, matches.get('A')!.session.world.tick]);
    run(5000);
    const hidAt = matches.get('H')!.session.world.tick;
    matches.get('B')!.session.setHidden(true);
    run(60_000, ['B']); // the tab is hidden: no frames at all
    matches.get('B')!.session.setHidden(false);
    run(15_000);
    const states = seen.filter(([s]) => s === seatB).map(([, st]) => st);
    expect(states).toEqual(['away', 'bot', 'human']);
    const [away, bot] = seen.filter(([s]) => s === seatB).map(([, , t]) => t);
    expect(away - hidAt).toBeLessThan(15); // at once, not after the 5 s silence
    expect(Math.abs(bot - away - 30 / DT)).toBeLessThanOrEqual(3); // the room's 30 s
    expect(matches.get('H')!.seq!.seatState(seatB)).toBe('human');
    expect(matches.get('B')!.session.seatBot).toBe(false);
    const { common, bad } = agree(['H', 'A', 'B']);
    expect(common).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });

  it('a guest that reloads mid-match gets its seat back from a snapshot, catches up, and plays on in step', () => {
    const { matches, run, quit, rejoin, h } = play({ botSecs: 30 });
    const { watch, agree } = hashes(matches);
    const seatB = matches.get('B')!.session.localSeat;
    run(8000);
    const issuedBefore = matches.get('B')!.session.issued;
    expect(issuedBefore).toBeGreaterThan(0);
    quit('B');
    run(40_000); // gone long enough for its bot
    expect(matches.get('H')!.seq!.seatState(seatB)).toBe('bot');
    const g = rejoin('B', 'B2');
    expect(g.refused).toEqual([]);
    expect(g.start()!.tick).toBeGreaterThan(0);
    expect(h.lobby.state.rows[seatB]).toMatchObject({ k: 'human', peer: 'B2' });
    const b2 = matches.get('B2')!;
    watch('B2', b2);
    expect(b2.session.syncing).toBe(true);
    let adoptedAt = -1;
    b2.session.onAdopt = (t) => (adoptedAt = t);
    const lost: string[] = [];
    b2.session.onReject = (_id, why) => lost.push(why);
    run(20_000);
    expect(adoptedAt).toBeGreaterThan(40 / DT);
    expect(b2.session.syncing).toBe(false);
    // caught up, and the bot gave the seat back by itself
    expect(Math.abs(b2.session.world.tick - matches.get('A')!.session.world.tick)).toBeLessThan(15);
    expect(matches.get('H')!.seq!.seatState(seatB)).toBe('human');
    expect(b2.session.seatBot).toBe(false);
    // its orders number on above the old page's, so none is dropped as a duplicate
    expect(b2.session.issued).toBeGreaterThan(0);
    expect(lost).toEqual([]);
    run(3000);
    const { common, bad } = agree(['H', 'A', 'B2']);
    expect(common).toBeGreaterThan(10);
    expect(bad).toEqual([]);
    expect(agree(['H', 'A']).bad).toEqual([]);
  });

  it('a wrong token is turned away; the same seat opened twice keeps the newer tab', () => {
    const { matches, run, rejoin, gs } = play();
    run(3000);
    const stranger = rejoin('X', 'X1', 'not-a-seat-token');
    expect(stranger.refused[0]).toMatch(/already started/);
    expect(stranger.start()).toBeNull();
    // B's page duplicated: same token, B still connected
    const dup = rejoin('B', 'B9');
    expect(dup.refused).toEqual([]);
    expect(gs[1].refused.at(-1)).toMatch(/another tab/);
    run(10_000);
    expect(matches.get('B9')!.session.syncing).toBe(false);
  });

  it('the bot timeout is a room setting, checked on the way in', () => {
    const { h } = play({ botSecs: 120 });
    expect(h.lobby.state.botSecs).toBe(120);
    const json = JSON.stringify(h.lobby.state);
    expect(parseLobby(json)?.botSecs).toBe(120);
    expect(parseLobby(json.replace('"botSecs":120', '"botSecs":7'))).toBeNull();
    expect(parseLobby(json.replace(',"botSecs":120', ''))).toBeNull();
  });

  it('a replay of a networked log, seat changes included, ends on the same world', () => {
    const { matches, run } = play({ botSecs: 30 });
    run(3000);
    matches.get('B')!.session.setHidden(true);
    run(40_000, ['B']);
    matches.get('B')!.session.setHidden(false);
    run(10_000);
    const a = matches.get('A')!.session;
    expect(a.ctrlLog.some((c) => c.ctrl.k === 'seat' && c.ctrl.state === 'bot')).toBe(true);
    const w = replayLog(a.setup, a.log, a.ctrlLog, a.world.tick);
    expect(fullHash(w)).toBe(fullHash(a.world));
    // without the control entries it doesn't: the bot's play is part of the match
    expect(fullHash(replayLog(a.setup, a.log, [], a.world.tick))).not.toBe(fullHash(a.world));
  });
});
