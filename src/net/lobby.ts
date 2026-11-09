import { playerCharacter } from '../game/character';
import { personalityPicker, seedOf, type SetupPrefs } from '../game/matchSetup';
import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import type { CaveLevel, EventLevel, MapLayout, MapSize, TerrainLevel } from '../sim/mapgen';
import type { MatchSetup } from '../sim/setup';
import { decodeMsg, encodeMsg } from './codec';
import type { MatchPeer } from './match';
import { MAX_LOBBY, MAX_SEATS, PROTOCOL_VERSION, type Msg } from './protocol';
import type { Transport } from './transport';

/**
 * The multiplayer lobby (#162): who sits where, the map, and the start. No
 * DOM and no particular transport: the UI renders `state` and calls the
 * methods; tests drive it over a loopback hub or the fake network.
 *
 * A row per colour (row = seat = faction). The host owns the state and
 * sends all of it (`lobby`) on every change: it's small, and a guest that
 * missed one is whole again with the next. Guests only ask (`hello`,
 * `pick`); the host decides.
 */

export type SeatRow =
  | { k: 'open'; team: number }
  | { k: 'closed'; team: number }
  | { k: 'bot'; team: number; difficulty: number; personality: Personality | 'random' }
  | { k: 'human'; team: number; peer: string; char: number; mobile: boolean };

export interface LobbyMap {
  size: MapSize;
  terrain: TerrainLevel;
  caves: CaveLevel;
  layout: MapLayout | 'random';
  events: EventLevel;
}

export interface LobbyState {
  /** the host's peer id */
  host: string;
  phase: 'lobby' | 'playing';
  map: LobbyMap;
  teams: boolean;
  seed: string;
  rows: SeatRow[];
  /** how long a dropped player's seat idles before an Easy bot takes it, seconds (#164) */
  botSecs: BotSecs;
}

/** The bot timeouts a host can choose (#164). */
export const BOT_SECS = [30, 60, 120] as const;
export type BotSecs = (typeof BOT_SECS)[number];

const SIZES: readonly MapSize[] = ['small', 'medium', 'large'];
const TERRAINS: readonly TerrainLevel[] = ['none', 'light', 'standard', 'heavy'];
const CAVES: readonly CaveLevel[] = ['off', 'belt', 'full'];
const EVENTS: readonly EventLevel[] = ['off', 'calm', 'normal', 'wild'];
const LAYOUTS: readonly (MapLayout | 'random')[] = ['random', 'classic', 'open', 'core', 'clusters', 'lanes'];
const MAX_SEED_TEXT = 64;

export const humans = (s: LobbyState) => s.rows.filter((r) => r.k === 'human').length;
export const players = (s: LobbyState) => s.rows.filter((r) => r.k === 'human' || r.k === 'bot').length;
export const seatOf = (s: LobbyState, peer: string) => s.rows.findIndex((r) => r.k === 'human' && r.peer === peer);
const nameOf = (r: SeatRow) => (r.k === 'human' ? playerCharacter(r.char).name : null);

/** The match a lobby describes: row i plays faction i; without teams, every seat is its own team. */
export function buildNetSetup(s: LobbyState): MatchSetup {
  const seed = seedOf(s.seed);
  const pick = personalityPicker(seed);
  const players: MatchSetup['players'] = [];
  s.rows.forEach((r, i) => {
    const team = s.teams ? r.team : i;
    if (r.k === 'human') players.push({ faction: i, team, human: true });
    else if (r.k === 'bot') players.push({ faction: i, team, human: false, bot: { difficulty: r.difficulty, personality: pick(r.personality) } });
  });
  return { seed, ...s.map, players };
}

/** A lobby state from JSON, or null if it isn't one (it came over the wire). */
export function parseLobby(json: string): LobbyState | null {
  try {
    const o = JSON.parse(json) as LobbyState;
    const m = o?.map;
    const ok =
      typeof o.host === 'string' &&
      (o.phase === 'lobby' || o.phase === 'playing') &&
      typeof o.teams === 'boolean' &&
      typeof o.seed === 'string' &&
      o.seed.length <= MAX_SEED_TEXT &&
      m &&
      SIZES.includes(m.size) &&
      TERRAINS.includes(m.terrain) &&
      CAVES.includes(m.caves) &&
      EVENTS.includes(m.events) &&
      LAYOUTS.includes(m.layout) &&
      Array.isArray(o.rows) &&
      o.rows.length === MAX_SEATS &&
      o.rows.every(validRow) &&
      BOT_SECS.includes(o.botSecs);
    if (!ok) return null;
    return { host: o.host, phase: o.phase, map: { size: m.size, terrain: m.terrain, caves: m.caves, layout: m.layout, events: m.events }, teams: o.teams, seed: o.seed, rows: o.rows, botSecs: o.botSecs };
  } catch {
    return null;
  }
}

