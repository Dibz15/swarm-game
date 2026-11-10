import type { BotConfig } from '../sim/ai/bot';
import type { Command } from '../sim/commands';

/**
 * Multiplayer wire messages (#157), as objects. `codec.ts` turns them into
 * bytes and back; the Sequencer and NetSession only ever see these.
 *
 * Sequenced lockstep (#152): clients send `cmd`s to the sequencer, which
 * stamps each with the sender's seat and an execution tick and broadcasts
 * closed `turns`. A client steps tick T only once it holds turn T.
 *
 * A command's `p` never travels: a client's `cmd` has none (the sequencer
 * takes the seat from the connection), and a turn entry's `p` is its `seat`.
 */

/** Bumped on any wire change; a peer with another version is refused. */
export const PROTOCOL_VERSION = 10;

/** Largest snapshot chunk: safe for any WebRTC data channel. */
export const SNAP_CHUNK = 16 * 1024;
/** Most chunks in one snapshot: 4 MB, well above the largest world. */
export const MAX_SNAP_PARTS = 256;
/** A seat token's longest form (#164): the secret a reloaded page reclaims its seat with. */
export const MAX_TOKEN = 64;
/** A sequencer's handed-over state, as JSON (#166) */
export const MAX_HANDOFF = 256 * 1024;
/** Most turns one `turns` message carries (a resend batch, or the last K repeated). */
export const MAX_TURNS_PER_MSG = 64;
/** Most entries one turn holds: six seats' rate limits allow far fewer. */
export const MAX_ENTRIES_PER_TURN = 512;
/** Most control entries one turn holds. */
export const MAX_CTRL_PER_TURN = 16;
/** Most rows in a seat table. */
export const MAX_SEATS = 6;
export const MAX_NAME = 64;
export const MAX_REASON = 256;
export const MAX_BUILD = 64;
/** Largest setup a `start` carries, as JSON. */
export const MAX_SETUP = 256 * 1024;
/** Largest lobby state a `lobby` carries, as JSON. */
export const MAX_LOBBY = 16 * 1024;

/**
 * Who drives a human seat right now. `spectating`: its faction is out and
 * the player watches the rest (#183); it changes nothing in the sim, so it
 * never travels in a control entry, only in the latency table.
 */
export type SeatState = 'human' | 'away' | 'bot' | 'spectating';
export const SEAT_STATES: readonly SeatState[] = ['human', 'away', 'bot', 'spectating'];
/** The seat states a control entry can carry: the ones that change who drives the faction. */
export type CtrlSeatState = Exclude<SeatState, 'spectating'>;

/** One command in a closed turn. `cmd.p === seat`. */
export interface Entry {
  seat: number;
  /** the sender's sequence number: lets a client see its own command land */
  seq: number;
  cmd: Command;
}

/**
 * Control entries, in turn order. They apply before the turn's step, like
 * its commands. Only `seat` changes the sim (a bot takes or leaves a seat);
 * pause and resume are in the log for the record.
 */
export type Ctrl =
  | { k: 'pause'; seat: number }
  | { k: 'resume'; seat: number }
  | { k: 'seat'; seat: number; state: CtrlSeatState; bot?: SeatBot }
  /**
   * Players' worlds stopped matching at `tick` (#165): the match halts after
   * this turn, on every client at the same tick, until the host resyncs or
   * resumes it.
   */
  | { k: 'desync'; tick: number }
  /**
   * Who takes over running the match, best first (#190): seats ranked by
   * their measured round trips, published by whoever runs it, so every
   * player ranks the same way. Changes nothing in the sim.
   */
  | { k: 'rank'; seats: number[] }
  /**
   * The match's host is now this seat's player (#190): the one with pause,
   * restart, end and the room. Published when the old host left. Changes
   * nothing in the sim.
   */
  | { k: 'owner'; seat: number };

/** The bot a dropped seat gets: only difficulty and personality travel. */
export type SeatBot = Pick<BotConfig, 'difficulty' | 'personality'>;

export interface Turn {
  entries: Entry[];
  ctrl?: Ctrl[];
}

/**
 * One seat's connection, as the sequencer sees it (#161): round trip, and
 * order-to-effect delay, ms; and what the delay is made of (#198), ticks:
 * scheduling `d` (of which `hold` evens out PvP delays), and the seat's
 * jitter buffer.
 */
export interface LatRow {
  seat: number;
  state: SeatState;
  rtt: number;
  delay: number;
  d: number;
  hold: number;
  buffer: number;
}

export interface SeatInfo {
  seat: number;
  team: number;
  name: string;
  state: SeatState;
}

