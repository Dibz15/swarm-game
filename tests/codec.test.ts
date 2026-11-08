import { describe, expect, it } from 'vitest';
import { decodeMsg, encodeMsg } from '../src/net/codec';
import { MAX_TURNS_PER_MSG, PROTOCOL_VERSION, SNAP_CHUNK, type Msg, type Turn } from '../src/net/protocol';
import type { Command } from '../src/sim/commands';
import { TICK_HZ } from '../src/sim/constants';
import { Rng } from '../src/sim/rng';
import { normalizeCommand } from '../src/sim/sanitize';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { botMatch } from './helpers';

/** Every command variant, as a client issues them (normalized). */
const CMDS: Command[] = [
  { t: 'move', p: 2, units: [3, 4, 90, 7001], x: 120.5, y: 33.0625, nest: 4 },
  { t: 'move', p: 2, units: [], x: 0, y: 0, nest: -1 },
  { t: 'rally', p: 2, nests: [0, 3, 11], x: 999.9375, y: 1 },
  { t: 'upgrade', p: 2, nest: 7 },
  { t: 'surge', p: 2, units: [1] },
  { t: 'nova', p: 2, units: [5, 6, 7, 8] },
  { t: 'fortify', p: 2, units: [100, 200] },
  { t: 'barrage', p: 2, x: 4, y: 1500.25 },
  { t: 'blink', p: 2, units: [12], x: 300, y: 300 },
  { t: 'lockdown', p: 2, nest: 0 },
  { t: 'summon', p: 2, secs: 12.345 },
  { t: 'boon', p: 2, k: 2 },
];

const roundTrip = (m: Msg) => decodeMsg(encodeMsg(m));

const turnsMsg = (first: number, list: Turn[]): Msg => ({ k: 'turns', epoch: 3, first, list });