function validRow(r: SeatRow): boolean {
  if (!r || !Number.isInteger(r.team) || r.team < 0 || r.team >= MAX_SEATS) return false;
  switch (r.k) {
    case 'open':
    case 'closed':
      return true;
    case 'bot':
      return [0, 1, 2].includes(r.difficulty) && (r.personality === 'random' || PERSONALITIES.includes(r.personality));
    case 'human':
      return typeof r.peer === 'string' && r.peer.length <= 64 && Number.isInteger(r.char) && r.char >= 0 && r.char <= 0xffffffff && typeof r.mobile === 'boolean';
    default:
      return false;
  }
}

/**
 * Every human seat in a lobby's match, the peer that plays it, and whether
 * it's a phone (#166): who can take over hosting, and in what order.
 */
export function matchPeers(s: LobbyState, setup: MatchSetup): MatchPeer[] {
  const out: MatchPeer[] = [];
  s.rows.forEach((r, i) => {
    if (r.k !== 'human') return;
    const team = setup.players.find((p) => p.faction === i)?.team ?? i;
    out.push({ seat: i, team, peer: r.peer, mobile: r.mobile });
  });
  return out;
}

/** What a guest needs to start: the match, its seat, and who runs the sequencer. */
export interface StartInfo {
  setup: MatchSetup;
  seat: number;
  host: string;
  /** 0: a new match; ≥ 1: rejoining one under way, from a snapshot (#164) */
  tick: number;
}

// ---- host -------------------------------------------------------------------

export interface HostLobbyOptions {
  build: string;
  /** the host's own character */
  char: number;
  prefs: SetupPrefs;
  seed: string;
  clock: () => number;
  /** how long Start waits for every guest's `ready` */
  readyMs?: number;
  /** the host plays on a phone (#166: phones take over hosting last) */
  mobile?: boolean;
  /**
   * Taking over a room whose host left mid-match (#166): its last state (the
   * rows, map and settings), and the players still connected.
   */
  takeOver?: { state: LobbyState; connected: string[] };
}

/** The match is go: who plays where. `seats` are the human seats and their peers (the host's is `null`: its own client). */
export interface HostGo {
  setup: MatchSetup;
  hostSeat: number;
  seats: { seat: number; team: number; peer: string | null; mobile: boolean }[];
  /** a dropped seat's idle time before its Easy bot, ms (#164) */
  botMs: number;
}

export class HostLobby {
  state: LobbyState;
  onChange: ((s: LobbyState) => void) | null = null;
  /** every guest is ready (or the wait ran out): build the sequencer now */
  onGo: ((go: HostGo) => void) | null = null;
  /** a player came back mid-match on a new connection (#164): bind their seat to `peer` */
  onRejoin: ((seat: number, peer: string, oldPeer: string) => void) | null = null;
  private readonly t: Transport;
  private readonly o: HostLobbyOptions;
  private readonly connected = new Set<string>();
  /**
   * Each guest's seat token (#164), never sent to anyone: a page reloaded
   * mid-match has a new peer id, and proves its seat with the token alone.
   */
  private readonly tokens = new Map<string, string>();
  /** the tokens of the match under way, by seat, frozen at Start */
  private seatTokens = new Map<number, string>();
  /** the match under way, for a rejoining player */
  private setupJson = '';
  private waiting: { go: HostGo; until: number; ready: Set<string> } | null = null;

