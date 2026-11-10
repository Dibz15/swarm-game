import { describe, expect, it, vi } from 'vitest';
import { playerCharacter } from '../src/game/character';
import { loadPrefs, type SetupPrefs } from '../src/game/matchSetup';
import { ASK_MS, LONE_ASKS, buildNetSetup, COUNTDOWN_MS, GuestLobby, HostLobby, nextHost, parseLobby, rosterChanges, type HostGo, type LobbyState, type StartInfo } from '../src/net/lobby';
import { NetMatch } from '../src/net/match';
import { PROTOCOL_VERSION, type Msg } from '../src/net/protocol';
import { decodeMsg, encodeMsg } from '../src/net/codec';
import { LOBBY_KINDS, LoopbackHub, MATCH_KINDS, PeerGrace, Router, type LinkState, type Transport } from '../src/net/transport';
import { Proxy } from '../src/proxy/proxy';
import { DT } from '../src/sim/constants';
import { FRAME, play, prefs, room, ROOM_KEY, wipe, type Guest } from './rig';
import { fullHash } from '../src/sim/snapshot';
import { createWorld } from '../src/sim/setup';
import { ordinal, placingOf } from '../src/game/standing';

const occupant = (s: LobbyState) => s.rows.map((r) => (r.k === 'human' ? r.peer : r.k));


describe('lobby (#162)', () => {
  it('opens empty, seats guests in open rows, and every guest sees the host’s state', () => {
    const { host, guest } = room();
    // the skirmish screen's bots stay out of a room (#184): its seats are for friends
    const h = host({ prefs: prefs({ color: 2, bots: [{ faction: 4, difficulty: 2, personality: 'rusher', team: 1 }] }) });
    expect(occupant(h.lobby.state)).toEqual(['open', 'open', 'H', 'open', 'open', 'open']);
    expect(h.lobby.state.locked).toBe(false);
    const a = guest('A');
    const b = guest('B');
    expect(occupant(h.lobby.state)).toEqual(['A', 'B', 'H', 'open', 'open', 'open']);
    for (const g of [a, b]) {
      expect(g.lobby.host).toBe('H');
      expect(g.lobby.state).toEqual(h.lobby.state);
    }
    expect(a.lobby.mySeat).toBe(0);
    expect(b.lobby.mySeat).toBe(1);
  });

  it('refuses another version, a full room, and a match in progress', () => {
    const rm = room();
    const { host, guest } = rm;
    const h = host();
    expect(guest('A', { build: 'other' }).refused[0]).toMatch(/different version/);
    for (let i = 1; i < 6; i++) h.lobby.setRow(i, { k: 'closed', team: i });
    expect(guest('B').refused[0]).toMatch(/full/);
    h.lobby.setRow(5, { k: 'open', team: 5 });
    guest('C');
    h.lobby.start();
    expect(guest('D').refused[0]).toMatch(/is starting/);
    rm.clock.now += 3000;
    h.lobby.update();
    expect(guest('E').refused[0]).toMatch(/already started/);
  });

  it('guests move to open colours, change team, and pick characters; names stay unique', () => {
    const { host, guest } = room();
    const h = host({ char: 42 });
    const a = guest('A', { char: 42 }); // same character as the host: renamed
    const names = () => h.lobby.state.rows.flatMap((r) => (r.k === 'human' ? [playerCharacter(r.char).name] : []));
    expect(new Set(names()).size).toBe(2);
    const b = guest('B');
    a.lobby.pick(4, 3, 99);
    expect(a.lobby.mySeat).toBe(4);
    expect(h.lobby.state.rows[4]).toMatchObject({ k: 'human', peer: 'A', team: 3, char: 99 });
    expect(h.lobby.state.rows[1]).toEqual({ k: 'open', team: 1 });
    // a taken colour: stays put; a taken name: keeps its character
    b.lobby.pick(4, 0, 42);
    expect(b.lobby.mySeat).toBe(2);
    const bRow = h.lobby.state.rows[2];
    expect(bRow.k === 'human' && playerCharacter(bRow.char).name).not.toBe(playerCharacter(42).name);
    expect(new Set(names()).size).toBe(3);
  });

  it('a guest who leaves frees their row; the host can remove one', () => {
    const { host, guest, leave } = room();
    const h = host();
    guest('A');
    const b = guest('B');
    leave('A');
    expect(occupant(h.lobby.state)).toEqual(['H', 'open', 'B', 'open', 'open', 'open']);
    h.lobby.kick(2);
    expect(b.refused[0]).toMatch(/removed/);
    expect(occupant(h.lobby.state)[2]).toBe('open');
  });

  it('a link that drops and comes back in the lobby: the guest says hello again and keeps its seat', () => {
    const { host, guest, drop, reconnect, giveUp } = room();
    const h = host();
    const a = guest('A');
    const seen: string[] = [];
    a.lobby.onHostLink = (s) => seen.push(s);
    a.lobby.onNoHost = (w) => seen.push(`no host: ${w}`);
    drop('A', 'H');
    h.lobby.setTeams(true); // missed while the link is down
    reconnect('A', 'H');
    expect(seen).toEqual(['lost', 'back']);
    expect(a.lobby.state!.teams).toBe(true); // the hello brought the state back
    expect(occupant(h.lobby.state)[1]).toBe('A');
    // gone for good this time: the host frees the row, the guest is told why
    drop('A', 'H');
    giveUp('A', 'H');
    expect(seen.at(-1)).toBe('no host: lost');
    expect(occupant(h.lobby.state)[1]).toBe('open');
    // and if it does come back later, the hello seats it again
    reconnect('A', 'H');
    expect(occupant(h.lobby.state)[1]).toBe('A');
  });

  it('a guest with no host gives up after a while', () => {
    const { clock, guest } = room();
    const a = guest('A');
    let why = '';
    a.lobby.onNoHost = (w) => (why = w);
    clock.now = 16000;
    a.lobby.update();
    expect(why).toBe('none');
  });

  it('parses only well-formed lobby states', () => {
    const { host } = room();
    const s = host().lobby.state;
    expect(parseLobby(JSON.stringify(s))).toEqual(s);
    expect(parseLobby('nope')).toBeNull();
    expect(parseLobby(JSON.stringify({ ...s, rows: s.rows.slice(1) }))).toBeNull();
    expect(parseLobby(JSON.stringify({ ...s, map: { ...s.map, size: 'huge' } }))).toBeNull();
    expect(parseLobby(JSON.stringify({ ...s, rows: [{ k: 'bot', team: 0, difficulty: 9, personality: 'x' }, ...s.rows.slice(1)] }))).toBeNull();
  });

  it('builds the match from the rows: colours are seats, teams only when on', () => {
    const { host, guest } = room();
    const h = host();
    h.lobby.setRow(3, { k: 'bot', team: 1, difficulty: 0, personality: 'random' });
    guest('A');
    const ffa = buildNetSetup(h.lobby.state);
    expect(ffa.players.map((p) => [p.faction, p.team, p.human])).toEqual([[0, 0, true], [1, 1, true], [3, 3, false]]);
    expect(ffa.players[2].bot?.personality).not.toBe('random');
    h.lobby.setTeams(true);
    expect(buildNetSetup(h.lobby.state).players.map((p) => p.team)).toEqual([0, 1, 1]);
  });
});

