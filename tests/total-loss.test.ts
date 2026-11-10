import { describe, expect, it } from 'vitest';
import { HostLobby } from '../src/net/lobby';
import { LONELY_MS, NetMatch, type MatchResume } from '../src/net/match';
import { canResume, keepNewest } from '../src/net/matchSave';
import { LOBBY_KINDS, MATCH_KINDS } from '../src/net/transport';
import { fullHash } from '../src/sim/snapshot';
import { play, prefs, ROOM_KEY } from './rig';

type Play = ReturnType<typeof play>;

/** every hash each match reports from now on, and the ticks where the listed ones disagreed */
function hashes(matches: Play['matches']) {
  const seen = new Map<string, Map<number, number>>();
  const watch = (id: string, m: NetMatch) => {
    const mine = new Map<number, number>();
    seen.set(id, mine);
    m.session.onHash = (t, h) => mine.set(t, h);
  };
  for (const [id, m] of matches) watch(id, m);
  const agree = (ids: string[]) => {
    const maps = ids.map((id) => seen.get(id)!);
    const common = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t)));
    return { common: common.length, bad: common.filter((t) => new Set(maps.map((m) => m.get(t))).size > 1) };
  };
  return { watch, agree };
}

/** every link between these players drops at once (the transport says so, as WebRTC does) */
function dropAll(p: Play, ids: string[]): void {
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) p.drop(ids[i], ids[j]);
}

/** who reports losing everyone, and when it ends */
function lostLog(p: Play): Map<string, boolean[]> {
  const log = new Map<string, boolean[]>();
  for (const [id, m] of p.matches) {
    const l: boolean[] = [];
    log.set(id, l);
    m.events.onLost = (on) => l.push(on);
  }
  return log;
}

