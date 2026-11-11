import { describe, expect, it } from 'vitest';
import type { BattleReport } from '../src/campaign/broods';
import { DIFFICULTIES, MAP_H, MAP_W, moves, newRun, resolveTurn, type RunState } from '../src/campaign/run';
import { GLOSSARY, TOUR, loadGuide, saveGuide, tourFor, tourWarlord, wantsTour } from '../src/campaign/tour';

const WIN: BattleReport = { won: true, survivors: [30, 12, 12, 12], nests: 6, seconds: 200 };

const finite = (...v: number[]) => v.every(Number.isFinite);

describe('map tour (#217)', () => {
  const runs: RunState[] = [];
  for (const d of DIFFICULTIES) for (const seed of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) runs.push(newRun(`${seed}-${d}`, 0, 'swarm', 0, d));

  it('every step looks somewhere on the map and rings real places', () => {
    for (const run of runs) {
      const steps = tourFor(run);
      expect(steps.length).toBeGreaterThanOrEqual(7);
      for (const s of steps) {
        const f = s.focus(run);
        expect(finite(f.x, f.y), `${run.seedText} ${s.id}`).toBe(true);
        expect(f.x).toBeGreaterThanOrEqual(0);
        expect(f.x).toBeLessThanOrEqual(MAP_W);
        expect(f.y).toBeGreaterThanOrEqual(0);
        expect(f.y).toBeLessThanOrEqual(MAP_H);
        if (f.span !== null) expect(f.span).toBeGreaterThan(0);
        for (const m of s.marks?.(run) ?? []) expect(finite(m.x, m.y, m.r) && m.r > 0, `${run.seedText} ${s.id}`).toBe(true);
        const sel = s.select?.(run);
        if (sel !== undefined && sel !== null) expect(run.nodes[sel]).toBeDefined();
        for (const id of s.peek?.(run) ?? []) expect(run.nodes[id]).toBeDefined();
        expect(s.text.length).toBeGreaterThan(20);
      }
    }
  });

  it('the moving step opens a node you can move to', () => {
    for (const run of runs) {
      const s = TOUR.find((t) => t.id === 'moves')!;
      expect(moves(run)).toContain(s.select!(run));
    }
  });

  it('skips the warlord steps on a run without warlords (older saves)', () => {
    const run = newRun('nolords', 0, 'swarm', 0);
    run.warlords = undefined;
    expect(tourWarlord(run)).toBeNull();
    const ids = tourFor(run).map((s) => s.id);
    expect(ids).not.toContain('warlord');
    expect(ids).not.toContain('stronghold');
    for (const s of tourFor(run)) expect(finite(s.focus(run).x, s.focus(run).y)).toBe(true);
  });

  it('a broken warlord is not toured', () => {
    const run = newRun('broken', 0, 'swarm', 0);
    for (const w of run.warlords ?? []) w.broken = true;
    expect(tourWarlord(run)).toBeNull();
  });

  it('the glossary covers the campaign terms', () => {
    const terms = GLOSSARY.map((g) => g.term.toLowerCase()).join(' ');
    for (const t of ['bloom', 'warlord', 'stronghold', 'brood', 'strain', 'camp', 'reward']) expect(terms).toContain(t);
  });
});

describe('tour seen (#217)', () => {
  it('opens on a first run until seen, never later in a run', () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    try {
      const run = newRun('seen', 0, 'swarm', 0);
      expect(loadGuide().toured).toBe(false);
      expect(wantsTour(run)).toBe(true);
      saveGuide({ toured: true });
      expect(loadGuide().toured).toBe(true);
      expect(wantsTour(run)).toBe(false);
      saveGuide({ toured: false });
      resolveTurn(run, moves(run)[0], WIN, run.fielded, 0);
      expect(wantsTour(run)).toBe(false);
      mem.set('swarm.runGuide', '{not json');
      expect(loadGuide().toured).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