describe('lobby to match (#162)', () => {

  it('everyone gets the same match, plays it, and ends on the same world', () => {
    const { matches, run } = play();
    const desyncs: number[] = [];
    matches.get('H')!.events.onDesync = (t) => desyncs.push(t);
    run(60_000);
    const ticks = [...matches.values()].map((m) => m.session.world.tick);
    expect(Math.min(...ticks)).toBeGreaterThan(55 / DT);
    expect(desyncs).toEqual([]);
    // compare at the tick everyone has reached
    const t = Math.min(...ticks);
    const logs = [...matches.values()].map((m) => JSON.stringify(m.session.log.filter((e) => e.tick <= t)));
    expect(new Set(logs).size).toBe(1);
    for (const m of matches.values()) expect(m.session.issued).toBeGreaterThan(5);
    run(2000); // and the hashes really are compared: nobody flagged one
    expect(desyncs).toEqual([]);
  });

  it('only the host pauses the match; a guest’s pause is ignored', () => {
    const { matches, run } = play();
    run(2000);
    matches.get('A')!.session.setPaused(true);
    run(1000);
    expect([...matches.values()].some((m) => m.session.paused)).toBe(false);
    const pauses: boolean[] = [];
    matches.get('B')!.events.onPause = (p) => pauses.push(p);
    matches.get('H')!.session.setPaused(true);
    run(1000);
    expect([...matches.values()].every((m) => m.session.paused)).toBe(true);
    const t = matches.get('B')!.session.world.tick;
    matches.get('A')!.session.setPaused(false); // not theirs to resume either
    run(5000);
    expect(matches.get('B')!.session.world.tick).toBe(t);
    matches.get('H')!.session.setPaused(false);
    run(5000);
    expect(matches.get('B')!.session.world.tick).toBeGreaterThan(t);
    expect(pauses).toEqual([true, false]);
  });

  it('a guest who drops mid-match goes away, then a bot takes the seat', () => {
    const { matches, run, leave, gs } = play();
    const seen: [number, string][] = [];
    matches.get('A')!.events.onSeat = (seat, state) => seen.push([seat, state]);
    run(2000);
    leave('B');
    matches.delete('B');
    run(65_000);
    expect(seen).toEqual([[gs[1].lobby.mySeat, 'away'], [gs[1].lobby.mySeat, 'bot']]);
  });

  it('a guest’s link that drops mid-match and comes back: the match goes on, and everyone ends on the same world', () => {
    const { matches, run, drop, reconnect } = play();
    const desyncs: number[] = [];
    matches.get('H')!.events.onDesync = (t) => desyncs.push(t);
    const stalls: boolean[] = [];
    const leaders: number[] = [];
    matches.get('A')!.events.onStall = (on) => stalls.push(on);
    for (const m of matches.values()) m.events.onLeader = (seat) => leaders.push(seat);
    const seats: [number, string][] = [];
    matches.get('B')!.events.onSeat = (seat, state) => seats.push([seat, state]);
    run(5000);
    drop('A', 'H');
    run(12_000); // everything either way is lost meanwhile: turns, acks, orders
    const behind = matches.get('A')!.session.world.tick;
    expect(matches.get('H')!.session.world.tick - behind).toBeGreaterThan(10 / DT);
    reconnect('A', 'H');
    run(20_000);
    // A waited for the host, on its own: the others still heard it, so nobody took over
    expect(stalls).toEqual([true, false]);
    expect(leaders).toEqual([]);
    const seatA = matches.get('A')!.session.localSeat;
    expect(seats).toEqual([[seatA, 'away'], [seatA, 'human']]);
    // A caught up and plays on, in step with everyone
    const ticks = [...matches.values()].map((m) => m.session.world.tick);
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThan(1 / DT);
    const t = Math.min(...ticks);
    const logs = [...matches.values()].map((m) => JSON.stringify(m.session.log.filter((e) => e.tick <= t)));
    expect(new Set(logs).size).toBe(1);
    run(2000);
    expect(desyncs).toEqual([]);
  });

  it('a guest cut off from the host on its own doesn’t take over; when the host really goes, the players pick a new one (#166)', () => {
    const { matches, run, drop, giveUp, leave } = play();
    const leaders = new Map<string, number[]>();
    for (const [id, m] of matches) m.events.onLeader = (seat) => leaders.set(id, [...(leaders.get(id) ?? []), seat]);
    run(2000);
    drop('A', 'H');
    run(3000);
    giveUp('A', 'H');
    run(3000);
    // B still hears the host: A alone is no majority
    expect([...leaders.keys()]).toEqual([]);
    expect(matches.get('H')!.runner).toBe(true);
    // the host really leaves: A and B both miss it, and B takes over: the host's ranking (#190) put A last, its link to the host was down
    matches.get('H')!.close();
    matches.delete('H');
    leave('H');
    run(4000);
    const seatB = matches.get('B')!.session.localSeat;
    expect(matches.get('B')!.runner).toBe(true);
    expect(matches.get('B')!.host).toBe(true);
    expect(leaders.get('A')).toEqual([seatB]);
    expect(leaders.get('B')).toEqual([seatB]);
    run(5000);
    const ticks = [matches.get('A')!, matches.get('B')!].map((m) => m.session.world.tick);
    expect(Math.abs(ticks[0] - ticks[1])).toBeLessThan(10);
    expect(ticks[0]).toBeGreaterThan(12 / DT);
  });

  it('defeated players watch the rest: they keep stepping and hashing, never go to a bot, and the host keeps running the match (#183)', () => {
    const { matches, run, h, gs } = play();
    const seatOf = (id: string) => matches.get(id)!.session.localSeat;
    const [sH, sA, sB] = [seatOf('H'), seatOf('A'), seatOf('B')];
    // the same wipe on every peer at the same tick, as a real defeat would be
    const plan = new Map([[300, sA], [600, sH], [900, 5]]);
    for (const m of matches.values()) m.session.beforeStep = (t, w) => plan.has(t) && wipe(w, plan.get(t)!);
    const seen: [number, string][] = [];
    matches.get('B')!.events.onSeat = (seat, state) => seen.push([seat, state]);
    const phases = new Set<string>();
    for (const g of gs) g.lobby.onChange = (s) => phases.add(s.phase);
    run(1000);
    const seq = matches.get('H')!.seq!;
    const judged: number[][] = [];
    seq.onHashes = (t, m) => judged.push([t, ...[...m.keys()].sort()]);

    run(12_000); // past tick 300: A is out
    expect(matches.get('A')!.session.world.factions[sA].eliminated).toBe(true);
    expect(seq.seatState(sA)).toBe('spectating');
    // still checked: A's hashes are judged with everyone's
    expect(judged.some(([t, ...seats]) => t > 330 && seats.includes(sA))).toBe(true);
    // A goes quiet for 10 s (a hidden tab): no away, no Easy bot for a faction that's out
    const tickA = matches.get('A')!.session.world.tick;
    run(10_000, ['A']);
    run(2000);
    expect(matches.get('A')!.session.world.tick).toBeGreaterThan(tickA);
    expect(seen.filter(([s]) => s === sA)).toEqual([]);

    // past tick 600 the host is out too, and keeps running the match
    const closed = seq.closed;
    run(10_000);
    expect(seq.seatState(sH)).toBe('spectating');
    expect(seq.closed).toBeGreaterThan(closed);
    expect(h.lobby.state.phase).toBe('playing');

    // past 900 B is the last one standing; nobody went back to the lobby on the way
    run(15_000);
    const worlds = [...matches.values()].map((m) => m.session.world);
    for (const w of worlds) expect(w.over).toBe(true);
    expect(worlds[0].winnerTeam).toBe(worlds[0].teamOf[sB]);
    expect(phases.has('lobby')).toBe(false);
    expect(new Set(worlds.map((w) => w.tick)).size).toBe(1);
    expect(new Set(worlds.map((w) => fullHash(w))).size).toBe(1);
  });

  it('the host ends the match for everyone, changes a setting, and starts the next one (#183)', () => {
    const { matches, run, h, gs, startNow } = play();
    run(3000);
    // End match: the host's room goes back to the lobby; every guest's state follows
    h.lobby.backToLobby();
    for (const g of gs) expect(g.lobby.state!.phase).toBe('lobby');
    for (const m of matches.values()) m.close();
    h.lobby.setMap({ ...h.lobby.state.map, size: 'medium' });
    const starts: StartInfo[] = [];
    for (const g of gs) g.lobby.onStart = (s) => starts.push(s);
    const setup = startNow(h)!;
    expect(setup.size).toBe('medium');
    expect(starts.length).toBe(2);
    for (const s of starts) expect(s.setup).toEqual(setup);
  });

  it('a guest who never says ready doesn’t hold up the start for long', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    let go: HostGo | null = null;
    h.lobby.onGo = (g) => (go = g);
    rm.startNow(h);
    expect(go).toBeNull();
    rm.clock.now += 6000;
    h.lobby.update();
    expect(go).not.toBeNull();
    // and the room shows the match as started
    expect(h.lobby.state.phase).toBe('playing');
    h.lobby.backToLobby();
    expect(h.lobby.state.phase).toBe('lobby');
  });

  it('ignores a pick or hello it can’t trust', () => {
    const { host, guest } = room();
    const h = host();
    const a = guest('A');
    // a pick for a seat out of range, a team out of range
    a.r.transport.send('H', encodeMsg({ k: 'pick', seat: 5, team: 200, char: 1 }));
    const row = h.lobby.state.rows[5];
    expect(row.k === 'human' && row.team).toBeLessThan(6);
    // hello from a peer speaking another protocol
    const t: Transport = a.r.transport;
    t.send('H', encodeMsg({ k: 'hello', proto: PROTOCOL_VERSION + 1, build: 'test', mobile: false, char: 3, token: '' }));
    expect(h.lobby.state.rows.filter((r) => r.k === 'human').length).toBe(2);
  });
});