describe('everyone loses touch (#191)', () => {
  it('everyone drops at once: the match stands still everywhere, nobody takes over, no seat goes to a bot, and each can save it', () => {
    const p = play({ botSecs: 30 });
    const { matches, run } = p;
    run(10_000);
    const lost = lostLog(p);
    dropAll(p, ['H', 'A', 'B']);
    run(LONELY_MS + 1000);
    for (const id of ['H', 'A', 'B']) {
      expect(lost.get(id)).toEqual([true]);
      expect(matches.get(id)!.lonely).toBe(true);
    }
    const ticks = new Map([...matches].map(([id, m]) => [id, m.session.world.tick]));
    // long past the transport giving up on the links, and the room's bot timeout
    run(25_000);
    for (const id of ['H', 'A', 'B']) p.giveUp(id === 'H' ? 'A' : 'H', id === 'B' ? 'A' : 'B');
    run(40_000);
    for (const [id, m] of matches) {
      expect(m.session.world.tick).toBe(ticks.get(id));
      expect(m.runner).toBe(id === 'H');
      const save = m.exportSave();
      expect(save.hash).toBe(fullHash(m.session.world));
      expect(save.tick).toBe(m.session.world.tick);
      expect(save.ctrlLog.some((c) => c.ctrl.k === 'seat' && c.ctrl.state === 'bot')).toBe(false);
    }
    expect(matches.get('H')!.seq!.holding).toBe(true);
  });

  it('one player picks it up from their save later; the others rejoin by their seat tokens and everyone plays on in step', () => {
    const p = play({ botSecs: 30 });
    const { matches, run, gs } = p;
    run(10_000);
    dropAll(p, ['H', 'A', 'B']);
    run(LONELY_MS + 1000);
    const save: MatchResume = matches.get('A')!.exportSave();
    const lobby = structuredClone(gs[0].lobby.state!);
    for (const id of ['H', 'A', 'B']) p.quit(id);
    run(5000);
    // A, on a new page: the room as A last saw it, and the match from A's save
    const r = p.link('A2');
    const room = new HostLobby(r.view(LOBBY_KINDS), { build: 'test', char: 0, prefs: prefs(), seed: lobby.seed, clock: () => p.clock.now, ownToken: p.tokenOf('A'), roomKey: ROOM_KEY, takeOver: { state: lobby, connected: [], setup: save.setup, resume: true } });
    const m = NetMatch.resume(r.view(MATCH_KINDS), save, { clock: () => p.clock.now, heartbeat: false, gzip: false, net: { gzipSnaps: false } });
    expect(fullHash(m.session.world)).toBe(save.hash);
    expect(m.runner).toBe(true);
    expect(m.host).toBe(true);
    p.add('A2', m);
    p.wire('A2', room);
    p.arrived('A2');
    const { watch, agree } = hashes(matches);
    run(3000);
    const back = ['H', 'B'].map((id) => p.rejoin(id, `${id}2`));
    for (const g of back) {
      expect(g.refused).toEqual([]);
      expect(g.start()!.tick).toBeGreaterThan(0);
      watch(g.id, matches.get(g.id)!);
    }
    run(20_000);
    for (const id of ['H2', 'B2']) expect(matches.get(id)!.session.syncing).toBe(false);
    for (const s of [save.seat, ...back.map((g) => g.lobby.mySeat)]) expect(m.seq!.seatState(s)).toBe('human');
    const { common, bad } = agree(['A2', 'H2', 'B2']);
    expect(common).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });

  it('everyone else leaving on purpose isn’t losing touch: the one left plays on, as before', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    const lost = lostLog(p);
    const a = p.matches.get('A')!;
    p.quit('B');
    const h = p.matches.get('H')!;
    expect(h.handOff()).toBe(true);
    p.run(150);
    p.quit('H');
    const t = a.session.world.tick;
    p.run(10_000);
    expect(lost.get('A')).toEqual([]);
    expect(a.runner).toBe(true);
    expect(a.session.world.tick).toBeGreaterThan(t + 200);
  });

  it('a blip shorter than LONELY_MS changes nothing', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    const lost = lostLog(p);
    dropAll(p, ['H', 'A', 'B']);
    p.run(LONELY_MS / 2);
    for (const [a, b] of [['H', 'A'], ['H', 'B'], ['A', 'B']]) p.reconnect(a, b);
    p.run(10_000);
    for (const l of lost.values()) expect(l).toEqual([]);
  });

  it('lost touch, then back: the match carries on from where it stood, with no burst of turns, in step', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    const lost = lostLog(p);
    const { agree } = hashes(p.matches);
    dropAll(p, ['H', 'A', 'B']);
    p.run(10_000);
    const t = p.matches.get('H')!.session.world.tick;
    for (const [a, b] of [['H', 'A'], ['H', 'B'], ['A', 'B']]) p.reconnect(a, b);
    p.run(1000);
    for (const l of lost.values()) expect(l).toEqual([true, false]);
    // a second's worth of turns, not the ten seconds it stood still
    expect(p.matches.get('H')!.session.world.tick - t).toBeLessThan(60);
    p.run(10_000);
    const { common, bad } = agree(['H', 'A', 'B']);
    expect(common).toBeGreaterThan(10);
    expect(bad).toEqual([]);
    for (const [id, m] of p.matches) expect(m.session.seatBot, id).toBe(false);
  });

  it('two players whose link drops: both stand still, rather than one playing on against the other’s bot', () => {
    const p = play({ botSecs: 30, guests: ['A'] });
    run10(p);
    const lost = lostLog(p);
    p.drop('H', 'A');
    p.run(LONELY_MS + 1000);
    p.giveUp('H', 'A');
    p.run(40_000);
    expect(lost.get('H')).toEqual([true]);
    expect(lost.get('A')).toEqual([true]);
    expect(p.matches.get('A')!.runner).toBe(false);
  });

  it('a phone that went hidden is away, not lost: the other plays on', () => {
    const p = play({ botSecs: 30, guests: ['A'] });
    run10(p);
    const lost = lostLog(p);
    p.matches.get('A')!.setHidden(true);
    p.run(500, ['A']);
    p.run(15_000, ['A']); // frozen: no beats at all
    expect(lost.get('H')).toEqual([]);
  });
});

