import { describe, expect, it } from 'vitest';
import { broodCreature, broodTemper, TEMPER_WORDS } from '../src/campaign/character';
import { newRun, type RunState } from '../src/campaign/run';

const fresh = (): RunState => newRun('camp-characters', 2, 'wall', 0);

describe('brood characters', () => {
  it('are stable across calls and a save round-trip', () => {
    const run = fresh();
    const again = JSON.parse(JSON.stringify(run)) as RunState;
    for (const [i, b] of run.broods.entries()) {
      expect(JSON.stringify(broodCreature(run, b))).toBe(JSON.stringify(broodCreature(again, again.broods[i])));
      expect(broodTemper(run, b)).toEqual(broodTemper(again, again.broods[i]));
    }
  });

  it('match the word to the look', () => {
    const run = fresh();
    for (const b of run.broods) {
      const t = broodTemper(run, b);
      expect(TEMPER_WORDS[t.temper]).toContain(t.word);
      expect(broodCreature(run, b).traits.temper).toBe(t.temper);
    }
  });

  it('show the brood state: kind, veteran, wounds and strains', () => {
    const run = fresh();
    const b = run.broods[1];
    expect(broodCreature(run, b).body.shape).toBe('dome'); // Shields
    const base = broodCreature(run, b);
    b.wins = 4;
    const vet = broodCreature(run, b);
    expect(vet.tier).toBeGreaterThan(base.tier);
    expect(vet.traits.plating).toBeGreaterThan(0);
    expect(vet.parts.filter((p) => p.kind === 'plate').length).toBeGreaterThan(base.parts.filter((p) => p.kind === 'plate').length);
    b.wounded = 1;
    expect(broodCreature(run, b).parts.some((p) => p.kind === 'scar')).toBe(true);
    b.strains = ['sac'];
    expect(broodCreature(run, b).traits.marks).toEqual(['sac']);
    expect(broodCreature(run, b).parts.some((p) => p.kind === 'sac')).toBe(true);
  });

  it('differ between broods and runs', () => {
    const names = new Set<string>();
    for (let r = 0; r < 10; r++) {
      const run = newRun(`camp-${r}`, 0, 'swarm', 0);
      for (const b of run.broods) names.add(JSON.stringify(broodCreature(run, b).parts));
    }
    expect(names.size).toBeGreaterThan(15);
  });
});