describe('wire codec (#157)', () => {
  it('round-trips every command, in a cmd and in a turn', () => {
    for (const cmd of CMDS) {
      expect(normalizeCommand(cmd)).toBe(cmd); // the fixtures are already canonical
      // a client's cmd carries no p: it decodes as -1 until the sequencer binds it
      expect(roundTrip({ k: 'cmd', seq: 77, cmd })).toEqual({ k: 'cmd', seq: 77, cmd: { ...cmd, p: -1 } });
      const m = turnsMsg(1234, [{ entries: [{ seat: 2, seq: 9, cmd }] }]);
      expect(roundTrip(m)).toEqual(m);
    }
  });

  it('round-trips every message kind', () => {
    const msgs: Msg[] = [
      { k: 'hello', proto: PROTOCOL_VERSION, build: 'abc1234', mobile: true, name: 'Zoë 🐝' },
      { k: 'refuse', reason: 'build mismatch: refresh the page' },
      { k: 'seats', you: 1, table: [{ seat: 0, team: 0, name: 'host', state: 'human' }, { seat: 3, team: 1, name: '', state: 'bot' }] },
      { k: 'seats', you: -1, table: [] },
      { k: 'start', setup: JSON.stringify(botMatch(4)), seat: 5, tick: 0 },
      turnsMsg(0, [{ entries: [] }]),
      turnsMsg(99999, [
        { entries: CMDS.map((cmd, i) => ({ seat: 2, seq: i + 1, cmd })), ctrl: [{ k: 'pause', seat: 2 }] },
        { entries: [] },
        {
          entries: [],
          ctrl: [
            { k: 'resume', seat: 0 },
            { k: 'seat', seat: 4, state: 'away' },
            { k: 'seat', seat: 4, state: 'bot', bot: { difficulty: 0, personality: 'opportunist' } },
            { k: 'seat', seat: 4, state: 'human' },
          ],
        },
      ]),
      { k: 'ack', tick: 450, seq: 12, rtt: 287, buffer: 4 },
      { k: 'ack', tick: 450, seq: 0, rtt: 0, buffer: 0, want: [451, 470] },
      { k: 'ping', t: 123456.789 },
      { k: 'pong', t: 0.5 },
      { k: 'hash', tick: 900, hash: 0xdeadbeef },
      { k: 'snap', tick: 300, part: 2, of: 3, bytes: new Uint8Array(SNAP_CHUNK).map((_, i) => i * 7) },
      { k: 'pause', on: true },
      { k: 'status', paused: true, by: 3, resumeIn: -1 },
      { k: 'status', paused: false, by: 0, resumeIn: 2500 },
      { k: 'reclaim' },
    ];
    for (const m of msgs) expect(roundTrip(m)).toEqual(m);
  });

  it('keeps empty turns tiny, and long uid lists compact', () => {
    // a late tick: 3-byte varint
    expect(encodeMsg(turnsMsg(30 * 60 * 60 * 5, [{ entries: [] }])).length).toBeLessThanOrEqual(8);
    // each extra empty turn in a batch costs one byte
    const ten = encodeMsg(turnsMsg(5000, Array.from({ length: 10 }, () => ({ entries: [] }))));
    expect(ten.length).toBe(encodeMsg(turnsMsg(5000, [{ entries: [] }])).length + 9);

    // 1000 real uids: everything alive after a long bot match, then sparser synthetic gaps
    const w = createWorld({ ...botMatch(5, 6, 'large') });
    for (let t = 0; t < 240 * TICK_HZ && !w.over; t++) {
      step(w, []);
      w.fx = [];
      w.deaths = [];
    }
    const alive: number[] = [];
    for (let i = 0; i < w.n; i++) if (w.alive[i]) alive.push(w.uid[i]);
    alive.sort((a, b) => a - b);
    const rng = new Rng(9);
    let u = alive.at(-1) ?? 1;
    while (alive.length < 1000) alive.push((u += 1 + Math.floor(rng.next() * 60)));
    const units = alive.slice(0, 1000);
    const move = encodeMsg({ k: 'cmd', seq: 400, cmd: { t: 'move', p: 0, units, x: 1800.5, y: 1200.25, nest: 12 } });
    expect(move.length).toBeLessThanOrEqual(1600);
    const turn = encodeMsg(turnsMsg(7200, [{ entries: [{ seat: 0, seq: 400, cmd: { t: 'move', p: 0, units, x: 1800.5, y: 1200.25, nest: 12 } }] }]));
    expect(turn.length).toBeLessThanOrEqual(1600);
  });

  it('refuses to encode what a normalized command never is', () => {
    expect(() => encodeMsg({ k: 'cmd', seq: 1, cmd: { t: 'barrage', p: 0, x: 1 / 3, y: 0 } })).toThrow(/grid/);
    expect(() => encodeMsg({ k: 'cmd', seq: 1, cmd: { t: 'nova', p: 0, units: [3, 1] } })).toThrow(/ascending/);
    expect(() => encodeMsg({ k: 'cmd', seq: -1, cmd: { t: 'nova', p: 0, units: [] } })).toThrow();
    expect(() => encodeMsg(turnsMsg(0, [{ entries: [{ seat: 1, seq: 1, cmd: { t: 'boon', p: 2, k: 0 } }] }]))).toThrow(/seat/);
    expect(() => encodeMsg(turnsMsg(0, [{ entries: [{ seat: 6, seq: 1, cmd: { t: 'boon', p: 6, k: 0 } }] }]))).toThrow(/seat/);
    expect(() => encodeMsg(turnsMsg(0, []))).toThrow();
    expect(() => encodeMsg(turnsMsg(0, Array.from({ length: MAX_TURNS_PER_MSG + 1 }, () => ({ entries: [] }))))).toThrow();
  });

  it('decodes garbage to null and never throws', () => {
    const rng = new Rng(2024);
    const byte = () => Math.floor(rng.next() * 256);
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([255]),
      new Uint8Array([5, 0, 0, 0]), // turns with... a truncated body
      new Uint8Array([7, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), // an endless varint
      new Uint8Array([9, 0x81, 0x00, 0]), // an overlong varint
      new Uint8Array([0, 1, 2, 0xc3, 0x28, 0, 0]), // invalid UTF-8 in hello
    ];
    for (let i = 0; i < 3000; i++) samples.push(Uint8Array.from({ length: Math.floor(rng.next() * 40) }, byte));
    // mutations of real messages: truncations, bit flips, a trailing byte
    const real = [
      encodeMsg(turnsMsg(812, [{ entries: CMDS.map((cmd, j) => ({ seat: 2, seq: j + 1, cmd })), ctrl: [{ k: 'seat', seat: 2, state: 'bot', bot: { difficulty: 0, personality: 'rusher' } }] }])),
      encodeMsg({ k: 'hello', proto: 1, build: 'x', mobile: false, name: 'n' }),
      encodeMsg({ k: 'ack', tick: 4, seq: 2, rtt: 40, buffer: 3, want: [5, 9] }),
    ];
    for (const b of real) {
      for (let n = 0; n < b.length; n++) samples.push(b.slice(0, n));
      for (let n = 0; n < 400; n++) {
        const c = b.slice();
        c[Math.floor(rng.next() * c.length)] ^= 1 << Math.floor(rng.next() * 8);
        samples.push(c);
      }
      samples.push(Uint8Array.from([...b, 0]));
    }
    let decoded = 0;
    for (const s of samples) {
      let m: Msg | null = null;
      expect(() => (m = decodeMsg(s))).not.toThrow();
      if (m) {
        decoded++;
        // anything that does decode is canonical: it re-encodes to the very same bytes
        expect(encodeMsg(m)).toEqual(s);
      }
    }
    expect(decoded).toBeGreaterThan(0); // some bit flips land on valid messages
    for (const b of real) expect(decodeMsg(b.slice(0, -1))).toBeNull();
  });
});