  constructor(t: Transport, o: HostLobbyOptions) {
    this.t = t;
    this.o = o;
    const p = o.prefs;
    const rows: SeatRow[] = Array.from({ length: MAX_SEATS }, (_, i) => ({ k: 'open', team: i }) as SeatRow);
    const me = Math.min(MAX_SEATS - 1, Math.max(0, p.color));
    rows[me] = { k: 'human', team: 0, peer: t.self, char: o.char >>> 0, mobile: !!o.mobile };
    // the skirmish screen's bots, where their colours are free
    for (const b of p.bots) if (rows[b.faction]?.k === 'open') rows[b.faction] = { k: 'bot', team: Math.min(MAX_SEATS - 1, b.team), difficulty: b.difficulty, personality: b.personality };
    this.state = {
      host: t.self,
      phase: 'lobby',
      map: { size: p.size, terrain: p.terrain, caves: p.caves, layout: p.layout, events: p.events },
      teams: p.teams,
      seed: o.seed.slice(0, MAX_SEED_TEXT),
      rows,
      botSecs: 60,
    };
    if (o.takeOver) {
      // the room as it was, run from here now; seat tokens stayed with the old host
      this.state = { ...structuredClone(o.takeOver.state), host: t.self };
      for (const peer of o.takeOver.connected) this.connected.add(peer);
    }
    t.onPeer = (peer, up) => {
      if (up) this.connected.add(peer);
      else this.lost(peer);
    };
    t.onMessage = (peer, bytes) => {
      const m = decodeMsg(bytes);
      if (m) this.receive(peer, m);
    };
  }

  get mySeat(): number {
    return seatOf(this.state, this.t.self);
  }

  /** Tell everyone the room's state (and who runs it) as it is now. */
  announce(): void {
    this.edit(() => undefined);
  }

  // ---- the host's own edits ---------------------------------------------------

  setMap(map: Partial<LobbyMap>): void {
    this.edit(() => Object.assign(this.state.map, map));
  }

  setTeams(on: boolean): void {
    this.edit(() => (this.state.teams = on));
  }

  /** how long a dropped player's seat idles before an Easy bot takes it (#164) */
  setBotSecs(s: BotSecs): void {
    if (BOT_SECS.includes(s)) this.edit(() => (this.state.botSecs = s));
  }

  setSeed(text: string): void {
    this.edit(() => (this.state.seed = text.slice(0, MAX_SEED_TEXT)));
  }

  /** set an empty or bot row; a guest's row only by `kick` */
  setRow(seat: number, row: Exclude<SeatRow, { k: 'human' }>): void {
    const r = this.state.rows[seat];
    if (!r || r.k === 'human') return;
    this.edit(() => (this.state.rows[seat] = row));
  }

  kick(seat: number): void {
    const r = this.state.rows[seat];
    if (!r || r.k !== 'human' || r.peer === this.t.self) return;
    this.send(r.peer, { k: 'refuse', reason: 'The host removed you from the room.' });
    this.edit(() => (this.state.rows[seat] = { k: 'open', team: r.team }));
  }

  /** the host's own seat, team and character */
  pickOwn(seat: number, team: number, char: number): void {
    this.pick(this.t.self, seat, team, char);
  }

  /** Everyone can play: at least two sides, and a host in a seat. */
  canStart(): boolean {
    return this.state.phase === 'lobby' && this.mySeat >= 0 && players(this.state) >= 2;
  }

  /** Send everyone the match; `onGo` fires once they're all ready (or `readyMs` runs out). */
  start(): MatchSetup | null {
    if (!this.canStart()) return null;
    const setup = buildNetSetup(this.state);
    this.edit(() => (this.state.phase = 'playing'));
    const json = JSON.stringify(setup);
    this.setupJson = json;
    this.seatTokens = new Map();
    const seats: HostGo['seats'] = [];
    const ready = new Set<string>();
    this.state.rows.forEach((r, i) => {
      if (r.k !== 'human') return;
      const team = setup.players.find((p) => p.faction === i)!.team;
      if (r.peer === this.t.self) {
        seats.push({ seat: i, team, peer: null, mobile: r.mobile });
        return;
      }
      const token = this.tokens.get(r.peer);
      if (token) this.seatTokens.set(i, token);
      seats.push({ seat: i, team, peer: r.peer, mobile: r.mobile });
      this.send(r.peer, { k: 'start', setup: json, seat: i, tick: 0 });
    });
    this.waiting = { go: { setup, hostSeat: this.mySeat, seats, botMs: this.state.botSecs * 1000 }, until: this.o.clock() + (this.o.readyMs ?? 10000), ready };
    this.update();
    return setup;
  }

  /** After a match: everyone still here comes back; seats whose players left open up. */
  backToLobby(): void {
    this.waiting = null;
    this.edit(() => {
      this.state.phase = 'lobby';
      this.state.rows = this.state.rows.map((r) => (r.k === 'human' && r.peer !== this.t.self && !this.connected.has(r.peer) ? { k: 'open', team: r.team } : r));
    });
  }

