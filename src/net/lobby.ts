import { playerCharacter } from '../game/character';
import { personalityPicker, randomMap, randomSeed, seedOf, type SetupPrefs } from '../game/matchSetup';
import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import type { CaveLevel, EventLevel, MapLayout, MapSize, TerrainLevel } from '../sim/mapgen';
import type { MatchSetup } from '../sim/setup';
import { decodeMsg, encodeMsg } from './codec';
import type { MatchPeer } from './match';
import { MAX_LOBBY, MAX_SEATS, PROTOCOL_VERSION, type Msg } from './protocol';
import { isSeal, seal } from './seal';
import type { Transport } from './transport';

/**
 * The multiplayer lobby (#162): who sits where, the map, and the start. No
 * DOM and no particular transport: the UI renders `state` and calls the
 * methods; tests drive it over a loopback hub or the fake network.
 *
 * A row per colour (row = seat = faction). The host owns the state and
 * sends all of it (`lobby`) on every change: it's small, and a guest that
 * missed one is whole again with the next. A link can lose a message with no
 * word (one held while it reconnects, a send that fails), so the host also
 * sends it again every `RESEND_MS` before a match, and to a player whose
 * link comes back (#214, #215). Guests only ask (`hello`, `pick`); the host
 * decides.
 */

export type SeatRow =
  | { k: 'open'; team: number }
  | { k: 'closed'; team: number }
  | { k: 'bot'; team: number; difficulty: number; personality: Personality | 'random' }
  /**
   * `seal`: the player's seat token, sealed (#192): whoever hosts the room
   * checks a rejoining player against it, without ever learning the token
   */
  | { k: 'human'; team: number; peer: string; char: number; mobile: boolean; ready?: boolean; cell?: boolean; seal?: string };

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
  /** `starting`: Start was pressed, the countdown runs (#184) */
  phase: LobbyPhase;
  /** "Everyone's here": no newcomers until the host reopens the room (#184) */
  locked: boolean;
  map: LobbyMap;
  /** Quick match (#184): a new random map, sized for the players, at each Start */
  randomMap: boolean;
  teams: boolean;
  seed: string;
  rows: SeatRow[];
  /** how long a dropped player's seat idles before an Easy bot takes it, seconds (#164) */
  botSecs: BotSecs;
  /**
   * "Runs the match" (#190): the player whose browser runs the turn clock,
   * by peer id; absent: Auto, the best-placed player by measured links.
   */
  runner?: string;
}

export type LobbyPhase = 'lobby' | 'starting' | 'playing';
const PHASES: readonly LobbyPhase[] = ['lobby', 'starting', 'playing'];

/** Start's countdown, ms: everyone sees 3, 2, 1 before the match (#184). */
export const COUNTDOWN_MS = 3000;

/** Before a match, the host sends its state to everyone again this often, ms: a guest that missed a change catches up (#214). */
export const RESEND_MS = 3000;

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
      PHASES.includes(o.phase) &&
      typeof o.locked === 'boolean' &&
      typeof o.teams === 'boolean' &&
      typeof o.randomMap === 'boolean' &&
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
      BOT_SECS.includes(o.botSecs) &&
      (o.runner === undefined || (typeof o.runner === 'string' && o.runner.length <= 64)) &&
      uniqueSeals(o.rows);
    if (!ok) return null;
    return { host: o.host, phase: o.phase, locked: o.locked, map: { size: m.size, terrain: m.terrain, caves: m.caves, layout: m.layout, events: m.events }, randomMap: o.randomMap, teams: o.teams, seed: o.seed, rows: o.rows, botSecs: o.botSecs, ...(o.runner ? { runner: o.runner } : {}) };
  } catch {
    return null;
  }
}

/** one token, one seat (#192): no two rows share a seal */
function uniqueSeals(rows: SeatRow[]): boolean {
  const seals = rows.flatMap((r) => (r.k === 'human' && r.seal ? [r.seal] : []));
  return new Set(seals).size === seals.length;
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
      return typeof r.peer === 'string' && r.peer.length <= 64 && Number.isInteger(r.char) && r.char >= 0 && r.char <= 0xffffffff && typeof r.mobile === 'boolean' && (r.ready === undefined || typeof r.ready === 'boolean') && (r.cell === undefined || typeof r.cell === 'boolean') && (r.seal === undefined || isSeal(r.seal));
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
    out.push({ seat: i, team, peer: r.peer, mobile: r.mobile, ...(r.cell ? { cell: true } : {}) });
  });
  return out;
}

/**
 * Who arrived and who left between two lobby states (#184), by peer: each
 * client works out its own join and leave notices, so the wire carries none.
 * A player who only moved seats is neither.
 */
