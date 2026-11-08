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
export const PROTOCOL_VERSION = 3;

/** Largest snapshot chunk: safe for any WebRTC data channel. */
export const SNAP_CHUNK = 16 * 1024;
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

/** Who drives a human seat right now. */
export type SeatState = 'human' | 'away' | 'bot';
export const SEAT_STATES: readonly SeatState[] = ['human', 'away', 'bot'];

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
  | { k: 'seat'; seat: number; state: SeatState; bot?: SeatBot };

/** The bot a dropped seat gets: only difficulty and personality travel. */
export type SeatBot = Pick<BotConfig, 'difficulty' | 'personality'>;

export interface Turn {
  entries: Entry[];
  ctrl?: Ctrl[];
}

/** One seat's connection, as the sequencer sees it (#161): round trip, and order-to-effect delay, ms. */
export interface LatRow {
  seat: number;
  state: SeatState;
  rtt: number;
  delay: number;
}

export interface SeatInfo {
  seat: number;
  team: number;
  name: string;
  state: SeatState;
}

export type Msg =
  /** client → host, first thing on a connection; `char` is the seed of the character it plays as (#162) */
  | { k: 'hello'; proto: number; build: string; mobile: boolean; char: number }
  /** host → client: not accepted (version or build mismatch, room full) */
  | { k: 'refuse'; reason: string }
  /** host → clients: the seat table, and which row is yours (-1: none) */
  | { k: 'seats'; you: number; table: SeatInfo[] }
  /** host → client: the match begins (or resumes) with this setup; turns from `tick` on follow */
  | { k: 'start'; setup: string; seat: number; tick: number }
  /** host → clients: the whole lobby (`LobbyState` as JSON, #162) */
  | { k: 'lobby'; state: string }
  /** client → host, in the lobby: the seat, team and character it wants */
  | { k: 'pick'; seat: number; team: number; char: number }
  /** client → host: built the world from `start`, ready for turns */
  | { k: 'ready' }
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
  | { k: 'reclaim' };

export type MsgKind = Msg['k'];
