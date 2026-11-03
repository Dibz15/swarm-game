import { describe, expect, it } from 'vitest';
import { linesOf, verdicts, type Impact, type ImpactTable } from '../scripts/balance/impact';

const item = (id: string, delta: number, unused = false): Impact => ({ id, n: 64, delta, half: 0.02, secs: 0, logit: delta * 4, unused });

describe('balance reward impact (#68)', () => {
  it('tiers by thirds, flags must-picks, dead rewards, the unmeasured and Blood price', () => {
    const items = [item('lean', -0.05), item('fleet', 0), item('plated', 0.02), item('spikes', 0.03), item('frenzy', 0.06), item('quickdraw', 0.2), item('echo', 0, true), item('glass', 0.3), item('blood-price', -0.4)];
    const lines = linesOf(items.filter((i) => !i.unused));
    // Pacts (glass, blood-price) don't set the thirds.
    expect(lines).toEqual({ lower: 0, upper: 0.03, mustPick: 0.15 });
    const v = verdicts({ base: { rate: 0.6, n: 64, secs: 100 }, items, lines, opts: { seeds: 0, size: 10, diff: 3, ids: [] } } as ImpactTable);
    expect(v.lean).toEqual({ tier: 'common', flag: 'no impact' });
    expect(v.spikes).toEqual({ tier: 'uncommon', flag: '' });
    expect(v.frenzy).toEqual({ tier: 'rare', flag: '' });
    expect(v.quickdraw).toEqual({ tier: 'rare', flag: 'must-pick' });
    expect(v.echo).toEqual({ tier: 'rare', flag: 'unmeasured' });
    expect(v.glass).toEqual({ tier: 'rare', flag: 'must-pick' });
    expect(v['blood-price'].flag).toBe('playtest');
  });
});