export type Msg =
  /**
   * client → host, first thing on a connection; `char` is the seed of the
   * character it plays as (#162); `token`, its seat secret for this room,
   * kept across reloads (#164; '' for none). Only the room's host ever gets
   * a token (#202): a client that doesn't know who hosts sends a `query`
   * (no token) to every peer, the host answers `host`, and the client says
   * hello again, with its token, to that peer alone. A peer that answers
   * pretending to host would get it; group consensus on who hosts is #208.
   */
  | { k: 'hello'; proto: number; build: string; mobile: boolean; char: number; token: string; cell?: boolean; query?: true }
  /** host → a client that asked who runs the room (#202): I do */
  | { k: 'host' }
  /** host → client: not accepted (version or build mismatch, room full) */
  | { k: 'refuse'; reason: string }
  /** host → clients: the seat table, and which row is yours (-1: none) */
  | { k: 'seats'; you: number; table: SeatInfo[] }
  /**
   * host → client: the match begins with this setup (`tick` 0), or is joined
   * again after a reload (`tick` ≥ 1: ask for a snapshot, #164). `runner`:
   * who runs the match, when it isn't the host (#190).
   */
  | { k: 'start'; setup: string; seat: number; tick: number; runner?: string }
  /** host → clients: the whole lobby (`LobbyState` as JSON, #162) */
  | { k: 'lobby'; state: string }
  /** client → host, in the lobby: the seat, team and character it wants */
  | { k: 'pick'; seat: number; team: number; char: number }
  /** client → host: built the world from `start`, ready for turns */
  | { k: 'ready' }
  /** client → host, in the lobby: ready for the next match, or not (#184; advisory) */
  | { k: 'mark'; ready: boolean }
  /**
   * host → each guest, in the lobby (#184): the host is leaving, and `to` runs
   * the room now. `tokens` (JSON, only in the one to `to`): the seat tokens of
   * everyone who has sat in the room, so a closed room still lets them back.
   */
  | { k: 'pass'; to: string; tokens: string }
  /** sequencer → clients, every couple of seconds: every human seat's latency (#161) */
  | { k: 'lat'; rows: LatRow[] }
  /** client → sequencer: one order (no `p`; the decoder gives it p = -1) */
  | { k: 'cmd'; seq: number; cmd: Command }
  /** sequencer → clients: closed turns first .. first + list.length - 1 */
  | { k: 'turns'; epoch: number; first: number; list: Turn[] }
  /**
   * client → sequencer: the last tick it holds without a gap, the last of its
   * own seqs it has seen land, its RTT estimate (ms) and jitter buffer
   * (ticks); `want` asks for missing turns [from, to].
   */
  | { k: 'ack'; tick: number; seq: number; rtt: number; buffer: number; want?: [number, number] }
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number }
  /** client → sequencer: fullHash after stepping `tick` */
  | { k: 'hash'; tick: number; hash: number }
  /** a world snapshot taken after `tick`, in `of` chunks */
  | { k: 'snap'; tick: number; part: number; of: number; bytes: Uint8Array }
  /** client → sequencer: ask to pause (on) or resume (off) */
  | { k: 'pause'; on: boolean }
  /**
   * sequencer → clients, while no turns flow: who paused, ms until play
   * resumes (-1: nobody has resumed yet), and ms until it resumes by itself
   * when the pauser's allowance runs out (#162)
   */
  | { k: 'status'; paused: boolean; by: number; resumeIn: number; auto: number }
  /** client → sequencer: take my seat back from its bot */
  | { k: 'reclaim' }
  /** client → sequencer: my page is hidden; my seat is away now, not after a silence (#164) */
  | { k: 'away' }
  /** client → host: send me a world snapshot (`tick` 0: your current world, to rejoin; #164). Host → client: your kept snapshot at `tick` (a desync, #165) */
  | { k: 'snapreq'; tick: number }
  /** host → clients: what the desync at `tick` is, as far as the host could tell (the first field that differs, #165) */
  | { k: 'desync'; tick: number; text: string }
  /**
   * every player → every other, twice a second (#166): the epoch it follows,
   * whether it still hears the host (`ok`), whether its page is hidden (then
   * it can't help elect a new host), and whether it's waiting for a snapshot
   * (`syncing`: it can vote, but has no world to host from)
   */
  /**
   * …and it measures round trips (#190): `t` is the sender's clock (ms, mod
   * 2^16), `echo` the last `t` it heard from the recipient (-1: none yet),
   * and `held` how long ago it heard it, ms
   */
  | { k: 'beat'; epoch: number; ok: boolean; hidden: boolean; syncing: boolean; t: number; echo: number; held: number }
  /** a player → whoever runs the match, every couple of seconds (#190): its round trip to each other seat, ms */
  | { k: 'links'; rtt: [number, number][] }
  /** the host → whoever runs the match (#190): do this for me (resync after a desync) */
  | { k: 'ask'; what: 'resync' }
  /** the host → whoever runs the match (#190): this seat came back on a new connection (a reload, #164) */
  | { k: 'rebind'; seat: number; peer: string }
  /** a player taking over as host (#166): send me your closed turns after `held` */
  | { k: 'claim'; epoch: number; held: number }
  /** the new host → everyone (#166): follow me; I close turns from `next` on */
  | { k: 'lead'; epoch: number; next: number }
  /** the host, leaving → its successor (#166): my state as JSON (`exportState` and who plays each seat) */
  | { k: 'handoff'; epoch: number; state: string };

export type MsgKind = Msg['k'];
