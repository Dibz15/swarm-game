import { describe, expect, it } from 'vitest';
import { MARKS, creature, drawCreature, extent, type Creature } from '../src/art/creature';
import { nodeSetup, rivals } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { Kind } from '../src/sim/constants';

const count = (c: Creature, kind: string) => c.parts.filter((p) => p.kind === kind).length;
const avg = (f: (seed: number) => number) => {
  let s = 0;
  for (let i = 0; i < 60; i++) s += f(i);
  return s / 60;
};

describe('creature generator', () => {
  it('is pure: the same inputs give the same creature', () => {
    for (const temper of PERSONALITIES) {
      const a = creature(42, 1, { temper, tier: 2 });
      const b = creature(42, 1, { temper, tier: 2 });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('varies with the seed', () => {
    const names = new Set<string>();
    const shapes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const c = creature(i, 0);
      names.add(c.name);
      shapes.add(c.body.shape);
    }
    expect(names.size).toBeGreaterThan(25);
    expect(shapes.size).toBe(4);
  });

  it('maps traits to the look', () => {
    expect(avg((s) => count(creature(s, 0, { temper: 'rusher' }), 'spike'))).toBeGreaterThan(avg((s) => count(creature(s, 0, { temper: 'turtler' }), 'spike')));
    expect(avg((s) => count(creature(s, 0, { temper: 'turtler' }), 'plate'))).toBeGreaterThan(avg((s) => count(creature(s, 0, { temper: 'rusher' }), 'plate')));
    const legs = (s: number, temper: 'expander' | 'turtler') => {
      const c = creature(s, 0, { temper });
      return count(c, 'limb') + count(c, 'tendril');
    };
    expect(avg((s) => legs(s, 'expander'))).toBeGreaterThan(avg((s) => legs(s, 'turtler')));
    expect(avg((s) => count(creature(s, 0, { temper: 'opportunist' }), 'eye'))).toBeGreaterThan(avg((s) => count(creature(s, 0, { temper: 'turtler' }), 'eye')));
    const menace = (tier: number) => avg((s) => count(creature(s, 0, { tier }), 'horn') + count(creature(s, 0, { tier }), 'crest'));
    expect(menace(3)).toBeGreaterThan(menace(1));
    expect(menace(1)).toBeGreaterThan(menace(0));
    expect(avg((s) => count(creature(s, 0, { plating: 1 }), 'plate'))).toBeGreaterThan(avg((s) => count(creature(s, 0), 'plate')) + 2);
  });

  it('keeps symmetric tempers mirrored', () => {
    const c = creature(7, 2, { temper: 'rusher' });
    for (const p of c.parts.filter((p) => p.side === 1)) {
      expect(c.parts.some((q) => q.side === -1 && q.kind === p.kind && Math.abs(q.x + p.x) < 1e-9 && q.y === p.y)).toBe(true);
    }
  });

  it('sets the silhouette from the unit focus', () => {
    expect(creature(1, 0, { focus: Kind.Dot }).body.shape).toBe('cluster');
    expect(creature(1, 0, { focus: Kind.Tank }).body.shape).toBe('dome');
    expect(creature(1, 0, { focus: Kind.Lancer }).body.shape).toBe('lance');
    expect(creature(1, 0, { focus: Kind.Swift }).body.shape).toBe('sleek');
  });

  it('applies marks and the wounded scar', () => {
    expect(MARKS.sac).toBeDefined();
    expect(count(creature(3, 0, { marks: ['sac'] }), 'sac')).toBe(1);
    expect(count(creature(3, 0, { marks: ['unknown'] }), 'sac')).toBe(0);
    expect(count(creature(3, 0, { wounded: true }), 'scar')).toBe(1);
  });

  it('fits inside the portrait', () => {
    for (let s = 0; s < 200; s++) {
      const c = creature(s, s % 6, { temper: PERSONALITIES[s % 4], tier: s % 4, plating: (s % 3) / 2, marks: ['sac'] });
      expect(extent(c) * c.fit).toBeLessThanOrEqual(0.92);
    }
  });

  it('draws inside its box against a stub canvas', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    const point = (x: number, y: number) => (xs.push(x), ys.push(y));
    const g = new Proxy(
      {
        moveTo: point,
        lineTo: point,
        quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => point(x, y),
        bezierCurveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => point(x, y),
        arc: (x: number, y: number, r: number) => (point(x - r, y - r), point(x + r, y + r)),
        ellipse: (x: number, y: number, rx: number, ry: number) => (point(x - rx, y - ry), point(x + rx, y + ry)),
      } as Record<string, unknown>,
      { get: (t, k: string) => (k in t ? t[k] : () => {}), set: () => true },
    ) as unknown as CanvasRenderingContext2D;
    for (let s = 0; s < 50; s++) drawCreature(g, creature(s, s % 6, { temper: PERSONALITIES[s % 4], tier: 3, wounded: s % 2 === 0 }), 50, 50, 100);
    expect(xs.length).toBeGreaterThan(100);
    // the drawn reach stays near the box (curve controls and claws aside)
    expect(Math.min(...xs, ...ys)).toBeGreaterThan(0);
    expect(Math.max(...xs, ...ys)).toBeLessThan(100);
  });
});

describe('rival portraits', () => {
  it('match the battle the node will field', () => {
    const run = newRun('creatures', 0, 'swarm', 0);
    for (const n of run.nodes.filter((n) => n.kind !== 'start')) {
      const rs = rivals(run, n.id);
      const bots = nodeSetup(run, n.id, false).players.filter((p) => p.bot);
      expect(rs.map((r) => r.faction)).toEqual(bots.map((p) => p.faction));
      expect(rs.map((r) => r.personality)).toEqual(bots.map((p) => p.bot!.personality));
      // A warlord keeps its own face (tier 3) all run.
      expect(rs.every((r) => r.creature.tier === (r.warlord ? 3 : n.difficulty))).toBe(true);
      expect(JSON.stringify(rivals(run, n.id))).toBe(JSON.stringify(rs));
    }
  });
});
