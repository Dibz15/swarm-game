import { expect } from 'vitest';
import { loadPrefs, type SetupPrefs } from '../src/game/matchSetup';
import { COUNTDOWN_MS, GuestLobby, HostLobby, matchPeers, seatOf, type HostGo, type LobbyState, type StartInfo } from '../src/net/lobby';
import { NetMatch } from '../src/net/match';
import { LOBBY_KINDS, LoopbackHub, MATCH_KINDS, Router, type LinkState, type Transport } from '../src/net/transport';
import { Proxy } from '../src/proxy/proxy';
import { removeUnit, type World } from '../src/sim/world';

/**
 * A whole room in one process, for lobby and match tests (#162, #164): a
 * host and guests on a loopback hub, through the real lobbies into real
 * NetMatches, on one fake clock. Links can drop and come back as PeerGrace
 * reports them, and a guest can "reload": a new peer id with the same seat
 * token.
 */

export const FRAME = 1000 / 60;

export const prefs = (over: Partial<SetupPrefs> = {}): SetupPrefs => ({ ...loadPrefs(), size: 'small', color: 0, teams: false, bots: [], ...over });

/** the room's id and secret, as every host of it has them from the link (#192) */
export const ROOM_KEY = 'testroom.s3cret';

/** a guest's seat token: the same for every reload of that player */
const tokenOf = (id: string) => `token-${id.replace(/\d+$/, '')}`;

/**
 * A room on a loopback hub where everyone hears about everyone, both ways,
 * as with the real transports (the hub alone only tells those already there).
 */
export function room() {
  const hub = new LoopbackHub();
  const clock = { now: 0 };
  const routers = new Map<string, Router>();
  /** links that are down: nothing gets through either way, as when WebRTC drops */
  const cuts = new Set<string>();
  const pair = (a: string, b: string) => [a, b].sort().join('|');
  /** round trips set with `lag` (#190): messages on those links wait half of it each way */
  const lags = new Map<string, number>();
  const queue: { at: number; go: () => void }[] = [];
  const link = (id: string) => {
    const inner = hub.link(id);
    const send = (peer: string, bytes: Uint8Array) => {
      if (cuts.has(pair(id, peer))) return;
      const rtt = lags.get(pair(id, peer));
      if (!rtt) return inner.send(peer, bytes);
      // in order per link: never before what was sent earlier
      queue.push({ at: clock.now + rtt / 2, go: () => cuts.has(pair(id, peer)) || inner.send(peer, bytes) });
    };
    const t: Transport = { ...inner, send, close: () => inner.close() };
    Object.defineProperty(t, 'onMessage', { get: () => inner.onMessage, set: (f) => (inner.onMessage = f) });
    Object.defineProperty(t, 'onPeer', { get: () => inner.onPeer, set: (f) => (inner.onPeer = f) });
    const r = new Router(t);
    routers.set(id, r);
    return r;
  };
  /** what each side's transport says while a link is held open, then when it's back (PeerGrace) */
  const linkEvent = (a: string, b: string, state: LinkState) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const t = routers.get(x)!.transport;
      t.onLink?.(y, state);
      if (state === 'back') t.onPeer?.(y, true);
      if (state === 'gone') t.onPeer?.(y, false);
    }
  };
  const drop = (a: string, b: string) => {
    cuts.add(pair(a, b));
    linkEvent(a, b, 'lost');
  };
  const reconnect = (a: string, b: string) => {
    cuts.delete(pair(a, b));
    linkEvent(a, b, 'back');
  };
  const giveUp = (a: string, b: string) => linkEvent(a, b, 'gone');
  /** after the newcomer's handlers are set: tell it who's already here */
  const arrived = (id: string) => {
    for (const other of routers.keys()) if (other !== id) routers.get(id)!.transport.onPeer?.(other, true);
  };
  const host = (o: Partial<{ prefs: SetupPrefs; char: number; build: string; mobile: boolean; id: string }> = {}) => {
    const id = o.id ?? 'H';
    const r = link(id);
    const lobby = new HostLobby(r.view(LOBBY_KINDS), { build: o.build ?? 'test', char: o.char ?? 1, prefs: o.prefs ?? prefs(), seed: 'ember-tide-7', clock: () => clock.now, readyMs: 5000, mobile: o.mobile, ownToken: tokenOf(id), roomKey: ROOM_KEY });
    arrived(id);
    return { r, lobby };
  };
  const guest = (id: string, o: Partial<{ char: number; build: string; token: string; mobile: boolean }> = {}) => {
    const r = link(id);
    const lobby = new GuestLobby(r.view(LOBBY_KINDS), {
      build: o.build ?? 'test',
      char: o.char ?? id.charCodeAt(0) * 1000,
      mobile: o.mobile ?? false,
      token: o.token ?? tokenOf(id),
      clock: () => clock.now,
    });
    const refused: string[] = [];
    lobby.onRefused = (why) => refused.push(why);
    let start: StartInfo | null = null;
    lobby.onStart = (s) => (start = s);
    arrived(id);
    return { id, r, lobby, refused, start: () => start };
  };
  const leave = (id: string) => {
    routers.get(id)!.close();
    routers.delete(id);
  };
  /** `a` hears nothing from `b` and the other way round, with no word from either transport (a dead or hung peer) */
  const silence = (a: string, b: string) => cuts.add(pair(a, b));
  const heal = (a: string, b: string) => cuts.delete(pair(a, b));
  const ids = () => [...routers.keys()];
  /** send raw bytes as `from` would, straight to `to` (forged or out-of-turn messages in tests) */
  const inject = (from: string, to: string, bytes: Uint8Array) => routers.get(from)!.transport.send(to, bytes);
  const routerOf = (id: string) => routers.get(id)!;
  /** Start, and let the 3, 2, 1 run out (#184): the match is sent to everyone. */
  const startNow = (h: { lobby: HostLobby }) => {
    const setup = h.lobby.start();
    if (setup) {
      clock.now += COUNTDOWN_MS;
      h.lobby.update();
    }
    return setup;
  };
  /** The link between `a` and `b` takes `rttMs` there and back (#190). */
  const lag = (a: string, b: string, rttMs: number) => lags.set(pair(a, b), rttMs);
  /** Deliver what's due on lagged links. */
  const flush = () => {
    for (let i = 0; i < queue.length; ) {
      if (queue[i].at > clock.now) i++;
      else queue.splice(i, 1)[0].go();
    }
  };
  return { clock, host, guest, leave, drop, reconnect, giveUp, silence, heal, ids, inject, routerOf, startNow, tokenOf, lag, flush };
}

