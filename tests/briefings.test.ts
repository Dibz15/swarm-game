import { describe, expect, it } from 'vitest';
import { nodeSetup, warlordOf } from '../src/campaign/battle';
import { BATTLE_TYPES, battleType, briefingFor, briefsSeen, markBriefSeen, resetBriefs, type BattleType } from '../src/campaign/briefings';
import { PLAYTESTS } from '../src/campaign/playtest';
import { newRun, type RunState } from '../src/campaign/run';
import { MissionRun } from '../src/game/tutorial';
import type { TimedCommand } from '../src/game/session';
import { createWorld } from '../src/sim/setup';

/** A battle of each type: playtest scenes for the rare ones, plain run nodes for the rest. */
function battleOf(type: BattleType): { run: RunState; node: number } {
  const scene = (id: string) => {
    const s = PLAYTESTS.find((p) => p.id === id)!.make(0);
    if (s.kind !== 'battle') throw new Error(id);
    return { run: s.run, node: s.node };
  };
  if (type === 'hold') return scene('hold-early');
  if (type === 'stronghold') return scene('hold-ironhide');
  if (type === 'finale') return scene('finale-lords');
  for (let k = 0; k < 50; k++) {
    const run = newRun(`brief-${k}`, 0, 'swarm', 0);
    for (const n of run.nodes)
      if (n.kind === type && !warlordOf(run, n.id)?.citadel && battleType(createWorld(nodeSetup(run, n.id))) === type) return { run, node: n.id };
  }
  throw new Error(`no ${type} battle`);
}

describe('battle briefings (#218)', () => {
  for (const type of BATTLE_TYPES)
    it(`${type}: points at real nests and real places, and Next through it ends it`, () => {
      const { run, node } = battleOf(type);
      const w = createWorld(nodeSetup(run, node));
      expect(battleType(w)).toBe(type);
      const lord = warlordOf(run, node);
      const m = briefingFor(w, run.nodes[node].kind, lord ?? undefined)!;
      expect(m.guide).toBe(true);
      expect(m.steps.length).toBeGreaterThanOrEqual(2);
      expect(m.steps.length).toBeLessThanOrEqual(4);
      const human = 0;
      const mr = new MissionRun(m, 0);
      const ctx = { w, human, log: [] as TimedCommand[] };
      let rings = 0;
      for (let i = 0; i < m.steps.length; i++) {
        const s = mr.current!;
        expect(s.next).toBe(true);
        expect(s.text.desktop.length).toBeGreaterThan(10);
        expect(s.text.desktop).not.toMatch(/undefined|NaN/);
        for (const id of s.highlight?.(mr.ctx(ctx)) ?? []) {
          expect(w.nests[id]).toBeDefined();
          rings++;
        }
        const f = s.focus?.(mr.ctx(ctx));
        if (f) {
          expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
          expect(f.x).toBeGreaterThanOrEqual(0);
          expect(f.x).toBeLessThanOrEqual(w.width);
          expect(f.y).toBeGreaterThanOrEqual(0);
          expect(f.y).toBeLessThanOrEqual(w.height);
          if (f.zoom !== undefined) expect(f.zoom).toBeGreaterThan(0);
        }
        // Nothing moves on until Next.
        expect(mr.update(ctx)).toBe(false);
        mr.ack();
        expect(mr.update(ctx)).toBe(true);
      }
      expect(mr.complete).toBe(true);
      // Every briefing but Conquest's rings what it's about.
      if (type !== 'conquest') expect(rings).toBeGreaterThan(0);
    });

  it('names the stronghold warlord and its trait', () => {
    const { run, node } = battleOf('stronghold');
    const lord = warlordOf(run, node)!;
    const m = briefingFor(createWorld(nodeSetup(run, node)), run.nodes[node].kind, lord)!;
    const all = m.steps.map((s) => s.text.desktop).join(' ');
    expect(all).toContain(lord.name);
    expect(all).toContain(lord.trait);
  });

  it('remembers which briefings were seen, and forgets on reset', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      expect(briefsSeen()).toEqual([]);
      markBriefSeen('hold');
      markBriefSeen('hold');
      markBriefSeen('domination');
      expect(briefsSeen()).toEqual(['hold', 'domination']);
      store.set('swarm.battleBriefs', '{not json');
      expect(briefsSeen()).toEqual([]);
      markBriefSeen('finale');
      resetBriefs();
      expect(briefsSeen()).toEqual([]);
    } finally {
      g.localStorage = before;
    }
  });

  it('works without storage', () => {
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    delete g.localStorage;
    try {
      expect(briefsSeen()).toEqual([]);
      expect(() => markBriefSeen('hold')).not.toThrow();
      expect(() => resetBriefs()).not.toThrow();
    } finally {
      g.localStorage = before;
    }
  });
});