export function rosterChanges(prev: LobbyState | null, next: LobbyState): { joined: number[]; left: { seat: number; char: number }[] } {
  const peersOf = (s: LobbyState | null) => {
    const m = new Map<string, { seat: number; char: number }>();
    s?.rows.forEach((r, i) => r.k === 'human' && m.set(r.peer, { seat: i, char: r.char }));
    return m;
  };
  const a = peersOf(prev), b = peersOf(next);
  if (!prev) return { joined: [], left: [] };
  return {
    joined: [...b].filter(([p]) => !a.has(p)).map(([, v]) => v.seat),
    left: [...a].filter(([p]) => !b.has(p)).map(([, v]) => v),
  };
}

/** What a guest needs to start: the match, its seat, and who runs the sequencer. */
export interface StartInfo {
  setup: MatchSetup;
  seat: number;
  host: string;
  /** 0: a new match; ≥ 1: rejoining one under way, from a snapshot (#164) */
  tick: number;
  /** who runs the match, when it isn't the host (#190) */
  runner?: string;
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
  /** the host is on mobile data, where the browser says (#190: ranked after Wi-Fi and wired) */
  cell?: boolean;
  /** our own seat token for this room: passed on with hosting, so a reload gets back in (#184) */
  ownToken?: string;
  /**
   * The room's id and secret, from its link (#192): every host seals seat
   * tokens with it, so all of them seal the same token the same way.
   */
  roomKey: string;
  /**
   * Taking over a room whose host left mid-match (#166): its last state (the
   * rows, map and settings), and the players still connected.
   */
  takeOver?: {
    state: LobbyState;
    connected: string[];
    /** the seat tokens the room has seen (#184: passed on with hosting in the lobby) */
    tokens?: string[];
    /** the match under way (#192), to hand a player who comes back to it: required when `state` is mid-match */
    setup?: MatchSetup;
    /**
     * A match picked up from a save, after everyone lost touch (#191): our
     * own seat (found by our seal) is ours on this connection; every other
     * keeps its seal, for its player to rejoin by.
     */
    resume?: boolean;
    /**
     * We ran this room before a reload, and nobody took it over (#184): the
     * old host's seat is ours again, on our new connection. Only ever before
     * a match: a host that reloads mid-match comes back as a player, and
     * gets its seat back by its seal like anyone else (#192).
     */
    reclaim?: boolean;
  };
}

/**
 * Who takes over a room: the same order as hosting a match (#166), desktops
 * before phones, then by seat. `exclude`: the one leaving.
 */
export function nextHost(s: LobbyState, connected: (peer: string) => boolean, exclude: string): string | null {
  const cands = s.rows
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: Extract<SeatRow, { k: 'human' }>; i: number } => x.r.k === 'human' && x.r.peer !== exclude && connected(x.r.peer))
    .sort((a, b) => Number(a.r.mobile) - Number(b.r.mobile) || a.i - b.i);
  return cands[0]?.r.peer ?? null;
}

/** The match is go: who plays where. `seats` are the human seats and their peers (the host's is `null`: its own client). */
export interface HostGo {
  setup: MatchSetup;
  hostSeat: number;
  seats: { seat: number; team: number; peer: string | null; mobile: boolean; cell?: boolean }[];
  /** a dropped seat's idle time before its Easy bot, ms (#164) */
  botMs: number;
  /** "Runs the match" (#190): the seat chosen to run it; absent: Auto */
  runnerSeat?: number;
}

export class HostLobby {
  state: LobbyState;
  onChange: ((s: LobbyState) => void) | null = null;
  /** every guest is ready (or the wait ran out): build the sequencer now */
  onGo: ((go: HostGo) => void) | null = null;
  /** a player came back mid-match on a new connection (#164): bind their seat to `peer` */
  onRejoin: ((seat: number, peer: string, oldPeer: string) => void) | null = null;
  /** who runs the match under way, when it isn't us (#190): a rejoining player talks to them */
  runnerOf: (() => string | null) | null = null;
  /**
   * Another player runs this room's match too (#191): two picked it up from
   * their saves at once. `yieldToIt`: whether they keep it (the lower peer
   * id, so both sides agree) and we should rejoin theirs.
   */
  onRival: ((peer: string, yieldToIt: boolean) => void) | null = null;
  /** we picked this match up from a save (#191): we tell every newcomer, so a second resumer finds us */
  private readonly resumed: boolean;
  private readonly t: Transport;
  private readonly o: HostLobbyOptions;
  private readonly connected = new Set<string>();
  /** the match under way, for a rejoining player */
  private setupJson = '';
  private waiting: { go: HostGo; until: number; ready: Set<string> } | null = null;
  /** Start was pressed: the match goes at this time, unless cancelled (#184) */
  private countdownUntil = -1;
  /** the tokens of everyone who has sat in this room: they get back in when it's locked (a reload, #184) */
  private readonly seenTokens = new Set<string>();
  /** when everyone was last sent the state: `update()` sends it again after `RESEND_MS` */
  private sentAt: number;

