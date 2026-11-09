import { MAX_SNAP_PARTS, SNAP_CHUNK, type Msg } from './protocol';

/**
 * World snapshots on the wire (#164): a rejoining client (and, later, a
 * desync report and a forked client) gets a whole world at a tick.
 *
 * A packed snapshot is `[flags u8][meta length u32][meta JSON][world bytes]`
 * (`serializeWorld`). Flag bit 0: everything after the flags is gzipped
 * (CompressionStream, in every browser and in Node): a world is a few
 * hundred KB raw and compresses well. It travels as `snap` messages of up to
 * SNAP_CHUNK bytes, which interleave with live turns on the one channel.
 *
 * Without gzip, packing and unpacking are synchronous: the headless rig steps
 * a virtual clock and can't wait on streams.
 */

/** What comes with a snapshot: the tick it's at, and what the world alone doesn't say. */
export interface SnapMeta {
  tick: number;
  /** who has the match paused (-1: nobody) */
  pausedBy: number;
  /** the receiver's seat's highest seq the sequencer has seen: number new orders above it */
  seqBase: number;
}

const GZIP = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const canGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  w.write(bytes).catch(() => undefined);
  w.close().catch(() => undefined);
  // read the chunks ourselves: Response(stream).arrayBuffer() in some runtimes takes each chunk's whole pooled buffer
  const r = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.byteLength;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function body(meta: SnapMeta, world: Uint8Array): Uint8Array {
  const m = enc.encode(JSON.stringify(meta));
  const b = new Uint8Array(4 + m.length + world.length);
  new DataView(b.buffer).setUint32(0, m.length);
  b.set(m, 4);
  b.set(world, 4 + m.length);
  return b;
}

/** A snapshot ready to chunk; a promise only when gzipping. */
export function packSnap(meta: SnapMeta, world: Uint8Array, gzip: boolean): Uint8Array | Promise<Uint8Array> {
  const b = body(meta, world);
  const wrap = (x: Uint8Array, flags: number) => {
    const out = new Uint8Array(1 + x.length);
    out[0] = flags;
    out.set(x, 1);
    return out;
  };
  if (!gzip || !canGzip) return wrap(b, 0);
  return through(b, new CompressionStream('gzip')).then((z) => wrap(z, GZIP));
}

function readBody(b: Uint8Array): { meta: SnapMeta; world: Uint8Array } {
  if (b.length < 4) throw new Error('snapwire: too short');
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (4 + n > b.length) throw new Error('snapwire: bad meta length');
  const meta = JSON.parse(dec.decode(b.subarray(4, 4 + n))) as SnapMeta;
  if (!Number.isInteger(meta?.tick) || meta.tick < 0 || !Number.isInteger(meta.pausedBy) || !Number.isInteger(meta.seqBase)) throw new Error('snapwire: bad meta');
  return { meta, world: b.subarray(4 + n) };
}

/** The meta and world bytes back; a promise only when the snapshot was gzipped. Throws on garbage. */
export function unpackSnap(packed: Uint8Array): { meta: SnapMeta; world: Uint8Array } | Promise<{ meta: SnapMeta; world: Uint8Array }> {
  if (packed.length < 1) throw new Error('snapwire: empty');
  const flags = packed[0];
  if (flags & ~GZIP) throw new Error('snapwire: unknown flags');
  const rest = packed.subarray(1);
  if (!(flags & GZIP)) return readBody(rest);
  if (!canGzip) throw new Error('snapwire: no gzip here');
  return through(rest, new DecompressionStream('gzip')).then(readBody);
}

/** Run `f` on a value that may or may not be a promise, synchronously when it isn't. */
export function settle<T>(v: T | Promise<T>, f: (x: T) => void, fail: (e: unknown) => void): void {
  if (v instanceof Promise) v.then(f, fail);
  else f(v);
}

/** The `snap` messages that carry a packed snapshot. */
export function chunkSnap(tick: number, packed: Uint8Array): Msg[] {
  const of = Math.max(1, Math.ceil(packed.length / SNAP_CHUNK));
  if (of > MAX_SNAP_PARTS) throw new Error('snapwire: snapshot too large');
  const out: Msg[] = [];
  for (let part = 0; part < of; part++) out.push({ k: 'snap', tick, part, of, bytes: packed.subarray(part * SNAP_CHUNK, (part + 1) * SNAP_CHUNK) });
  return out;
}

/**
 * Puts chunks back together, per sender and tick. Parts may come in any
 * order; a snapshot that doesn't finish within `timeoutMs` is dropped.
 */
export class SnapAssembler {
  private readonly open = new Map<string, { of: number; parts: (Uint8Array | undefined)[]; got: number; at: number }>();

  constructor(
    private readonly clock: () => number,
    private readonly timeoutMs = 10_000,
  ) {}

  /** The whole packed snapshot once its last part is in, else null. */
  add(from: string, m: { tick: number; part: number; of: number; bytes: Uint8Array }): Uint8Array | null {
    const now = this.clock();
    for (const [k, s] of this.open) if (now - s.at > this.timeoutMs) this.open.delete(k);
    const key = `${from}\u0000${m.tick}`;
    let s = this.open.get(key);
    if (s && s.of !== m.of) {
      this.open.delete(key); // a different snapshot under the same tick: start over
      s = undefined;
    }
    if (!s) this.open.set(key, (s = { of: m.of, parts: new Array(m.of), got: 0, at: now }));
    if (s.parts[m.part]) return null;
    s.parts[m.part] = m.bytes.slice();
    s.got++;
    if (s.got < s.of) return null;
    this.open.delete(key);
    const total = s.parts.reduce((n, p) => n + p!.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of s.parts) {
      out.set(p!, at);
      at += p!.length;
    }
    return out;
  }

  clear(): void {
    this.open.clear();
  }
}