describe('holding dropped links (PeerGrace)', () => {
  function grace(ms = 20_000) {
    const ev: string[] = [];
    const g = new PeerGrace(
      (p, up) => ev.push(`${p} ${up ? 'up' : 'down'}`),
      (p, s) => ev.push(`${p} ${s}`),
      ms,
    );
    return { g, ev };
  }

  it('a peer that reconnects in time is never reported down', () => {
    vi.useFakeTimers();
    try {
      const { g, ev } = grace();
      g.up('p');
      g.down('p');
      g.down('p'); // twice is still once
      expect(g.isHeld('p')).toBe(true);
      vi.advanceTimersByTime(19_000);
      g.up('p');
      expect(g.isHeld('p')).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(ev).toEqual(['p up', 'p lost', 'p back', 'p up']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('one that doesn’t is reported gone, then down', () => {
    vi.useFakeTimers();
    try {
      const { g, ev } = grace();
      g.up('p');
      g.down('p');
      vi.advanceTimersByTime(20_000);
      expect(ev).toEqual(['p up', 'p lost', 'p gone', 'p down']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('one that said goodbye goes at once, before or during the wait', () => {
    vi.useFakeTimers();
    try {
      const { g, ev } = grace();
      g.up('a');
      g.bye('a');
      g.down('a');
      g.up('b');
      g.down('b');
      g.bye('b');
      vi.advanceTimersByTime(60_000);
      expect(ev).toEqual(['a up', 'a down', 'b up', 'b lost', 'b down']);
      // closing drops what's held without reporting it
      g.up('c');
      g.down('c');
      g.close();
      vi.advanceTimersByTime(60_000);
      expect(ev.slice(5)).toEqual(['c up', 'c lost']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('where you finished (#183)', () => {
  it('places a faction knocked out behind everyone still in', () => {
    const w = createWorld({ seed: 3, size: 'small', players: [0, 1, 2, 3].map((f) => ({ faction: f, team: f, human: f === 0, ...(f ? { bot: { difficulty: 1, personality: 'expander' as const } } : {}) })) });
    w.factions[2].eliminated = true; // out earlier
    w.factions[0].eliminated = true; // out now
    expect(placingOf(w, 0)).toEqual({ place: 3, of: 4 });
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd']);
  });
});

describe('the room, start to rematch (#184)', () => {
  const bot = (team: number) => ({ k: 'bot' as const, team, difficulty: 1, personality: 'random' as const });

  it('"Everyone\u2019s here" closes the room to strangers, not to a player reloading; reopening lets them in', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    h.lobby.setLocked(true);
    // a stranger learns who runs the room (#202), is turned away, and never sees the room
    const b = rm.guest('B');
    expect(b.refused[0]).toMatch(/closed this room/);
    expect(b.lobby.state).toBeNull();
    expect(rm.guest('C').refused[0]).toMatch(/closed this room/);
    // A reloads: a new peer id, the same seat token
    rm.leave('A');
    expect(occupant(h.lobby.state).filter((o) => o === 'A')).toEqual([]);
    const a2 = rm.guest('A2');
    expect(a2.refused).toEqual([]);
    expect(a2.lobby.mySeat).toBeGreaterThanOrEqual(0);
    h.lobby.setLocked(false);
    const d = rm.guest('D');
    expect(d.refused).toEqual([]);
    expect(d.lobby.mySeat).toBeGreaterThanOrEqual(0);
    expect(d.lobby.state!.locked).toBe(false);
  });

  it('fills only the open seats with bots, and a newcomer takes a bot’s seat when the room is open', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    h.lobby.setRow(4, { k: 'closed', team: 4 });
    h.lobby.fillBots();
    expect(occupant(h.lobby.state)).toEqual(['H', 'A', 'bot', 'bot', 'closed', 'bot']);
    const b = rm.guest('B');
    expect(b.lobby.mySeat).toBe(2);
    expect(occupant(h.lobby.state)).toEqual(['H', 'A', 'B', 'bot', 'closed', 'bot']);
    // locked: no bot gives way
    h.lobby.setLocked(true);
    expect(rm.guest('C').refused[0]).toMatch(/closed/);
  });

  it('ready is each guest’s own, shown to everyone, and cleared after a match', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A');
    const b = rm.guest('B');
    expect(h.lobby.readyCount()).toEqual({ ready: 0, of: 2 });
    a.lobby.mark(true);
    expect(h.lobby.readyCount()).toEqual({ ready: 1, of: 2 });
    expect(b.lobby.state!.rows[a.lobby.mySeat]).toMatchObject({ peer: 'A', ready: true });
    // a player without a seat (turned away at the door) marks nothing
    h.lobby.setLocked(true);
    const z = rm.guest('Z');
    expect(z.refused[0]).toMatch(/closed/);
    z.lobby.mark(true);
    expect(h.lobby.readyCount()).toEqual({ ready: 1, of: 2 });
    a.lobby.mark(false);
    expect(h.lobby.readyCount()).toEqual({ ready: 0, of: 2 });
    a.lobby.mark(true);
    b.lobby.mark(true);
    rm.startNow(h);
    expect(h.lobby.state.phase).toBe('playing');
    h.lobby.backToLobby();
    expect(h.lobby.readyCount()).toEqual({ ready: 0, of: 2 });
  });

  it('Start counts down 3, 2, 1 for everyone; it can be cancelled, and stops by itself if too few are left', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A');
    const starts: StartInfo[] = [];
    a.lobby.onStart = (s) => starts.push(s);
    let go: HostGo | null = null;
    h.lobby.onGo = (g) => (go = g);
    expect(h.lobby.start()).not.toBeNull();
    expect(a.lobby.state!.phase).toBe('starting');
    expect(h.lobby.canStart()).toBe(false);
    // nobody changes seats or joins mid-countdown
    a.lobby.pick(4, 4, 7);
    expect(a.lobby.mySeat).toBe(1);
    expect(rm.guest('B').refused[0]).toMatch(/is starting/);
    rm.clock.now += COUNTDOWN_MS - 1;
    h.lobby.update();
    expect(starts.length).toBe(0);
    h.lobby.cancelStart();
    expect(a.lobby.state!.phase).toBe('lobby');
    rm.clock.now += COUNTDOWN_MS;
    h.lobby.update();
    expect(starts.length).toBe(0);
    // again, to the end: the match is sent, and goes once A is ready
    rm.startNow(h);
    expect(starts.length).toBe(1);
    expect(go).toBeNull();
    a.lobby.ready();
    expect(go).not.toBeNull();
    // a countdown that loses its last guest stops
    h.lobby.backToLobby();
    h.lobby.start();
    rm.leave('A');
    expect(h.lobby.state.phase).toBe('lobby');
    rm.clock.now += COUNTDOWN_MS;
    h.lobby.update();
    expect(h.lobby.state.phase).toBe('lobby');
  });

  it('after a match: reopen, a newcomer joins, a player leaves, close again, and the next match has the new roster', () => {
    const rm = play();
    const { h, gs, matches, run } = rm;
    run(2000);
    for (const m of matches.values()) m.close();
    matches.clear();
    h.lobby.setLocked(true);
    h.lobby.backToLobby();
    // everything as it was: the lock, the bot, the players
    expect(h.lobby.state.locked).toBe(true);
    expect(occupant(h.lobby.state)).toEqual(['H', 'A', 'B', 'open', 'open', 'bot']);
    h.lobby.setRow(3, bot(3));
    h.lobby.setRow(4, bot(4));
    const seen: ReturnType<typeof rosterChanges>[] = [];
    let prev = gs[0].lobby.state;
    gs[0].lobby.onChange = (s) => {
      seen.push(rosterChanges(prev, s));
      prev = structuredClone(s);
    };
    expect(rm.guest('C').refused[0]).toMatch(/closed/);
    h.lobby.setLocked(false);
    const d = rm.guest('D');
    expect(d.lobby.mySeat).toBe(3);
    rm.leave('B');
    h.lobby.setLocked(true);
    expect(occupant(h.lobby.state)).toEqual(['H', 'A', 'open', 'D', 'bot', 'bot']);
    expect(seen.some((c) => c.joined.includes(3))).toBe(true);
    expect(seen.some((c) => c.left.some((l) => l.seat === 2))).toBe(true);
    const setup = rm.startNow(h)!;
    expect(setup.players.map((p) => [p.faction, p.human])).toEqual([[0, true], [1, true], [3, true], [4, false], [5, false]]);
    expect(d.start()?.seat).toBe(3);
  });

  it('works out who joined and who left, and ignores a seat change', () => {
    const base = room().host().lobby.state;
    const withRow = (s: LobbyState, i: number, peer: string) => ({ ...s, rows: s.rows.map((r, j) => (j === i ? { k: 'human' as const, team: j, peer, char: 5, mobile: false } : r)) });
    const one = withRow(base, 1, 'A');
    expect(rosterChanges(null, one)).toEqual({ joined: [], left: [] });
    expect(rosterChanges(base, one)).toEqual({ joined: [1], left: [] });
    const moved = withRow({ ...base }, 4, 'A');
    expect(rosterChanges(one, moved)).toEqual({ joined: [], left: [] });
    expect(rosterChanges(moved, base)).toEqual({ joined: [], left: [{ seat: 4, char: 5 }] });
  });

  it('checks the new fields on the way in', () => {
    const s = room().host().lobby.state;
    expect(parseLobby(JSON.stringify(s))).toEqual(s);
    expect(parseLobby(JSON.stringify({ ...s, phase: 'starting' }))?.phase).toBe('starting');
    expect(parseLobby(JSON.stringify({ ...s, phase: 'counting' }))).toBeNull();
    expect(parseLobby(JSON.stringify({ ...s, locked: 'yes' }))).toBeNull();
    const { locked: _, ...noLock } = s;
    expect(parseLobby(JSON.stringify(noLock))).toBeNull();
    expect(parseLobby(JSON.stringify({ ...s, rows: s.rows.map((r) => (r.k === 'human' ? { ...r, ready: 1 } : r)) }))).toBeNull();
  });

  /** what main.ts does when a guest's lobby says the room is ours now */
  const takeOverAs = (rm: ReturnType<typeof room>, g: Guest, tokens: string[]) => {
    const st = g.lobby.state!;
    g.lobby.close();
    const connected = st.rows.flatMap((r) => (r.k === 'human' && r.peer !== g.id && r.peer !== st.host ? [r.peer] : []));
    const lobby = new HostLobby(g.r.view(LOBBY_KINDS), { build: 'test', char: 9, prefs: prefs(), seed: st.seed, clock: () => rm.clock.now, roomKey: ROOM_KEY, takeOver: { state: st, connected, tokens } });
    lobby.announce();
    return lobby;
  };

  it('a host leaving the room hands it to the next player (desktops first); everyone stays, and the lock still knows them', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A', { mobile: true });
    const b = rm.guest('B');
    h.lobby.setLocked(true);
    expect(nextHost(h.lobby.state, () => true, 'H')).toBe('B');
    let passed: { to: string; mine: boolean; tokens: string[] } | null = null;
    let promoted: HostLobby | null = null;
    b.lobby.onPass = (to, mine, tokens) => {
      passed = { to, mine, tokens };
      if (mine) promoted = takeOverAs(rm, b, tokens);
    };
    const aHeard: string[] = [];
    a.lobby.onPass = (to) => aHeard.push(to);
    expect(h.lobby.handOff()).toBe('B');
    rm.leave('H');
    expect(passed).toMatchObject({ to: 'B', mine: true });
    expect(passed!.tokens).toEqual(expect.arrayContaining([rm.tokenOf('A'), rm.tokenOf('B'), rm.tokenOf('H')]));
    expect(aHeard).toEqual(['B']);
    // A follows B's room: the old host's seat is open, the lock and the rest as they were
    expect(a.lobby.host).toBe('B');
    expect(a.lobby.state!.host).toBe('B');
    expect(a.lobby.state!.locked).toBe(true);
    expect(occupant(a.lobby.state!)).toEqual(['open', 'A', 'B', 'open', 'open', 'open']);
    // the old host reloads: a closed room still lets it back, as a player
    const h2 = rm.guest('H2');
    expect(h2.refused).toEqual([]);
    expect(h2.lobby.host).toBe('B');
    expect(h2.lobby.mySeat).toBe(0);
    // and a stranger is still turned away
    expect(rm.guest('Z').refused[0]).toMatch(/closed/);
    // the new host runs it to a match
    let go: HostGo | null = null;
    promoted!.onGo = (g) => (go = g);
    rm.startNow({ lobby: promoted! });
    a.lobby.ready();
    h2.lobby.ready();
    expect(go).not.toBeNull();
  });

  it('nobody to hand the room to: no pass; a host back from a reload runs its room again, alone in it', () => {
    const rm = room();
    const h = rm.host();
    h.lobby.fillBots();
    h.lobby.setLocked(true);
    expect(h.lobby.handOff()).toBeNull();
    const saved = structuredClone(h.lobby.state);
    rm.leave('H');
    // the reloaded page: a new peer id
    const h2 = rm.host({ id: 'H2' });
    h2.lobby.close();
    const back = new HostLobby(rm.routerOf('H2').view(LOBBY_KINDS), { build: 'test', char: 1, prefs: prefs(), seed: saved.seed, clock: () => rm.clock.now, roomKey: ROOM_KEY, takeOver: { state: saved, connected: [], reclaim: true } });
    expect(back.mySeat).toBe(0);
    expect(back.state.host).toBe('H2');
    expect(back.state.locked).toBe(true);
    expect(occupant(back.state)).toEqual(['H2', 'bot', 'bot', 'bot', 'bot', 'bot']);
    expect(back.canStart()).toBe(true);
  });

  it('after a match the map is new (a new seed), unless the host restarts it', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    const seed0 = h.lobby.state.seed;
    rm.startNow(h);
    h.lobby.backToLobby({ sameMap: true });
    expect(h.lobby.state.seed).toBe(seed0);
    rm.startNow(h);
    h.lobby.backToLobby();
    expect(h.lobby.state.seed).not.toBe(seed0);
  });

  it('Quick match rolls a new map at each Start, everyone sees it in the countdown, and it’s never small for five or more', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A');
    h.lobby.fillBots();
    h.lobby.setRandomMap(true);
    expect(a.lobby.state!.randomMap).toBe(true);
    const seen = new Set<string>();
    for (let k = 0; k < 20; k++) {
      const setup = h.lobby.start()!;
      expect(a.lobby.state!.phase).toBe('starting');
      expect(a.lobby.state!.map).toEqual(h.lobby.state.map);
      expect(setup.size).not.toBe('small');
      seen.add(h.lobby.state.seed);
      h.lobby.cancelStart();
    }
    expect(seen.size).toBeGreaterThan(1);
    // off: the host's settings stand
    h.lobby.setRandomMap(false);
    h.lobby.setMap({ size: 'small' });
    expect(h.lobby.start()!.size).toBe('small');
  });
});

describe('one token, one seat (#192)', () => {
  const sealOfRow = (s: LobbyState, i: number) => (s.rows[i] as { seal?: string }).seal;

  it('a duplicated tab (the same token) takes its seat over; the older tab is told it left', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A');
    const seat = a.lobby.mySeat;
    const dup = rm.guest('A2'); // the same token as A, A still connected
    expect(dup.refused).toEqual([]);
    expect(occupant(h.lobby.state).filter((o) => o === 'A' || o === 'A2')).toEqual(['A2']);
    expect(dup.lobby.mySeat).toBe(seat);
    expect(a.refused.at(-1)).toMatch(/another tab/);
    const seals = h.lobby.state.rows.flatMap((r) => (r.k === 'human' && r.seal ? [r.seal] : []));
    expect(new Set(seals).size).toBe(seals.length);
  });

  it('a reload into a closed, full room gets its own row back, before the host notices the old page went', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A');
    const seat = a.lobby.mySeat;
    h.lobby.fillBots();
    h.lobby.setLocked(true);
    expect(occupant(h.lobby.state).filter((o) => o === 'open')).toEqual([]);
    const a2 = rm.guest('A2');
    expect(a2.refused).toEqual([]);
    expect(a2.lobby.mySeat).toBe(seat);
    expect(occupant(h.lobby.state).filter((o) => o === 'A' || o === 'A2')).toEqual(['A2']);
    expect(sealOfRow(h.lobby.state, seat)).toBeTruthy();
  });

  it('a guest page with the host’s own token is turned away, not given the host’s seat', () => {
    const rm = room();
    const h = rm.host();
    const g = rm.guest('X', { token: rm.tokenOf('H') });
    expect(g.refused[0]).toMatch(/already hosting/);
    expect(h.lobby.state.rows[h.lobby.mySeat]).toMatchObject({ peer: 'H' });
  });

  it('a state with two rows on one seal doesn’t parse', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    rm.guest('B');
    const st = structuredClone(h.lobby.state);
    const [i, j] = st.rows.flatMap((r, k) => (r.k === 'human' && r.peer !== 'H' ? [k] : []));
    (st.rows[j] as { seal?: string }).seal = sealOfRow(st, i);
    expect(parseLobby(JSON.stringify(st))).toBeNull();
  });

  it('taking over a match needs its setup, and a reload reclaims a room only before a match', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    const st = { ...structuredClone(h.lobby.state), phase: 'playing' as const };
    const o = { build: 'test', char: 1, prefs: prefs(), seed: st.seed, clock: () => rm.clock.now, roomKey: ROOM_KEY };
    expect(() => new HostLobby(rm.routerOf('A').view(LOBBY_KINDS), { ...o, takeOver: { state: st, connected: [] } })).toThrow(/needs its setup/);
    expect(() => new HostLobby(rm.routerOf('A').view(LOBBY_KINDS), { ...o, takeOver: { state: st, connected: [], reclaim: true, setup: buildNetSetup(st) } })).toThrow(/only before a match/);
  });
});

describe('the seat token reaches the host only (#202)', () => {
  /** every peer that ever got `token`, other than `host` */
  const leakedTo = (hellos: { to: string; token: string }[], token: string, host: string) => [...new Set(hellos.filter((h) => h.token === token && h.to !== host).map((h) => h.to))];

  it('joining: the others hear a hello with no token; the host alone gets ours, and seats us by it', () => {
    const rm = room();
    rm.meetLatestFirst(true);
    const h = rm.host();
    rm.guest('A');
    const b = rm.guest('B');
    const fromB = rm.hellos().filter((x) => x.from === 'B');
    expect(fromB.filter((x) => x.to === 'A').every((x) => x.token === '')).toBe(true);
    expect(fromB.filter((x) => x.token === rm.tokenOf('B')).map((x) => x.to)).toEqual(['H']);
    expect(leakedTo(rm.hellos(), rm.tokenOf('A'), 'H')).toEqual([]);
    expect(b.lobby.mySeat).toBeGreaterThanOrEqual(0);
    expect(h.lobby.state.rows[b.lobby.mySeat]).toMatchObject({ peer: 'B' });
  });

  it('a reload mid-match: the token goes to the host alone, and the seat comes back', () => {
    const p = play({ botSecs: 30 });
    p.meetLatestFirst(true);
    p.run(3000);
    const seatB = p.matches.get('B')!.session.localSeat;
    const g = p.reload('B', 'B2');
    expect(g.refused).toEqual([]);
    expect(p.h.lobby.state.rows[seatB]).toMatchObject({ peer: 'B2' });
    expect(leakedTo(p.hellos(), p.tokenOf('B'), 'H')).toEqual([]);
  });

  it('a reload after hosting moved: the token goes to the new host alone', () => {
    const p = play({ botSecs: 30, guests: ['A', 'B', 'C'] });
    p.run(8000);
    expect(p.matches.get('H')!.handOff()).toBe(true);
    p.run(150);
    p.quit('H');
    p.run(3000);
    p.takeRoom('A');
    p.meetLatestFirst(true);
    const before = p.hellos().length;
    p.quit('B');
    p.run(1000);
    const g = p.rejoin('B', 'B2');
    expect(g.refused).toEqual([]);
    expect(g.lobby.state!.host).toBe('A');
    expect(leakedTo(p.hellos().slice(before), p.tokenOf('B'), 'A')).toEqual([]);
    // the others say who hosts now (#208)
    expect(p.answers().filter((x) => x.to === 'B2').map((x) => `${x.from}:${x.peer}`).sort()).toEqual(['A:A', 'C:A']);
  });

  it('a closed room still lets a player back by the second hello; a stranger is still refused', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A');
    const seat = a.lobby.mySeat;
    h.lobby.setLocked(true);
    const a2 = rm.guest('A2');
    expect(a2.refused).toEqual([]);
    expect(a2.lobby.mySeat).toBe(seat);
    expect(rm.guest('Z').refused[0]).toMatch(/closed/);
  });

  it('a question only asks who hosts: the answer is `host`, and no seat, room or refusal', () => {
    const rm = room();
    const h = rm.host();
    h.lobby.setLocked(true);
    const got: string[] = [];
    const t = rm.link('X');
    t.transport.onMessage = (_p, bytes) => got.push(decodeMsg(bytes)?.k ?? '?');
    t.transport.send('H', encodeMsg({ k: 'hello', proto: PROTOCOL_VERSION, build: 'test', mobile: false, char: 3, token: '', query: true }));
    expect(got).toEqual(['host']);
    expect(occupant(h.lobby.state).includes('X')).toBe(false);
  });

  it('the others only ever get a question from a newcomer, never a token', () => {
    const rm = room();
    rm.meetLatestFirst(true);
    rm.host();
    rm.guest('A');
    rm.guest('B');
    const toA = rm.hellos().filter((x) => x.from === 'B' && x.to === 'A');
    expect(toA.length).toBeGreaterThan(0);
    expect(toA.every((x) => x.query && x.token === '')).toBe(true);
  });

  it('a stranger turned away never sees the room: not when it’s closed, not mid-match', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    h.lobby.setLocked(true);
    const z = rm.guest('Z');
    let changed = 0;
    z.lobby.onChange = () => changed++;
    expect(z.refused[0]).toMatch(/closed/);
    expect(z.lobby.state).toBeNull();
    const p = play();
    p.run(2000);
    const late = p.guest('Late');
    expect(late.refused[0]).toMatch(/already started/);
    expect(late.lobby.state).toBeNull();
    expect(changed).toBe(0);
  });

  it('a page with no seat token still joins, with no seal, as before', () => {
    const rm = room();
    const h = rm.host();
    const a = rm.guest('A', { token: '' });
    expect(a.refused).toEqual([]);
    expect(a.lobby.mySeat).toBeGreaterThanOrEqual(0);
    expect((h.lobby.state.rows[a.lobby.mySeat] as { seal?: string }).seal).toBeUndefined();
  });

  it('a reload in the same tab goes straight to a host it told before: the token, with no question first', () => {
    const p = play({ botSecs: 30 });
    p.meetLatestFirst(true);
    p.run(3000);
    const seatB = p.matches.get('B')!.session.localSeat;
    p.quit('B');
    const before = p.hellos().length;
    const g = p.guest('B2', { token: p.tokenOf('B'), told: ['H'] });
    const mine = p.hellos().slice(before).filter((x) => x.from === 'B2');
    expect(mine.filter((x) => x.to === 'H').map((x) => x.query)).toEqual([false]);
    expect(mine.filter((x) => x.to !== 'H').every((x) => x.query)).toBe(true);
    expect(g.start()?.tick).toBeGreaterThan(0);
    expect(p.h.lobby.state.rows[seatB]).toMatchObject({ peer: 'B2' });
  });

  /** `id`, modified: it answers every "who hosts?" itself, and passes everything else on (#208) */
  const liar = (rm: ReturnType<typeof room>, id: string, answer: (asker: string) => Msg) => {
    const t = rm.routerOf(id).transport;
    const inner = t.onMessage;
    t.onMessage = (peer, bytes) => {
      const m = decodeMsg(bytes);
      if (m?.k === 'hello' && m.query) t.send(peer, encodeMsg(answer(peer)));
      else inner?.(peer, bytes);
    };
  };
  /** whoever ever got `token` */
  const gotToken = (rm: ReturnType<typeof room>, token: string) => [...new Set(rm.hellos().filter((x) => x.token === token).map((x) => x.to))];

  it('a peer that answers first, pretending to host, never gets the token: most players name the real host (#208)', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    rm.guest('L');
    liar(rm, 'L', () => ({ k: 'host', peer: 'L' }));
    rm.meetLatestFirst(true);
    const b = rm.guest('B', { askMs: ASK_MS });
    // L answered first; nobody gets the token before the answers are heard out
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual([]);
    rm.clock.now += ASK_MS;
    b.lobby.update();
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
    expect(h.lobby.state.rows[b.lobby.mySeat]).toMatchObject({ peer: 'B' });
    expect(rm.answers().filter((x) => x.to === 'B' && x.from !== 'L').every((x) => x.peer === 'H')).toBe(true);
  });

  it('a forged room pushed at a newcomer counts as one answer, not as the host', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    rm.guest('L');
    liar(rm, 'L', () => ({ k: 'lobby', state: JSON.stringify({ ...h.lobby.state, host: 'L' }) }));
    rm.meetLatestFirst(true);
    const b = rm.guest('B', { askMs: ASK_MS });
    rm.clock.now += ASK_MS;
    b.lobby.update();
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
    expect(b.lobby.host).toBe('H');
  });

  it('one against one: nobody gets the token; the newcomer asks again, then gives up', () => {
    const rm = room();
    rm.host();
    rm.guest('L');
    liar(rm, 'L', () => ({ k: 'host', peer: 'L' }));
    const b = rm.guest('B', { askMs: ASK_MS });
    let none = 0;
    b.lobby.onNoHost = (why) => why === 'none' && none++;
    const asks = () => rm.hellos().filter((x) => x.from === 'B' && x.query).length;
    const first = asks();
    for (let t = 0; t < 16000; t += ASK_MS) {
      rm.clock.now += ASK_MS;
      b.lobby.update();
    }
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual([]);
    expect(asks()).toBeGreaterThan(first);
    expect(none).toBe(1);
    // given up: no more questions
    const after = asks();
    for (let t = 0; t < 5000; t += ASK_MS) {
      rm.clock.now += ASK_MS;
      b.lobby.update();
    }
    expect(asks()).toBe(after);
  });

  /** step the clock in `ms` steps for `total`, delivering what's due and letting `b` decide */
  const step = (rm: ReturnType<typeof room>, b: { lobby: GuestLobby }, total: number, ms = 100) => {
    for (let t = 0; t < total; t += ms) {
      rm.clock.now += ms;
      rm.flush();
      b.lobby.update();
    }
  };

  it('a forged refusal counts as a claim to host: it doesn’t turn the newcomer away', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    rm.guest('L');
    liar(rm, 'L', () => ({ k: 'refuse', reason: 'Go away.' }));
    rm.meetLatestFirst(true);
    const b = rm.guest('B', { askMs: ASK_MS });
    step(rm, b, ASK_MS);
    expect(b.refused).toEqual([]);
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
    expect(h.lobby.state.rows[b.lobby.mySeat]).toMatchObject({ peer: 'B' });
  });

  it('a forged room that already seats the newcomer is only a claim: the newcomer takes the real host’s room', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    rm.guest('L');
    const forged = (asker: string): Msg => {
      const rows = structuredClone(h.lobby.state.rows);
      rows[rows.findIndex((r) => r.k === 'open')] = { k: 'human', team: 5, peer: asker, char: 1, mobile: false };
      return { k: 'lobby', state: JSON.stringify({ ...h.lobby.state, host: 'L', rows }) };
    };
    liar(rm, 'L', forged);
    rm.meetLatestFirst(true);
    const b = rm.guest('B', { askMs: ASK_MS });
    expect(b.lobby.host).toBeNull();
    step(rm, b, ASK_MS);
    expect(b.lobby.host).toBe('H');
    expect(b.lobby.state?.host).toBe('H');
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
  });

  it('a link that keeps flapping doesn’t hold the decision back', () => {
    const rm = room();
    rm.host();
    rm.guest('A');
    rm.guest('L');
    liar(rm, 'L', () => ({ k: 'host', peer: 'L' }));
    const b = rm.guest('B', { askMs: ASK_MS });
    for (let t = 0; t < 1000 && !b.lobby.host; t += 100) {
      if (t % 400 === 0) {
        rm.drop('B', 'L');
        rm.reconnect('B', 'L');
      }
      step(rm, b, 100);
    }
    expect(b.lobby.host).toBe('H');
    expect(rm.clock.now).toBeLessThanOrEqual(ASK_MS + 100);
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
  });

  it('a liar alone on the fastest link waits: the honest answers behind slower links still decide', () => {
    const rm = room();
    rm.host();
    rm.guest('A');
    rm.guest('L');
    liar(rm, 'L', () => ({ k: 'host', peer: 'L' }));
    // B's links to H and A take 1.5 s there and back; L answers at once
    rm.lag('B', 'H', 1500);
    rm.lag('B', 'A', 1500);
    const b = rm.guest('B', { askMs: ASK_MS });
    step(rm, b, 1400);
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual([]);
    step(rm, b, 1000);
    expect(b.lobby.host).toBe('H');
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
  });

  it('honest players dropping away don’t leave the liars a majority', () => {
    const rm = room();
    rm.host();
    rm.guest('A');
    rm.guest('L');
    rm.guest('M');
    liar(rm, 'L', () => ({ k: 'host', peer: 'L' }));
    liar(rm, 'M', () => ({ k: 'host', peer: 'L' }));
    const b = rm.guest('B', { askMs: ASK_MS });
    rm.drop('B', 'H');
    rm.drop('B', 'A');
    step(rm, b, 16000, ASK_MS);
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual([]);
  });

  it('a player out of touch with the host doesn’t vouch for it', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('A');
    rm.drop('A', 'H');
    const b = rm.guest('B', { askMs: ASK_MS });
    step(rm, b, ASK_MS * LONE_ASKS);
    expect(rm.answers().filter((x) => x.from === 'A' && x.to === 'B')).toEqual([]);
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
    expect(h.lobby.state.rows[b.lobby.mySeat]).toMatchObject({ peer: 'B' });
  });

  it('just the host and us: its word is enough, once heard out for a lone claim', () => {
    const rm = room();
    const h = rm.host();
    const b = rm.guest('B', { askMs: ASK_MS });
    rm.clock.now += ASK_MS * LONE_ASKS - 1;
    b.lobby.update();
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual([]);
    rm.clock.now += 1;
    b.lobby.update();
    expect(gotToken(rm, rm.tokenOf('B'))).toEqual(['H']);
    expect(h.lobby.state.rows[b.lobby.mySeat]).toMatchObject({ peer: 'B' });
  });
});
