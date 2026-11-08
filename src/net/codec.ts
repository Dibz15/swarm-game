import { PERSONALITIES } from '../sim/ai/bot';
import type { Command } from '../sim/commands';
import { FACTION_UNIT_CAP, NEUTRAL } from '../sim/constants';
import { QUANTUM } from '../sim/sanitize';
import {
  MAX_BUILD, MAX_CTRL_PER_TURN, MAX_ENTRIES_PER_TURN, MAX_LOBBY, MAX_NAME, MAX_REASON, MAX_SEATS, MAX_SETUP, MAX_TURNS_PER_MSG,
  SEAT_STATES, SNAP_CHUNK, type Ctrl, type Entry, type Msg, type MsgKind, type SeatInfo, type Turn,
} from './protocol';

/**
 * Binary codec for the wire messages (#157).
 *
 * - Integers are unsigned LEB128 varints; signed ones are zigzagged first.
 * - Coordinates travel as integers on the 1/16 px grid commands are
 *   normalized to at issue time (`normalizeCommand`).
 * - uid and nest lists are ascending (also from `normalizeCommand`), so they
 *   go as the first value then the gaps: a few bytes per thousand units.
 * - A turn's header packs its entry count and a has-ctrl bit, so an empty
 *   turn costs one byte inside a `turns` message.
 *
 * `encodeMsg` throws on anything a normalized, sanitized command can't be
 * (a bug at the caller). `decodeMsg` never throws: bad bytes give null.
 */

// ---- writer -----------------------------------------------------------------

class Writer {
  private buf = new Uint8Array(64);
  private o = 0;

  private room(n: number): void {
    if (this.o + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.o + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.o));
    this.buf = b;
  }

  u8(v: number): void {
    this.room(1);
    this.buf[this.o++] = v;
  }

  /** unsigned varint, any safe integer */
  uv(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`codec: not a non-negative integer: ${v}`);
    this.room(8);
    while (v >= 0x80) {
      this.buf[this.o++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.o++] = v;
  }

  /** signed varint (zigzag) */
  sv(v: number): void {
    if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_ZIG) throw new Error(`codec: not an integer: ${v}`);
    this.uv(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  f64(v: number): void {
    this.room(8);
    new DataView(this.buf.buffer).setFloat64(this.o, v, true);
    this.o += 8;
  }

  bytes(b: Uint8Array): void {
    this.uv(b.length);
    this.room(b.length);
    this.buf.set(b, this.o);
    this.o += b.length;
  }

  str(s: string, max: number): void {
    const b = enc.encode(s);
    if (b.length > max) throw new Error(`codec: string longer than ${max} bytes`);
    this.bytes(b);
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.o);
  }
}

// ---- reader -----------------------------------------------------------------

class Bad extends Error {}

const MAX_ZIG = Math.floor(Number.MAX_SAFE_INTEGER / 2);

class Reader {
  o = 0;
  private dv: DataView;

  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  u8(): number {
    if (this.o >= this.b.length) throw new Bad();
    return this.b[this.o++];
  }

