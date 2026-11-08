import { afterEach, describe, expect, it } from 'vitest';
import { broadcastTransport } from '../src/net/broadcast';
import type { Transport } from '../src/net/transport';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BroadcastChannel transport (#162)', () => {
  const open: Transport[] = [];
  const make = (room: string, self: string, o: { beatMs?: number; timeoutMs?: number } = {}) => {
    const t = broadcastTransport(room, { self, ...o });
    const log: string[] = [];
    t.onPeer = (p, up) => log.push(`${p}:${up ? 'up' : 'down'}`);
    const got: [string, number[]][] = [];
    t.onMessage = (p, b) => got.push([p, [...b]]);
    open.push(t);
    return { t, log, got };
  };
  afterEach(() => {
    for (const t of open.splice(0)) t.close();
  });

  it('tabs in one room find each other both ways, and messages reach only their target', async () => {
    const a = make('r1', 'a');
    await wait(20);
    const b = make('r1', 'b');
    const c = make('r1', 'c');
    const other = make('r2', 'x');
    await wait(50);
    expect(a.log.sort()).toEqual(['b:up', 'c:up']);
    expect(b.log.sort()).toEqual(['a:up', 'c:up']);
    expect(other.log).toEqual([]);
    for (let i = 0; i < 5; i++) a.t.send('b', Uint8Array.of(i, 9));
    await wait(30);
    expect(b.got).toEqual([0, 1, 2, 3, 4].map((i) => ['a', [i, 9]]));
    expect(c.got).toEqual([]);
  });

  it('a tab that closes says goodbye; one that goes silent times out', async () => {
    const a = make('r3', 'a', { beatMs: 20, timeoutMs: 80 });
    const b = make('r3', 'b', { beatMs: 20, timeoutMs: 80 });
    await wait(40);
    b.t.close();
    await wait(30);
    expect(a.log).toEqual(['b:up', 'b:down']);
    // a silent tab: announces itself once, then never beats (a huge beat interval)
    make('r3', 'z', { beatMs: 1e6 });
    await wait(40);
    expect(a.log).toContain('z:up');
    await wait(150);
    expect(a.log.at(-1)).toBe('z:down');
  });
});
