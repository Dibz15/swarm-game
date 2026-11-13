import { describe, expect, it } from 'vitest';
import { worldHash } from '../src/sim/hash';
import { play } from './rig';

/** Co-op Hold the line (#228) in a room: host and guests through the lobby into lockstep matches, to the end. */
describe('co-op Hold the line in a room (#228)', () => {
  const match = () => {
    const r = play({ guests: ['A', 'B'], bot: false, mode: 'hold', waves: 0 });
    const ws = () => [...r.matches.values()].map((m) => m.session.world);
    const w0 = ws()[0];
    expect(w0.siege!.defenders).toHaveLength(3);
    expect(new Set(w0.siege!.defenders.map((d) => w0.teamOf[d.f])).size).toBe(1);
    // play until the line holds or breaks, then let the last turns land everywhere
    for (let k = 0; k < 400 && !ws().every((w) => w.over); k++) r.run(1000);
    r.orders(false);
    r.run(2000);
    return ws();
  };

  it('three players hold the line together, every page agrees on how it ended, and it replays identically', () => {
    const a = match();
    for (const w of a) expect(w.over).toBe(true);
    expect(['held', 'fallen']).toContain(a[0].winReason);
    expect(new Set(a.map((w) => worldHash(w))).size).toBe(1);
    expect(new Set(a.map((w) => w.tick)).size).toBe(1);
    const b = match();
    expect(worldHash(b[0])).toBe(worldHash(a[0]));
  }, 600_000);
});