  uv(): number {
    let v = 0, mul = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      v += (byte & 0x7f) * mul;
      if (!(byte & 0x80)) {
        // no overlong forms: a trailing zero byte would let one value have many encodings
        if (i > 0 && byte === 0) throw new Bad();
        if (!Number.isSafeInteger(v)) throw new Bad();
        return v;
      }
      mul *= 0x80;
    }
    throw new Bad();
  }

  /** an unsigned varint no larger than max */
  upTo(max: number): number {
    const v = this.uv();
    if (v > max) throw new Bad();
    return v;
  }

  sv(): number {
    const z = this.uv();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  f64(): number {
    if (this.o + 8 > this.b.length) throw new Bad();
    const v = this.dv.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }

  bytes(max: number): Uint8Array {
    const n = this.upTo(max);
    if (this.o + n > this.b.length) throw new Bad();
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }

  str(max: number): string {
    return dec.decode(this.bytes(max));
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new Bad();
    return v === 1;
  }

  end(): void {
    if (this.o !== this.b.length) throw new Bad();
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---- commands ---------------------------------------------------------------

const CMD_TYPES = ['move', 'rally', 'upgrade', 'surge', 'nova', 'fortify', 'barrage', 'blink', 'lockdown', 'summon', 'boon'] as const;
const CMD_INDEX = new Map<string, number>(CMD_TYPES.map((t, i) => [t, i]));

function coord(w: Writer, v: number): void {
  const q = v * QUANTUM;
  if (!Number.isInteger(q)) throw new Error(`codec: coordinate ${v} isn't on the 1/${QUANTUM} grid (normalizeCommand first)`);
  w.sv(q);
}

const readCoord = (r: Reader) => r.sv() / QUANTUM;

/** Ascending, no repeats: count, first, then gaps (each ≥ 1). */
function ids(w: Writer, list: number[], max: number): void {
  if (list.length > max) throw new Error(`codec: list longer than ${max}`);
  w.uv(list.length);
  for (let k = 0; k < list.length; k++) {
    if (k === 0) w.sv(list[0]);
    else if (list[k] > list[k - 1]) w.uv(list[k] - list[k - 1]);
    else throw new Error('codec: id list not ascending (normalizeCommand first)');
  }
}

function readIds(r: Reader, max: number): number[] {
  const n = r.upTo(max);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    let v: number;
    if (k === 0) v = r.sv();
    else {
      const gap = r.uv();
      if (gap === 0) throw new Bad();
      v = out[k - 1] + gap;
      if (!Number.isSafeInteger(v)) throw new Bad();
    }
    out.push(v);
  }
  return out;
}

/** A command without its `p`. */
function writeCmd(w: Writer, c: Command): void {
  const t = CMD_INDEX.get(c.t);
  if (t === undefined) throw new Error(`codec: unknown command ${c.t}`);
  w.u8(t);
  switch (c.t) {
    case 'move':
      ids(w, c.units, FACTION_UNIT_CAP);
      coord(w, c.x);
      coord(w, c.y);
      w.sv(c.nest);
      return;
    case 'rally':
      ids(w, c.nests, MAX_NESTS);
      coord(w, c.x);
      coord(w, c.y);
      return;
    case 'upgrade':
    case 'lockdown':
      w.uv(c.nest);
      return;
    case 'surge':
    case 'nova':
    case 'fortify':
      ids(w, c.units, FACTION_UNIT_CAP);
      return;
    case 'barrage':
      coord(w, c.x);
      coord(w, c.y);
      return;
    case 'blink':
      ids(w, c.units, FACTION_UNIT_CAP);
      coord(w, c.x);
      coord(w, c.y);
      return;
    case 'summon':
      w.f64(c.secs);
      return;
    case 'boon':
      w.uv(c.k);
  }
}

/** Nest lists: far more than any map has. */
const MAX_NESTS = 1024;

function readCmd(r: Reader, p: number): Command {
  const t = CMD_TYPES[r.u8()];
  switch (t) {
    case 'move': {
      const units = readIds(r, FACTION_UNIT_CAP);
      const x = readCoord(r), y = readCoord(r);
      return { t, p, units, x, y, nest: r.sv() };
    }
    case 'rally': {
      const nests = readIds(r, MAX_NESTS);
      const x = readCoord(r), y = readCoord(r);
      return { t, p, nests, x, y };
    }
    case 'upgrade':
    case 'lockdown':
      return { t, p, nest: r.uv() };
    case 'surge':
    case 'nova':
    case 'fortify':
      return { t, p, units: readIds(r, FACTION_UNIT_CAP) };
    case 'barrage': {
      const x = readCoord(r), y = readCoord(r);
      return { t, p, x, y };
    }
    case 'blink': {
      const units = readIds(r, FACTION_UNIT_CAP);
      const x = readCoord(r), y = readCoord(r);
      return { t, p, units, x, y };
    }
    case 'summon':
      return { t, p, secs: r.f64() };
    case 'boon':
      return { t, p, k: r.uv() };
    default:
      throw new Bad();
  }
}

// ---- turns ------------------------------------------------------------------

function seat(w: Writer, s: number): void {
  if (!Number.isInteger(s) || s < 0 || s >= NEUTRAL) throw new Error(`codec: bad seat ${s}`);
  w.u8(s);
}

function readSeat(r: Reader): number {
  const s = r.u8();
  if (s >= NEUTRAL) throw new Bad();
  return s;
}

const CTRL_KINDS = ['pause', 'resume', 'seat'] as const;

function writeCtrl(w: Writer, c: Ctrl): void {
  const k = CTRL_KINDS.indexOf(c.k);
  if (k < 0) throw new Error(`codec: unknown control entry ${c.k}`);
  w.u8(k);
  seat(w, c.seat);
  if (c.k !== 'seat') return;
  const st = SEAT_STATES.indexOf(c.state);
  if (st < 0) throw new Error(`codec: bad seat state ${c.state}`);
  // state in the low bits, a has-bot flag above
  w.u8(st | (c.bot ? 4 : 0));
  if (c.bot) {
    const pi = PERSONALITIES.indexOf(c.bot.personality);
    if (pi < 0 || !Number.isInteger(c.bot.difficulty) || c.bot.difficulty < 0 || c.bot.difficulty > 3) throw new Error('codec: bad seat bot');
    w.u8(c.bot.difficulty * 4 + pi);
  }
}

function readCtrl(r: Reader): Ctrl {
  const k = CTRL_KINDS[r.u8()];
  if (!k) throw new Bad();
  const s = readSeat(r);
  if (k !== 'seat') return { k, seat: s };
  const b = r.u8();
  const state = SEAT_STATES[b & 3];
  if (!state || b > 7) throw new Bad();
  if (!(b & 4)) return { k, seat: s, state };
  const bb = r.u8();
  const personality = PERSONALITIES[bb & 3];
  if (bb >= 16 || !personality) throw new Bad();
  return { k, seat: s, state, bot: { difficulty: bb >> 2, personality } };
}

function writeTurn(w: Writer, t: Turn): void {
  if (t.entries.length > MAX_ENTRIES_PER_TURN) throw new Error('codec: turn too long');
  const ctrl = t.ctrl?.length ? t.ctrl : null;
  if (ctrl && ctrl.length > MAX_CTRL_PER_TURN) throw new Error('codec: too many control entries');
  w.uv(t.entries.length * 2 + (ctrl ? 1 : 0));
  for (const e of t.entries) {
    if (e.cmd.p !== e.seat) throw new Error('codec: entry p differs from its seat');
    seat(w, e.seat);
    w.uv(e.seq);
    writeCmd(w, e.cmd);
  }
  if (ctrl) {
    w.uv(ctrl.length - 1);
    for (const c of ctrl) writeCtrl(w, c);
  }
}

function u32(w: Writer, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error('codec: not a u32');
  w.uv(v);
}

function readTurn(r: Reader): Turn {
  const head = r.upTo(MAX_ENTRIES_PER_TURN * 2 + 1);
  const n = Math.floor(head / 2);
  const entries: Entry[] = [];
  for (let k = 0; k < n; k++) {
    const s = readSeat(r);
    const seq = r.uv();
    entries.push({ seat: s, seq, cmd: readCmd(r, s) });
  }
  if (!(head & 1)) return { entries };
  const nc = r.upTo(MAX_CTRL_PER_TURN - 1) + 1;
  const ctrl: Ctrl[] = [];
  for (let k = 0; k < nc; k++) ctrl.push(readCtrl(r));
  return { entries, ctrl };
}

// ---- messages ---------------------------------------------------------------

const KINDS = ['hello', 'refuse', 'seats', 'start', 'cmd', 'turns', 'ack', 'ping', 'pong', 'hash', 'snap', 'pause', 'status', 'reclaim', 'lobby', 'pick', 'ready'] as const;
const KIND_INDEX = new Map<string, number>(KINDS.map((k, i) => [k, i]));

/** The kind of the message in `bytes` from its first byte alone (for routing), or null. */
export function msgKind(bytes: Uint8Array): MsgKind | null {
  return bytes.length ? (KINDS[bytes[0]] ?? null) : null;
}

export function encodeMsg(m: Msg): Uint8Array {
  const w = new Writer();
  w.u8(KIND_INDEX.get(m.k)!);
  switch (m.k) {
    case 'hello':
      w.uv(m.proto);
      w.str(m.build, MAX_BUILD);
      w.u8(m.mobile ? 1 : 0);
      u32(w, m.char);
      break;
    case 'refuse':
      w.str(m.reason, MAX_REASON);
      break;
    case 'seats':
      w.sv(m.you);
      if (m.table.length > MAX_SEATS) throw new Error('codec: seat table too long');
      w.uv(m.table.length);
      for (const s of m.table) {
        seat(w, s.seat);
        w.uv(s.team);
        w.str(s.name, MAX_NAME);
        const st = SEAT_STATES.indexOf(s.state);
        if (st < 0) throw new Error(`codec: bad seat state ${s.state}`);
        w.u8(st);
      }
      break;
    case 'start':
      w.str(m.setup, MAX_SETUP);
      seat(w, m.seat);
      w.uv(m.tick);
      break;
    case 'cmd':
      w.uv(m.seq);
      writeCmd(w, m.cmd);
      break;
    case 'turns':
      if (m.list.length === 0 || m.list.length > MAX_TURNS_PER_MSG) throw new Error('codec: bad turn count');
      w.uv(m.epoch);
      w.uv(m.first);
      w.uv(m.list.length - 1);
      for (const t of m.list) writeTurn(w, t);
      break;
    case 'ack':
      w.uv(m.tick);
      w.uv(m.seq);
      w.uv(Math.min(65535, Math.max(0, Math.round(m.rtt))));
      w.uv(m.buffer * 2 + (m.want ? 1 : 0));
      if (m.want) {
        w.uv(m.want[0]);
        w.uv(m.want[1] - m.want[0]);
      }
      break;
    case 'ping':
    case 'pong':
      w.f64(m.t);
      break;
    case 'hash':
      w.uv(m.tick);
      if (!Number.isInteger(m.hash) || m.hash < 0 || m.hash > 0xffffffff) throw new Error('codec: hash is not a u32');
      w.uv(m.hash);
      break;
    case 'snap':
      if (m.bytes.length > SNAP_CHUNK || m.part >= m.of) throw new Error('codec: bad snapshot chunk');
      w.uv(m.tick);
      w.uv(m.part);
      w.uv(m.of);
      w.bytes(m.bytes);
      break;
    case 'pause':
      w.u8(m.on ? 1 : 0);
      break;
    case 'status':
      w.u8(m.paused ? 1 : 0);
      w.sv(m.by);
      w.sv(Math.round(m.resumeIn));
      w.uv(Math.max(0, Math.round(m.auto)));
      break;
    case 'reclaim':
    case 'ready':
      break;
    case 'lobby':
      w.str(m.state, MAX_LOBBY);
      break;
    case 'pick':
      seat(w, m.seat);
      if (!Number.isInteger(m.team) || m.team < 0 || m.team > 255) throw new Error('codec: bad team');
      w.uv(m.team);
      u32(w, m.char);
      break;
  }
  return w.done();
}

/** The message in `bytes`, or null if they aren't exactly one well-formed message. */
export function decodeMsg(bytes: Uint8Array): Msg | null {
  try {
    const r = new Reader(bytes);
    const m = readMsg(r);
    r.end();
    return m;
  } catch {
    // Bad bytes, or a TextDecoder rejecting invalid UTF-8: either way, not a message.
    return null;
  }
}

function readMsg(r: Reader): Msg {
  const k = KINDS[r.u8()];
  switch (k) {
    case 'hello': {
      const proto = r.uv(), build = r.str(MAX_BUILD), mobile = r.bool();
      return { k, proto, build, mobile, char: r.upTo(0xffffffff) };
    }
    case 'refuse':
      return { k, reason: r.str(MAX_REASON) };
    case 'seats': {
      const you = r.sv();
      const n = r.upTo(MAX_SEATS);
      const table: SeatInfo[] = [];
      for (let i = 0; i < n; i++) {
        const s = readSeat(r), team = r.uv(), name = r.str(MAX_NAME);
        const state = SEAT_STATES[r.u8()];
        if (!state) throw new Bad();
        table.push({ seat: s, team, name, state });
      }
      return { k, you, table };
    }
    case 'start': {
      const setup = r.str(MAX_SETUP), s = readSeat(r);
      return { k, setup, seat: s, tick: r.uv() };
    }
    case 'cmd': {
      const seq = r.uv();
      return { k, seq, cmd: readCmd(r, -1) };
    }
    case 'turns': {
      const epoch = r.uv(), first = r.uv();
      const n = r.upTo(MAX_TURNS_PER_MSG - 1) + 1;
      const list: Turn[] = [];
      for (let i = 0; i < n; i++) list.push(readTurn(r));
      return { k, epoch, first, list };
    }
    case 'ack': {
      const tick = r.uv(), seq = r.uv(), rtt = r.upTo(65535), bw = r.uv();
      const m: Msg = { k, tick, seq, rtt, buffer: Math.floor(bw / 2) };
      if (bw & 1) {
        const from = r.uv();
        m.want = [from, from + r.uv()];
      }
      return m;
    }
    case 'ping':
    case 'pong':
      return { k, t: r.f64() };
    case 'hash': {
      const tick = r.uv();
      return { k, tick, hash: r.upTo(0xffffffff) };
    }
    case 'snap': {
      const tick = r.uv(), part = r.uv(), of = r.uv();
      if (part >= of) throw new Bad();
      return { k, tick, part, of, bytes: r.bytes(SNAP_CHUNK) };
    }
    case 'pause':
      return { k, on: r.bool() };
    case 'status': {
      const paused = r.bool(), by = r.sv(), resumeIn = r.sv();
      return { k, paused, by, resumeIn, auto: r.uv() };
    }
    case 'reclaim':
    case 'ready':
      return { k };
    case 'lobby':
      return { k, state: r.str(MAX_LOBBY) };
    case 'pick': {
      const s = readSeat(r), team = r.upTo(255);
      return { k, seat: s, team, char: r.upTo(0xffffffff) };
    }
    default:
      throw new Bad();
  }
}