  update(): void {
    const w = this.waiting;
    if (!w) return;
    const guests = w.go.seats.filter((s) => s.peer !== null && this.connected.has(s.peer));
    if (guests.every((s) => w.ready.has(s.peer!)) || this.o.clock() >= w.until) {
      this.waiting = null;
      this.onGo?.(w.go);
    }
  }

  // ---- guests -----------------------------------------------------------------

  private receive(peer: string, m: Msg): void {
    switch (m.k) {
      case 'hello':
        return this.hello(peer, m);
      case 'pick':
        return this.pick(peer, m.seat, m.team, m.char);
      case 'ready':
        this.waiting?.ready.add(peer);
        return this.update();
      default:
        return;
    }
  }

  private hello(peer: string, m: Extract<Msg, { k: 'hello' }>): void {
    this.connected.add(peer);
    if (m.proto !== PROTOCOL_VERSION || m.build !== this.o.build) return this.send(peer, { k: 'refuse', reason: 'This room runs a different version of the game. Refresh the page to update, then open the link again.' });
    if (m.token) this.tokens.set(peer, m.token);
    if (seatOf(this.state, peer) >= 0) return this.send(peer, { k: 'lobby', state: this.json() });
    if (this.state.phase !== 'lobby') {
      // a player back from a reload proves their seat with its token (#164)
      const seat = m.token ? [...this.seatTokens].find(([, t]) => t === m.token)?.[0] : undefined;
      if (seat === undefined || this.state.rows[seat]?.k !== 'human') return this.send(peer, { k: 'refuse', reason: 'This match has already started.' });
      return this.rejoin(peer, seat);
    }
    const seat = this.state.rows.findIndex((r) => r.k === 'open');
    if (seat < 0) return this.send(peer, { k: 'refuse', reason: 'This room is full.' });
    this.edit(() => (this.state.rows[seat] = { k: 'human', team: seat, peer, char: this.freeChar(m.char >>> 0, -1), mobile: m.mobile }));
  }

  /** Seat `seat`'s player is back on a new connection: hand them the match, and the seat. */
  private rejoin(peer: string, seat: number): void {
    const row = this.state.rows[seat] as Extract<SeatRow, { k: 'human' }>;
    const old = row.peer;
    this.edit(() => (this.state.rows[seat] = { ...row, peer }));
    this.onRejoin?.(seat, peer, old);
    this.send(peer, { k: 'start', setup: this.setupJson, seat, tick: 1 });
    // the same seat open twice (a duplicated tab): the newer one has it
    if (old !== peer && this.connected.has(old)) this.send(old, { k: 'refuse', reason: 'You joined this match again from another tab or window, so this one has left it.' });
  }

  private pick(peer: string, seat: number, team: number, char: number): void {
    if (this.state.phase !== 'lobby') return;
    const from = seatOf(this.state, peer);
    if (from < 0) return;
    const row = this.state.rows[from] as Extract<SeatRow, { k: 'human' }>;
    let to = from;
    if (seat !== from && this.state.rows[seat]?.k === 'open') to = seat;
    const name = playerCharacter(char >>> 0).name;
    const taken = this.state.rows.some((r, i) => i !== from && nameOf(r) === name);
    this.edit(() => {
      this.state.rows[from] = { k: 'open', team: from };
      this.state.rows[to] = { k: 'human', peer, team: Math.max(0, Math.min(MAX_SEATS - 1, team | 0)), char: taken ? row.char : char >>> 0, mobile: row.mobile };
    });
  }

  /** `want`, or the next seed after it whose name nobody else in the room has */
  private freeChar(want: number, except: number): number {
    const names = new Set(this.state.rows.map((r, i) => (i === except ? null : nameOf(r))));
    let c = want;
    for (let k = 0; k < 100 && names.has(playerCharacter(c).name); k++) c = (Math.imul(c ^ 0x9e3779b9, 0x85ebca6b) + k) >>> 0;
    return c;
  }

  private lost(peer: string): void {
    this.connected.delete(peer);
    if (this.state.phase !== 'lobby') return; // in a match, the sequencer's away policy decides
    const seat = seatOf(this.state, peer);
    if (seat >= 0) this.edit(() => (this.state.rows[seat] = { k: 'open', team: this.state.rows[seat].team }));
  }

  // ---- plumbing ---------------------------------------------------------------