export type Guest = ReturnType<ReturnType<typeof room>['guest']>;

/**
 * host + guests (two by default, and a bot) through the lobby into running
 * NetMatches, all on one fake clock. `mobile`: which of them play on phones.
 */
export function play(o: { botSecs?: 30 | 60 | 120; guests?: string[]; mobile?: string[]; bot?: boolean; runner?: string } = {}) {
  const rm = room();
  const mobile = new Set(o.mobile ?? []);
  const bots = o.bot === false ? [] : [{ faction: 5, difficulty: 1, personality: 'expander' as const, team: 1 }];
  const h = rm.host({ prefs: prefs({ bots }), mobile: mobile.has('H') });
  // the room opens empty (#184): the host seats its bots by hand
  for (const b of bots) h.lobby.setRow(b.faction, { k: 'bot', team: b.team, difficulty: b.difficulty, personality: b.personality });
  if (o.botSecs) h.lobby.setBotSecs(o.botSecs);
  const gs = (o.guests ?? ['A', 'B']).map((id) => rm.guest(id, { mobile: mobile.has(id) }));
  if (o.runner) h.lobby.setRunner(o.runner);
  let go: HostGo | null = null;
  h.lobby.onGo = (g) => (go = g);
  const setup = rm.startNow(h)!;
  expect(setup).not.toBeNull();
  const matches = new Map<string, NetMatch>();
  const proxies = new Map<string, Proxy>();
  const add = (id: string, m: NetMatch) => {
    matches.set(id, m);
    proxies.set(id, new Proxy(m.session.localSeat, { skill: 1 }));
  };
  for (const g of gs) {
    const s = g.start()!;
    expect(s.setup).toEqual(setup);
    expect(s.seat).toBe(g.lobby.mySeat);
    add(g.id, NetMatch.guest(g.r.view(MATCH_KINDS), s.setup, s.seat, s.host, { clock: () => rm.clock.now, net: { gzipSnaps: false }, peers: matchPeers(g.lobby.state!, s.setup), botMs: g.lobby.state!.botSecs * 1000, runnerSeat: pinOf(g.lobby.state!), heartbeat: false, gzip: false }));
    g.lobby.ready();
  }
  expect(go).not.toBeNull();
  add('H', NetMatch.host(h.r.view(MATCH_KINDS), go!, { clock: () => rm.clock.now, heartbeat: false, gzip: false, net: { gzipSnaps: false } }));
  /** the room's lobby now, and whose page runs it: H's, until hosting moves (`takeRoom`, #192) */
  let owner = { id: 'H', lobby: h.lobby };
  const wire = (id: string, lobby: HostLobby) => {
    // a guest back from a reload: its seat answers to its new connection (main.ts does the same)
    lobby.onRejoin = (seat, peer) => matches.get(id)?.rebind(seat, peer);
    // who runs the match now, for a player rejoining it (#190; main.ts does the same)
    lobby.runnerOf = () => matches.get(id)?.runnerPeer ?? null;
    owner = { id, lobby };
  };
  wire('H', h.lobby);
  /**
   * Hosting moved to `id` mid-match (#166): what main.ts does on `onOwner`.
   * Its guest lobby gives way to a host lobby run from the state it last saw
   * (seals and all, #192), and everyone else's lobby follows it.
   */
  const takeRoom = (id: string): HostLobby => {
    const g = [...gs, ...extra].find((x) => x.id === id)!;
    const st = g.lobby.state!;
    g.lobby.close();
    const lobby = new HostLobby(g.r.view(LOBBY_KINDS), { build: 'test', char: 0, prefs: prefs(), seed: st.seed, clock: () => rm.clock.now, ownToken: tokenOf(id), roomKey: ROOM_KEY, takeOver: { state: st, connected: matches.get(id)!.livePeers(), setup: matches.get(id)!.session.setup } });
    wire(id, lobby);
    for (const x of [...gs, ...extra]) if (x.id !== id && matches.has(x.id)) x.lobby.follow(id);
    lobby.announce();
    return lobby;
  };
  /** players who came back on a new page (`rejoin`) */
  const extra: Guest[] = [];
  /** peers that died: no frames, nothing in or out, and no word from their transport */
  const dead = new Set<string>();
  const kill = (id: string) => {
    dead.add(id);
    for (const other of rm.ids()) if (other !== id) rm.silence(id, other);
  };
  /** players give orders (their Proxy plays) unless told to stop, to let everything in flight land */
  let ordering = true;
  const orders = (on: boolean) => (ordering = on);
  const run = (ms: number, frozen: string[] = []) => {
    for (const end = rm.clock.now + ms; rm.clock.now < end; ) {
      rm.clock.now += FRAME;
      rm.flush();
      for (const [id, m] of matches) {
        if (frozen.includes(id) || dead.has(id)) continue;
        const w = m.session.world;
        if (ordering && !m.session.syncing && !m.session.seatBot) for (const c of proxies.get(id)!.think(w)) m.session.issue(c);
        m.update();
        m.session.update(FRAME / 1000);
        w.fx = [];
        w.deaths = [];
      }
    }
  };
  /** Guest `id`'s page goes away (closed, or reloading): its match and its connection. */
  const quit = (id: string) => {
    matches.get(id)?.close();
    matches.delete(id);
    rm.leave(id);
  };
  /**
   * The player who was `id` comes back as `newId` (a new page, the same seat
   * token, #164) and rejoins from a snapshot if the host lets them.
   */
  const rejoin = (id: string, newId: string, token = tokenOf(id)): Guest => {
    const g = rm.guest(newId, { token });
    const s = g.start();
    if (s) {
      add(newId, NetMatch.guest(g.r.view(MATCH_KINDS), s.setup, s.seat, s.runner ?? s.host, { clock: () => rm.clock.now, resume: s.tick > 0, owner: seatOf(g.lobby.state!, g.lobby.state!.host), net: { gzipSnaps: false }, peers: matchPeers(g.lobby.state!, s.setup), runnerSeat: pinOf(g.lobby.state!), heartbeat: false, gzip: false }));
      // as main.ts does on the lobby's change: everyone's list of who could host has the new peer id
      for (const m of matches.values()) m.updatePeers(matchPeers(owner.lobby.state, s.setup));
      extra.push(g);
    }
    return g;
  };
  /** A reload: gone, then straight back. */
  const reload = (id: string, newId: string): Guest => {
    quit(id);
    return rejoin(id, newId);
  };
  return { ...rm, h, gs, matches, run, quit, rejoin, reload, add, kill, dead, orders, takeRoom, owner: () => owner };
}

/** The host's "Runs the match" choice, as a seat (#190; main.ts does the same) */
function pinOf(st: LobbyState): number | undefined {
  const s = st.runner ? seatOf(st, st.runner) : -1;
  return s >= 0 ? s : undefined;
}

/** Knock a faction out: its dots gone, its nests unclaimed (the sim then marks it eliminated). */
export function wipe(w: World, f: number): void {
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === f) removeUnit(w, i);
  for (const n of w.nests) if (n.owner === f) n.owner = -1;
}