  constructor(t: Transport, o: HostLobbyOptions) {
    this.t = t;
    this.o = o;
    this.resumed = !!o.takeOver?.resume;
    this.sentAt = o.clock();
    const p = o.prefs;
    const rows: SeatRow[] = Array.from({ length: MAX_SEATS }, (_, i) => ({ k: 'open', team: i }) as SeatRow);
    const me = Math.min(MAX_SEATS - 1, Math.max(0, p.color));
    // the room opens empty (#184): every seat but the host's is free for friends; bots come later, by "Fill with bots"
    rows[me] = { k: 'human', team: 0, peer: t.self, char: o.char >>> 0, mobile: !!o.mobile, ...(o.cell ? { cell: true } : {}), ...this.sealOf(o.ownToken) };
    this.state = {
      host: t.self,
      phase: 'lobby',
      locked: false,
      map: { size: p.size, terrain: p.terrain, caves: p.caves, layout: p.layout, events: p.events },
      randomMap: false,
      teams: p.teams,
      seed: o.seed.slice(0, MAX_SEED_TEXT),
      rows,
      botSecs: 60,
    };
    if (o.takeOver) {
      // the room as it was, run from here now; its rows carry everyone's seals, so a reload still gets back in (#192)
      const old = o.takeOver.state.host;
      // a room in a match always knows the match, to hand it to a player who comes back (#192)
      if (o.takeOver.state.phase === 'playing' && (o.takeOver.reclaim || !o.takeOver.setup)) throw new Error(o.takeOver.reclaim ? 'lobby: a reload reclaims a room only before a match' : 'lobby: taking over a match needs its setup');
      this.state = { ...structuredClone(o.takeOver.state), host: t.self };
      if (this.state.phase === 'starting') this.state.phase = 'lobby';
      for (const peer of o.takeOver.connected) this.connected.add(peer);
      for (const tok of o.takeOver.tokens ?? []) this.seenTokens.add(tok);
      if (this.state.phase === 'playing') this.setupJson = JSON.stringify(o.takeOver.setup);
      if (o.takeOver.resume) {
        const mine = seal(o.ownToken ?? '', o.roomKey);
        const seat = mine ? this.state.rows.findIndex((r) => r.k === 'human' && r.seal === mine) : -1;
        if (this.state.phase !== 'playing' || seat < 0) throw new Error('lobby: a saved match resumes mid-match, from our own seat');
        this.state.rows[seat] = { ...(this.state.rows[seat] as Extract<SeatRow, { k: 'human' }>), peer: t.self, ready: undefined };
        if (this.state.runner) delete this.state.runner;
      }
      if (o.takeOver.reclaim) {
        // back from a reload: our seat again, and nobody else is here yet
        this.state.rows = this.state.rows.map((r) => (r.k !== 'human' ? r : r.peer === old ? { ...r, peer: t.self, ready: undefined, ...this.sealOf(o.ownToken) } : { k: 'open', team: r.team }));
      }
    }
    t.onPeer = (peer, up) => {
      if (up) {
        this.connected.add(peer);
        // picked up from a save (#191): another resumer would never say hello; this way, we meet
        if (this.resumed && seatOf(this.state, peer) < 0) this.send(peer, { k: 'lobby', state: this.json() });
        // a seated player's link is back: what we sent while it was down never arrived (#214)
        else if (this.state.phase !== 'playing' && seatOf(this.state, peer) >= 0) this.send(peer, { k: 'lobby', state: this.json() });
      } else this.lost(peer);
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

  /** "Everyone's here" (on), or open the room to newcomers again (#184). */
  setLocked(on: boolean): void {
    if (this.state.locked !== on) this.edit(() => (this.state.locked = on));
  }

  /** "Runs the match" (#190): this player's browser runs the turn clock; null: Auto, by measured links. */
  setRunner(peer: string | null): void {
    const want = peer && seatOf(this.state, peer) >= 0 ? peer : undefined;
    if (this.state.runner !== want) this.edit(() => (want ? (this.state.runner = want) : delete this.state.runner));
  }

  /** Quick match (#184): roll a new random map at each Start. */
  setRandomMap(on: boolean): void {
    if (this.state.randomMap !== on) this.edit(() => (this.state.randomMap = on));
  }

  /** Every open seat gets a bot (Normal, any personality); each one's settings are then the host's to change (#184). */
  fillBots(): void {
    if (!this.state.rows.some((r) => r.k === 'open')) return;
    this.edit(() => (this.state.rows = this.state.rows.map((r) => (r.k === 'open' ? { k: 'bot', team: r.team, difficulty: 1, personality: 'random' } : r))));
  }

  /** How many guests say they're ready, of all the guests (#184). The host doesn't count: Start is its say. */
  readyCount(): { ready: number; of: number } {
    const guests = this.state.rows.filter((r): r is Extract<SeatRow, { k: 'human' }> => r.k === 'human' && r.peer !== this.t.self);
    return { ready: guests.filter((r) => r.ready).length, of: guests.length };
  }

  /** the host's own seat, team and character */
  pickOwn(seat: number, team: number, char: number): void {
    this.pick(this.t.self, seat, team, char);
  }

  /** Everyone can play: at least two sides, and a host in a seat. */
  canStart(): boolean {
    return this.state.phase === 'lobby' && this.mySeat >= 0 && players(this.state) >= 2;
  }

  /**
   * Start: everyone sees a 3, 2, 1 (#184), then `update()` sends the match.
   * Returns the setup it will start with.
   */
  start(): MatchSetup | null {
    if (!this.canStart()) return null;
    this.countdownUntil = this.o.clock() + COUNTDOWN_MS;
    this.edit(() => {
      this.state.phase = 'starting';
      // Quick match: everyone sees the rolled map during the countdown
      if (this.state.randomMap) {
        this.state.map = randomMap(players(this.state));
        this.state.seed = randomSeed();
      }
    });
    return buildNetSetup(this.state);
  }

  /** Stop the countdown: back to the room as it was. */
  cancelStart(): void {
    if (this.state.phase !== 'starting') return;
    this.countdownUntil = -1;
    this.edit(() => (this.state.phase = 'lobby'));
  }

  /** Send everyone the match; `onGo` fires once they're all ready (or `readyMs` runs out). */
  private launch(): void {
    this.countdownUntil = -1;
    const setup = buildNetSetup(this.state);
    this.edit(() => (this.state.phase = 'playing'));
    const json = JSON.stringify(setup);
    this.setupJson = json;
    const seats: HostGo['seats'] = [];
    const ready = new Set<string>();
    this.state.rows.forEach((r, i) => {
      if (r.k !== 'human') return;
      const team = setup.players.find((p) => p.faction === i)!.team;
      const cell = r.cell ? { cell: true } : {};
      if (r.peer === this.t.self) {
        seats.push({ seat: i, team, peer: null, mobile: r.mobile, ...cell });
        return;
      }
      seats.push({ seat: i, team, peer: r.peer, mobile: r.mobile, ...cell });
      this.send(r.peer, { k: 'start', setup: json, seat: i, tick: 0 });
    });
    const pinned = this.state.runner ? seatOf(this.state, this.state.runner) : -1;
    const go: HostGo = { setup, hostSeat: this.mySeat, seats, botMs: this.state.botSecs * 1000, ...(pinned >= 0 ? { runnerSeat: pinned } : {}) };
    this.waiting = { go, until: this.o.clock() + (this.o.readyMs ?? 10000), ready };
    this.update();
  }

  /**
   * After a match: everyone still here comes back; seats whose players left
   * open up. The next match gets a new map from the same settings (a new
   * seed, #184), unless `sameMap` (Restart).
   */
  backToLobby(o: { sameMap?: boolean } = {}): void {
    this.waiting = null;
    this.countdownUntil = -1;
    this.edit(() => {
      this.state.phase = 'lobby';
      if (!o.sameMap) this.state.seed = randomSeed();
      // bots keep their seats and the lock stays; everyone says "ready" afresh for the next match
      this.state.rows = this.state.rows.map((r) => (r.k !== 'human' ? r : r.peer !== this.t.self && !this.connected.has(r.peer) ? { k: 'open', team: r.team } : { ...r, ready: undefined }));
    });
  }

  update(): void {
    // before a match, everyone gets the room again now and then: a change lost on the way is made good (#214)
    if (this.state.phase !== 'playing' && this.o.clock() - this.sentAt >= RESEND_MS) this.broadcast();
    if (this.state.phase === 'starting' && this.countdownUntil >= 0 && this.o.clock() >= this.countdownUntil) {
      if (players(this.state) >= 2 && this.mySeat >= 0) this.launch();
      else this.cancelStart();
    }
    const w = this.waiting;
    if (!w) return;
    const guests = w.go.seats.filter((s) => s.peer !== null && this.connected.has(s.peer));
    if (guests.every((s) => w.ready.has(s.peer!)) || this.o.clock() >= w.until) {
      this.waiting = null;
      this.onGo?.(w.go);
    }
  }

  /**
   * The host leaves the room before a match (#184): the next player runs it
   * (the same order as hosting a match). Our seat opens, everyone is told,
   * and the one taking over gets the seat tokens. Returns who, or null when
   * nobody's left to take it (the room ends). Close the lobby a moment after,
   * so the word gets out first.
   */
  handOff(): string | null {
    if (this.state.phase === 'playing') return null; // a match moves hosting itself (#166)
    const to = nextHost(this.state, (p) => this.connected.has(p), this.t.self);
    if (!to) return null;
    this.countdownUntil = -1;
    const me = this.mySeat;
    this.edit(() => {
      this.state.phase = 'lobby';
      if (me >= 0) this.state.rows[me] = { k: 'open', team: this.state.rows[me].team };
    });
    const tokens = JSON.stringify([...new Set([...this.seenTokens, ...(this.o.ownToken ? [this.o.ownToken] : [])])]);
    for (const r of this.state.rows) if (r.k === 'human') this.send(r.peer, { k: 'pass', to, tokens: r.peer === to && tokens.length <= MAX_LOBBY ? tokens : '' });
    return to;
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
      case 'lobby': {
        // another player hosting this room, mid-match: two picked it up from their saves (#191)
        const s = parseLobby(m.state);
        if (s && s.host === peer && s.phase === 'playing' && this.state.phase === 'playing' && peer !== this.t.self) this.onRival?.(peer, peer < this.t.self);
        return;
      }
      case 'mark': {
        const seat = seatOf(this.state, peer);
        const r = this.state.rows[seat];
        if (this.state.phase !== 'lobby' || seat < 0 || r.k !== 'human' || !!r.ready === m.ready) return;
        return this.edit(() => (this.state.rows[seat] = { ...r, ready: m.ready || undefined }));
      }
      default:
        return;
    }
  }

  private hello(peer: string, m: Extract<Msg, { k: 'hello' }>): void {
    this.connected.add(peer);
    if (m.proto !== PROTOCOL_VERSION || m.build !== this.o.build) return this.send(peer, { k: 'refuse', reason: 'This room runs a different version of the game. Refresh the page to update, then open the link again.' });
    // "who runs this room?" (#202): we do, and every other player says so too (#208). The hello with the token, to us alone, decides the rest
    if (m.query) return this.send(peer, { k: 'host', peer: this.t.self });
    if (seatOf(this.state, peer) >= 0) return this.send(peer, { k: 'lobby', state: this.json() });
    // one token, one seat (#192): a seat whose seal this token opens is this player's, on a new connection (a reload, a duplicated tab)
    const s = seal(m.token, this.o.roomKey);
    const mine = s ? this.state.rows.findIndex((r) => r.k === 'human' && r.seal === s) : -1;
    if (mine >= 0) return this.rebind(peer, mine);
    if (this.state.phase === 'starting') return this.send(peer, { k: 'refuse', reason: 'The match is starting. Ask the host to let you in for the next one.' });
    if (this.state.phase === 'playing') return this.send(peer, { k: 'refuse', reason: 'This match has already started.' });
    // a closed room still lets back in anyone who sat here before (a reload, #184)
    if (this.state.locked && !(m.token && this.seenTokens.has(m.token))) return this.send(peer, { k: 'refuse', reason: 'The host has closed this room to new players. Ask them to reopen it.' });
    // an open seat, or else a bot's: bots step aside for people (#184)
    let seat = this.state.rows.findIndex((r) => r.k === 'open');
    if (seat < 0) seat = this.state.rows.findIndex((r) => r.k === 'bot');
    if (seat < 0) return this.send(peer, { k: 'refuse', reason: 'This room is full.' });
    if (m.token) this.seenTokens.add(m.token);
    this.edit(() => (this.state.rows[seat] = { k: 'human', team: this.state.rows[seat].team, peer, char: this.freeChar(m.char >>> 0, -1), mobile: m.mobile, ...(m.cell ? { cell: true } : {}), ...(s ? { seal: s } : {}) }));
  }

  /** `{ seal }` for a token, or nothing for none (#192) */
  private sealOf(token: string | undefined): { seal?: string } {
    const s = seal(token ?? '', this.o.roomKey);
    return s ? { seal: s } : {};
  }

  /**
   * Seat `seat`'s player is here on a new connection (#164, #192): a reload,
   * or the same page open twice, where the newer one has the seat. Mid-match
   * they get the match too.
   */
  private rebind(peer: string, seat: number): void {
    const row = this.state.rows[seat] as Extract<SeatRow, { k: 'human' }>;
    const old = row.peer;
    const playing = this.state.phase === 'playing';
    // our own seat: this room is already open here, in this tab
    if (old === this.t.self) return this.send(peer, { k: 'refuse', reason: 'You’re already hosting this room in another tab or window.' });
    this.edit(() => {
      this.state.rows[seat] = playing ? { ...row, peer } : { ...row, peer, ready: undefined };
      if (this.state.runner === old) this.state.runner = peer;
    });
    if (playing) {
      this.onRejoin?.(seat, peer, old);
      const runner = this.runnerOf?.() ?? null;
      this.send(peer, { k: 'start', setup: this.setupJson, seat, tick: 1, ...(runner && runner !== this.t.self ? { runner } : {}) });
    }
    if (this.connected.has(old)) {
      const what = playing ? 'joined this match' : 'opened this room';
      this.send(old, { k: 'refuse', reason: `You ${what} again from another tab or window, so this one has left it.` });
    }
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
      this.state.rows[to] = { ...row, peer, team: Math.max(0, Math.min(MAX_SEATS - 1, team | 0)), char: taken ? row.char : char >>> 0 };
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
    if (this.state.phase === 'playing') return; // in a match, the sequencer's away policy decides
    const seat = seatOf(this.state, peer);
    if (seat >= 0) this.edit(() => (this.state.rows[seat] = { k: 'open', team: this.state.rows[seat].team }));
    // too few left for a match: the countdown stops
    if (this.state.phase === 'starting' && players(this.state) < 2) this.cancelStart();
  }

  // ---- plumbing ---------------------------------------------------------------

  private json(): string {
    const j = JSON.stringify(this.state);
    if (j.length > MAX_LOBBY) throw new Error('lobby: state too large');
    return j;
  }

  private edit(fn: () => void): void {
    fn();
    this.broadcast();
    this.onChange?.(this.state);
  }

  /** the whole state to every player in the room */
  private broadcast(): void {
    const json = this.json();
    this.sentAt = this.o.clock();
    for (const r of this.state.rows) if (r.k === 'human' && r.peer !== this.t.self) this.send(r.peer, { k: 'lobby', state: json });
  }

  private send(peer: string, m: Msg): void {
    this.t.send(peer, encodeMsg(m));
  }

  /** Stop listening, and give the view back to the router: nothing of this lobby's fires after. */
  close(): void {
    this.t.onMessage = null;
    this.t.onPeer = null;
    this.t.onLink = null;
    this.t.close();
  }
}

// ---- guest ------------------------------------------------------------------

export interface GuestLobbyOptions {
  build: string;
  char: number;
  mobile: boolean;
  /** on mobile data, where the browser says (#190) */
  cell?: boolean;
  /** this room's seat token, kept across reloads (sessionStorage), to get the seat back mid-match (#164) */
  token: string;
  clock: () => number;
  /** how long to wait for a host before giving up */
  hostMs?: number;
  /**
   * peers we told our token in this room before (#202), across a reload: they
   * know it already, so one of them that comes up gets it straight away, with
   * no question first
   */
  told?: readonly string[];
  /** how long to hear answers to "who hosts?" after the last link came up (#208); `ASK_MS` */
  askMs?: number;
}

/**
 * How long a page that doesn't know who hosts listens to the answers before
 * it decides (#208), from the last new peer that came up. Links come up one
 * by one, so "everyone has answered" could be just the first peer, and that
 * may be the one lying. A claim someone else backs is decided after this; a
 * claim only the claimer makes (just the host and us, or a liar whose link
 * came up first) waits `LONE_ASKS` times as long, for honest players behind
 * slower links; after `CAP_ASKS` from the first question, new peers no
 * longer hold the decision back.
 */
export const ASK_MS = 500;
export const LONE_ASKS = 4;
const CAP_ASKS = 12;

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
  /**
   * The host left the room before a match and passed it on (#184): to us
   * (`tokens`: the seat tokens it knew; run the room from `state` now), or to
   * another player, whose lobby we follow from here.
   */
  onPass: ((to: string, mine: boolean, tokens: string[]) => void) | null = null;
  private dropped = false;
  private readonly t: Transport;
  private readonly o: GuestLobbyOptions;
  private readonly since: number;
  private gaveUp = false;
  /** who has our seat token (#202): the host we introduced ourselves to; nobody else ever gets it */
  private introducedTo: string | null = null;
  /** every peer that has our token (#202): `told`, and whoever we tell */
  private readonly told: Set<string>;
  /** we told a peer our token (#202): the app keeps the list across a reload */
  onTold: ((peer: string) => void) | null = null;
  /** "who hosts?" (#208): each answerer, and whom it named, while we don't know */
  private readonly votes = new Map<string, string>();
  /** everyone who has answered since we started asking, gone or not: a majority is of them all */
  private readonly heard = new Set<string>();
  /** the peers we asked, to ask again when the answers don't agree */
  private readonly asked = new Set<string>();
  /** peers that turned us away before we knew who hosts: if most name one of them, that's the answer */
  private readonly refusals = new Map<string, string>();
  /** every peer that has come up: a link coming back isn't a new voice to wait for */
  private readonly seen = new Set<string>();
  /** the last new peer, or the last time we asked again: the answers are counted from here */
  private quietSince: number;
  /** our first question, -1 before it: new peers stop holding the decision back `CAP_ASKS` after */
  private firstAsk = -1;
  /** the host left (its link went away): we don't vouch for it to newcomers */
  private hostGone = false;
  /** the last room taken, as it came, and from whom: a resend of it changes nothing (#214) */
  private heardJson = '';
  private heardFrom = '';