  private json(): string {
    const j = JSON.stringify(this.state);
    if (j.length > MAX_LOBBY) throw new Error('lobby: state too large');
    return j;
  }

  private edit(fn: () => void): void {
    fn();
    const json = this.json();
    for (const r of this.state.rows) if (r.k === 'human' && r.peer !== this.t.self) this.send(r.peer, { k: 'lobby', state: json });
    this.onChange?.(this.state);
  }

  private send(peer: string, m: Msg): void {
    this.t.send(peer, encodeMsg(m));
  }

  close(): void {
    this.t.onMessage = null;
    this.t.onPeer = null;
  }
}

// ---- guest ------------------------------------------------------------------

export interface GuestLobbyOptions {
  build: string;
  char: number;
  mobile: boolean;
  /** this room's seat token, kept across reloads (sessionStorage), to get the seat back mid-match (#164) */
  token: string;
  clock: () => number;
  /** how long to wait for a host before giving up */
  hostMs?: number;
}

export class GuestLobby {
  state: LobbyState | null = null;
  /** the peer running this room, once it has answered */
  host: string | null = null;
  onChange: ((s: LobbyState) => void) | null = null;
  onRefused: ((reason: string) => void) | null = null;
  onStart: ((s: StartInfo) => void) | null = null;
  /** the host never answered, left, or its link dropped and didn't come back */
  onNoHost: ((why: 'none' | 'left' | 'lost') => void) | null = null;
  /** the link to the host dropped (it may reconnect), or came back */
  onHostLink: ((state: 'lost' | 'back') => void) | null = null;
  private dropped = false;
  private readonly t: Transport;
  private readonly o: GuestLobbyOptions;
  private readonly since: number;
  private gaveUp = false;

  constructor(t: Transport, o: GuestLobbyOptions) {
    this.t = t;
    this.o = o;
    this.since = o.clock();
    t.onPeer = (peer, up) => {
      // a new peer may be the host; the host reconnecting in the lobby gets told again who we are (it may have freed our seat)
      const hello = up && (!this.host || (peer === this.host && this.state?.phase === 'lobby'));
      if (hello) this.send(peer, { k: 'hello', proto: PROTOCOL_VERSION, build: o.build, mobile: o.mobile, char: o.char >>> 0, token: o.token });
      if (!up && peer === this.host) this.onNoHost?.(this.dropped ? 'lost' : 'left');
    };
    t.onLink = (peer, state) => {
      if (peer !== this.host) return;
      this.dropped = state !== 'back';
      if (state !== 'gone') this.onHostLink?.(state);
    };
    t.onMessage = (peer, bytes) => {
      const m = decodeMsg(bytes);
      if (m) this.receive(peer, m);
    };
  }

  get mySeat(): number {
    return this.state ? seatOf(this.state, this.t.self) : -1;
  }

  pick(seat: number, team: number, char: number): void {
    if (this.host) this.send(this.host, { k: 'pick', seat, team, char: char >>> 0 });
  }

  /** Another player runs the room now (#166): their lobby states, from here on. */
  follow(host: string): void {
    this.host = host;
    this.dropped = false;
  }

  /** the match from `start` is built: send turns */
  ready(): void {
    if (this.host) this.send(this.host, { k: 'ready' });
  }

  update(): void {
    if (!this.host && !this.gaveUp && this.o.clock() - this.since > (this.o.hostMs ?? 15000)) {
      this.gaveUp = true;
      this.onNoHost?.('none');
    }
  }

  private receive(peer: string, m: Msg): void {
    if (this.host && peer !== this.host) return;
    switch (m.k) {
      case 'lobby': {
        const s = parseLobby(m.state);
        if (!s || s.host !== peer) return;
        this.host = peer;
        this.state = s;
        this.onChange?.(s);
        return;
      }
      case 'refuse':
        this.host ??= peer;
        this.onRefused?.(m.reason);
        return;
      case 'start': {
        if (!this.host) return;
        try {
          const setup = JSON.parse(m.setup) as MatchSetup;
          this.onStart?.({ setup, seat: m.seat, host: peer, tick: m.tick });
        } catch {
          /* a host that sends a bad setup gets no game */
        }
        return;
      }
      default:
        return;
    }
  }

  private send(peer: string, m: Msg): void {
    this.t.send(peer, encodeMsg(m));
  }

  close(): void {
    this.t.onMessage = null;
    this.t.onPeer = null;
  }
}