describe('everyone loses touch: review fixes (#191)', () => {
  it('a lonely runner whose page goes hidden stays held and saved; shown again, still waiting', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    const lost = lostLog(p);
    dropAll(p, ['H', 'A', 'B']);
    p.run(LONELY_MS + 1000);
    const h = p.matches.get('H')!;
    expect(h.seq!.holding).toBe(true);
    h.setHidden(true);
    p.run(30_000);
    expect(h.lonely).toBe(true);
    expect(h.seq!.holding).toBe(true);
    h.setHidden(false);
    p.run(5000);
    expect(h.lonely).toBe(true);
    expect(lost.get('H')).toEqual([true]);
  });

  it('orders the runner gives while held aren’t dropped as too many once play goes on', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    dropAll(p, ['H', 'A', 'B']);
    p.run(LONELY_MS + 1000);
    const h = p.matches.get('H')!;
    p.run(60_000); // H's proxy keeps ordering throughout
    for (const [a, b] of [['H', 'A'], ['H', 'B'], ['A', 'B']]) p.reconnect(a, b);
    const before = h.seq!.dropped.rate;
    p.run(10_000);
    expect(h.seq!.holding).toBe(false);
    expect(h.seq!.dropped.rate).toBe(before);
  });

  it('a save picks up only where one of its seats was sealed with its token', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    const lobby = structuredClone(p.gs[0].lobby.state!);
    const seat = p.gs[0].lobby.mySeat;
    expect(canResume({ token: p.tokenOf('A'), lobby, seat }, ROOM_KEY)).toBe(true);
    expect(canResume({ token: 'a-token-that-never-was', lobby, seat }, ROOM_KEY)).toBe(false);
    expect(canResume({ token: p.tokenOf('A'), lobby, seat }, 'another.room')).toBe(false);
    expect(canResume({ token: p.tokenOf('A'), lobby: { ...lobby, phase: 'lobby' }, seat }, ROOM_KEY)).toBe(false);
  });

  it('two players pick it up at once: they find each other, agree who keeps it, and the other rejoins theirs', () => {
    const p = play({ botSecs: 30 });
    run10(p);
    dropAll(p, ['H', 'A', 'B']);
    p.run(LONELY_MS + 1000);
    const saves = new Map(['A', 'B'].map((id) => [id, p.matches.get(id)!.exportSave()]));
    const lobbies = new Map(p.gs.map((g) => [g.id, structuredClone(g.lobby.state!)]));
    for (const id of ['H', 'A', 'B']) p.quit(id);
    p.run(5000);
    const rivals: [string, string, boolean][] = [];
    const rooms = new Map<string, HostLobby>();
    for (const id of ['A', 'B']) {
      const nid = `${id}2`;
      const r = p.link(nid);
      const room = new HostLobby(r.view(LOBBY_KINDS), { build: 'test', char: 0, prefs: prefs(), seed: lobbies.get(id)!.seed, clock: () => p.clock.now, ownToken: p.tokenOf(id), roomKey: ROOM_KEY, takeOver: { state: lobbies.get(id)!, connected: [], setup: saves.get(id)!.setup, resume: true } });
      const m = NetMatch.resume(r.view(MATCH_KINDS), saves.get(id)!, { clock: () => p.clock.now, heartbeat: false, gzip: false, net: { gzipSnaps: false } });
      p.add(nid, m);
      room.onRejoin = (seat, peer) => m.rebind(seat, peer);
      room.runnerOf = () => m.runnerPeer;
      room.onRival = (peer, yieldToIt) => rivals.push([nid, peer, yieldToIt]);
      rooms.set(nid, room);
    }
    for (const nid of rooms.keys()) p.arrived(nid);
    p.run(1000);
    // each heard the other, and exactly one yields
    expect(rivals.map((x) => x[0]).sort()).toEqual(['A2', 'B2']);
    expect(rivals.filter((x) => x[2]).length).toBe(1);
    const [loser] = rivals.find((x) => x[2])!;
    const winner = loser === 'A2' ? 'B2' : 'A2';
    p.wire(winner, rooms.get(winner)!);
    // the loser goes, and comes back as a player in the winner's match, by its token
    p.quit(loser);
    rooms.get(loser)!.close();
    const g = p.rejoin(loser[0], `${loser[0]}3`);
    expect(g.refused).toEqual([]);
    expect(g.lobby.state!.host).toBe(winner);
    const { watch, agree } = hashes(p.matches);
    watch(winner, p.matches.get(winner)!);
    p.run(15_000);
    expect(p.matches.get(g.id)!.session.syncing).toBe(false);
    const { common, bad } = agree([winner, g.id]);
    expect(common).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });

  it('while lonely, whoever runs the match still does its chores: the host gone, it becomes host', () => {
    const p = play({ botSecs: 30, guests: ['A'], runner: 'A' });
    p.run(10_000);
    const a = p.matches.get('A')!;
    expect(a.runner).toBe(true);
    expect(a.host).toBe(false);
    p.drop('H', 'A');
    p.run(LONELY_MS + 7000);
    expect(a.lonely).toBe(true);
    expect(a.host).toBe(true);
  });
});

describe('saved matches (#191)', () => {
  it('keeps the newest four: a fifth room drops the oldest; a room saved again replaces its save', () => {
    const have = [1, 2, 3, 4].map((i) => ({ room: `r${i}`, savedAt: i }));
    expect(keepNewest(have, { room: 'r5', savedAt: 5 }).drop).toEqual(['r1']);
    expect(keepNewest(have, { room: 'r2', savedAt: 9 }).drop).toEqual([]);
    expect(keepNewest(have.slice(0, 2), { room: 'r5', savedAt: 5 }).drop).toEqual([]);
  });
});

function run10(p: Play): void {
  p.run(10_000);
}