  constructor(t: Transport, o: GuestLobbyOptions) {
    this.t = t;
    this.o = o;
    this.since = o.clock();
    this.told = new Set(o.told ?? []);
    this.quietSince = this.since;
    t.onPeer = (peer, up) => {
      // a new peer may be the host: ask who is, without our token (#202); the players' answers decide who gets it
      // (#208). One we told before knows it already: straight to it. The host reconnecting in the lobby gets told
      // again who we are (it may have freed our seat)
      if (up && !this.host) {
        const now = o.clock();
        if (this.firstAsk < 0) this.firstAsk = now;
        // only a new voice restarts the wait: a link that flaps doesn't, nor does anyone once we've waited long enough
        if (!this.seen.has(peer) && now - this.firstAsk < this.askMs * CAP_ASKS) this.quietSince = now;
        if (this.told.has(peer)) this.sayHello(peer, true);
        else {
          this.asked.add(peer);
          this.sayHello(peer, false);
        }
      } else if (up && peer === this.host) {
        this.hostGone = false;
        if (this.state?.phase === 'lobby') this.sayHello(peer, true);
      }
      if (up) this.seen.add(peer);
      // a voter whose link drops keeps its vote: honest players dropping mustn't leave the rest a majority
      if (!up) this.asked.delete(peer);
      if (!up && peer === this.host) {
        this.hostGone = true;
        this.onNoHost?.(this.dropped ? 'lost' : 'left');
      }
    };
    t.onLink = (peer, state) => {
      if (peer !== this.host) return;
      this.dropped = state !== 'back';
      if (state === 'back') this.hostGone = false;
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

  /** Where finding the host stands, for the net log (#216). Peer ids cut to 6 characters. */
  debug(): string {
    const p = (x: string | null) => (x ? x.slice(0, 6) : '-');
    const votes = [...this.votes].map(([a, b]) => `${p(a)}→${p(b)}`).join(' ') || 'none';
    return `host ${p(this.host)}, told ${p(this.introducedTo)}, seat ${this.mySeat}, phase ${this.state?.phase ?? '-'}, votes ${votes}, heard ${this.heard.size}, gaveUp ${this.gaveUp}, hostGone ${this.hostGone}, dropped ${this.dropped}, open ${Math.round(this.o.clock() - this.since)} ms`;
  }

  pick(seat: number, team: number, char: number): void {
    if (this.host) this.send(this.host, { k: 'pick', seat, team, char: char >>> 0 });
  }

  /** Another player runs the room now (#166): their lobby states, from here on. They have us in it already. */
  follow(host: string): void {
    this.host = host;
    this.dropped = false;
    this.hostGone = false;
  }

  /**
   * Who we are (#162). With our seat token only to the peer that runs the
   * room (#202): a page that doesn't know who that is yet asks everyone
   * without it, and introduces itself to the peer most of them name (#208).
   */
  private sayHello(peer: string, withToken: boolean): void {
    const o = this.o;
    if (withToken) {
      this.introducedTo = peer;
      if (!this.told.has(peer)) {
        this.told.add(peer);
        this.onTold?.(peer);
      }
    }
    const who = withToken ? { token: o.token } : { token: '', query: true as const };
    this.send(peer, { k: 'hello', proto: PROTOCOL_VERSION, build: o.build, mobile: o.mobile, char: o.char >>> 0, ...who, ...(o.cell ? { cell: true } : {}) });
  }

  /** Ready for the next match, or not (#184): the host sees it in the roster. */
  mark(ready: boolean): void {
    if (this.host) this.send(this.host, { k: 'mark', ready });
  }

  /** the match from `start` is built: send turns */
  ready(): void {
    if (this.host) this.send(this.host, { k: 'ready' });
  }

  update(): void {
    if (this.decide() === 'split') {
      // the answers don't agree (a tie, or a host nobody else names), and we've heard them out: ask again (#208)
      this.votes.clear();
      this.quietSince = this.o.clock();
      for (const p of this.asked) this.sayHello(p, false);
    }
    if (!this.host && !this.gaveUp && this.o.clock() - this.since > (this.o.hostMs ?? 15000)) {
      this.gaveUp = true;
      this.forgetVotes();
      this.onNoHost?.('none');
    }
  }

  private get askMs(): number {
    return this.o.askMs ?? ASK_MS;
  }

  /**
   * Whom most players name as host (#208), once we've heard them out: the
   * peer that a strict majority of everyone who answered names, and that
   * names itself. It gets our token, and nobody else; or, if it turned us
   * away, we're turned away. `split`: heard out, and no such peer.
   */
  private decide(): 'host' | 'wait' | 'split' {
    if (this.host) return 'host';
    if (this.votes.size === 0) return 'wait';
    const quiet = this.o.clock() - this.quietSince;
    const count = new Map<string, number>();
    for (const x of this.votes.values()) count.set(x, (count.get(x) ?? 0) + 1);
    const won = [...count].find(([x, n]) => n * 2 > this.heard.size && this.votes.get(x) === x);
    if (!won) return quiet >= this.askMs * LONE_ASKS ? 'split' : 'wait';
    // backed by someone else, or only by itself: a lone claim waits longer for the others to speak up
    const [host, n] = won;
    if (quiet < this.askMs * (n >= 2 ? 1 : LONE_ASKS)) return 'wait';
    const refused = this.refusals.get(host);
    this.host = host;
    this.forgetVotes();
    if (refused !== undefined) this.onRefused?.(refused);
    else this.sayHello(host, true);
    return 'host';
  }

  private forgetVotes(): void {
    this.votes.clear();
    this.heard.clear();
    this.asked.clear();
    this.refusals.clear();
  }

  /** `from` says `named` hosts this room (#208) */
  private vote(from: string, named: string): void {
    if (this.host || this.gaveUp) return;
    this.votes.set(from, named);
    this.heard.add(from);
    this.decide();
  }

  private receive(peer: string, m: Msg): void {
    // someone asks who hosts (#208): a seated player says whom it follows. Guests seat nobody
    if (m.k === 'hello') {
      // only for a host we're in touch with: not one whose link is down, or that's gone
      if (m.query && this.host && !this.dropped && !this.hostGone && this.mySeat >= 0) this.send(peer, { k: 'host', peer: this.host });
      return;
    }
    if (this.host && peer !== this.host) return;
    switch (m.k) {
      case 'lobby': {
        const s = parseLobby(m.state);
        if (!s || s.host !== peer) return;
        // before we know who hosts, only a peer we gave our token can be it; anyone else's room, even one that
        // seats us, is its claim to host, and the others' answers decide (#208)
        if (!this.host && this.introducedTo !== peer) return this.vote(peer, peer);
        const inIt = seatOf(s, this.t.self) >= 0;
        // a host we follow that doesn't have us yet: it gets our token, and we're not in its room until it seats us (#202)
        if (!inIt && this.introducedTo !== peer) return this.sayHello(peer, true);
        this.host = peer;
        if (inIt) this.introducedTo = peer;
        // the host sends the room again now and then (#214): the same room again, from the same host, is no news
        const same = this.heardJson === m.state && this.heardFrom === peer;
        this.heardJson = m.state;
        this.heardFrom = peer;
        this.state = s;
        if (!same) this.onChange?.(s);
        return;
      }
      case 'host':
        // an answer to our question (#202): who that player says hosts (#208)
        return this.vote(peer, m.peer);
      case 'refuse':
        // turned away before we know who hosts: that peer's claim to host, and its reason, if most agree (#208)
        if (!this.host && this.introducedTo !== peer) {
          this.refusals.set(peer, m.reason);
          return this.vote(peer, peer);
        }
        this.host ??= peer;
        this.onRefused?.(m.reason);
        return;
      case 'pass': {
        if (!this.host || peer !== this.host || this.state?.phase === 'playing') return;
        let tokens: string[] = [];
        try {
          const t = m.tokens ? (JSON.parse(m.tokens) as unknown) : [];
          if (Array.isArray(t)) tokens = t.filter((x): x is string => typeof x === 'string' && x.length <= 64);
        } catch {
          /* no tokens, then */
        }
        if (m.to === this.t.self) return this.onPass?.(m.to, true, tokens);
        // follow the new host, and say hello: it answers with the room as it runs it
        this.follow(m.to);
        this.sayHello(m.to, true);
        this.onPass?.(m.to, false, []);
        return;
      }
      case 'start': {
        if (!this.host) return;
        try {
          const setup = JSON.parse(m.setup) as MatchSetup;
          this.onStart?.({ setup, seat: m.seat, host: peer, tick: m.tick, ...(m.runner ? { runner: m.runner } : {}) });
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

  /** Stop listening, and give the view back to the router: nothing of this lobby's fires after. */
  close(): void {
    this.t.onMessage = null;
    this.t.onPeer = null;
    this.t.onLink = null;
    this.t.close();
  }
}
