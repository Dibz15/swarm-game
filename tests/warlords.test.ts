import { describe, expect, it } from 'vitest';
import { STRONGHOLD_PROD, nodeSetup, rivals, warlordOf } from '../src/campaign/battle';
import { biomassFor, type BattleReport } from '../src/campaign/broods';
import { modsFor } from '../src/campaign/rewards';
import { finaleWarlords, newRun, resolveTurn, warlordAt, type RunState } from '../src/campaign/run';
import { DOMAIN_WEIGHT, EROSION, STRONGHOLD_WEIGHT, TRAITS, TROPHY } from '../src/campaign/warlords';
import { DIFFICULTY } from '../src/sim/ai/bot';
import { Kind } from '../src/sim/constants';

const WIN: BattleReport = { won: true, survivors: [10, 0, 0, 0], nests: 3, seconds: 200 };
const runs = Array.from({ length: 30 }, (_, k) => newRun(`lords-${k}`, k % 6, 'swarm', 0));

/** A run with a warlord of the given trait, and that warlord. */
function withTrait(trait: string): [RunState, NonNullable<RunState['warlords']>[number]] {
  for (let k = 0; k < 200; k++) {
    const run = newRun(`trait-${k}`, 0, 'swarm', 0);
    const w = run.warlords!.find((o) => o.trait === trait);
    if (w) return [run, w];
  }
  throw new Error(`no run with ${trait}`);
}

describe('warlord placement', () => {
  it('places 2-4 warlords with disjoint domains around their strongholds', () => {
    let two = 0;
    for (const run of runs) {
      const lords = run.warlords!;
      expect(lords.length).toBeGreaterThanOrEqual(1);
      expect(lords.length).toBeLessThanOrEqual(4);
      if (lords.length >= 2) two++;
      const seen = new Set<number>();
      for (const w of lords) {
        expect(w.nodes[0]).toBe(w.stronghold);
        expect(w.nodes.length).toBeLessThanOrEqual(4);
        expect(w.faction).not.toBe(run.color);
        for (const id of w.nodes) {
          const n = run.nodes[id];
          expect(seen.has(id)).toBe(false);
          seen.add(id);
          expect(n.domain).toBe(w.id);
          expect(['conquest', 'domination']).toContain(n.kind);
          expect(n.checkpoint).toBeFalsy();
          if (id !== w.stronghold) expect(n.links).toContain(w.stronghold);
        }
      }
      expect(new Set(lords.map((w) => w.faction)).size).toBe(lords.length);
      expect(new Set(lords.map((w) => w.trait)).size).toBe(lords.length);
    }
    expect(two).toBeGreaterThan(runs.length * 0.8);
  });

  it('is seeded: the same seed gives the same warlords', () => {
    expect(newRun('lords-3', 3, 'swarm', 0).warlords).toEqual(runs[3].warlords);
  });

  it('keeps strongholds to two rivals and makes domains richer', () => {
    for (const run of runs)
      for (const w of run.warlords!) {
        const s = run.nodes[w.stronghold];
        // The fortress is the harder part (#100): at most the warlord and one rival.
        expect(s.rivals).toBeLessThanOrEqual(2);
        expect(s.reward).toBeGreaterThanOrEqual(40);
      }
  });
});

describe('domain battles', () => {
  it('field the warlord first, with its trait and personality', () => {
    const [run, w] = withTrait('ironhide');
    const setup = nodeSetup(run, w.stronghold, false);
    const lord = setup.players[1];
    expect(lord.faction).toBe(w.faction);
    // In its own stronghold it turtles (#100); elsewhere it keeps its temper.
    expect(lord.bot!.personality).toBe('turtler');
    const other = w.nodes.find((id) => id !== w.stronghold);
    if (other !== undefined) expect(nodeSetup(run, other, false).players[1].bot!.personality).toBe(w.personality);
    expect(lord.mods!.kind[Kind.Tank].hp).toBeCloseTo(1.5);
    expect(setup.players.filter((p) => p.faction === w.faction)).toHaveLength(1);
    expect(warlordOf(run, w.stronghold)!.name).toBe(w.name);
    expect(rivals(run, w.stronghold)[0].warlord).toBe(w);
  });

  it('a Swarmlord spawns faster and casts no powers', () => {
    const [run, w] = withTrait('swarmlord');
    const lord = nodeSetup(run, w.stronghold, false).players[1];
    expect(lord.bot!.powers).toBe(false);
    expect(lord.prod).toBeCloseTo((DIFFICULTY[lord.bot!.difficulty].prod ?? 1) * 1.25 * STRONGHOLD_PROD);
  });

  it('the Bloom eating its domain weakens it; eating the stronghold ends it', () => {
    const [run, w] = withTrait('ironhide');
    const base = nodeSetup(run, w.stronghold, false).players[1].prod!;
    const other = w.nodes.find((id) => id !== w.stronghold);
    if (other !== undefined) {
      run.swallowed.push(other);
      expect(nodeSetup(run, w.stronghold, false).players[1].prod!).toBeCloseTo(base * (1 - EROSION));
      expect(warlordOf(run, w.stronghold)!.weakened).toBe(1);
    }
    run.swallowed.push(w.stronghold);
    expect(warlordAt(run, w.stronghold)).toBeUndefined();
    for (const id of w.nodes) if (id !== w.stronghold) expect(nodeSetup(run, id, false).players.some((p) => p.mods && !p.human)).toBe(false);
  });

  it('warlords bordering the heart join the finale', () => {
    const run = newRun('lords-finale', 0, 'swarm', 0);
    const w = run.warlords![0];
    w.nodes.push(run.nodes[run.heart].links[0]);
    expect(finaleWarlords(run)).toContain(w);
    const setup = nodeSetup(run, run.heart, false);
    expect(setup.players.find((p) => p.faction === w.faction)?.mods).toBeDefined();
  });

  it('old saves without warlords still play', () => {
    const run = newRun('lords-old', 0, 'swarm', 0);
    delete run.warlords;
    for (const n of run.nodes) delete n.domain;
    const id = run.nodes[run.start].links[0];
    expect(nodeSetup(run, id, false).players.some((p) => p.mods && !p.human)).toBe(false);
    resolveTurn(run, id, WIN, run.fielded, 0);
    expect(run.at).toBe(id);
  });
});

describe('breaking a stronghold', () => {
  it('breaks the domain, pays big, offers rares and hands over the trophy', () => {
    const [run, w] = withTrait('longspine');
    run.at = run.nodes[w.stronghold].links[0];
    const reward = run.nodes[w.stronghold].reward;
    const res = resolveTurn(run, w.stronghold, WIN, run.fielded, 0);
    expect(w.broken).toBe(true);
    expect(res.warlords).toEqual([{ id: w.id, what: 'broken' }]);
    expect(res.biomass).toBe(biomassFor(reward, WIN));
    expect(run.perks).toContain(TROPHY + 'longspine');
    expect(modsFor(run.perks, []).kind[Kind.Lancer].range).toBeCloseTo(1.1);
    expect(run.offer?.weight).toEqual(STRONGHOLD_WEIGHT);
    // The rest of the domain is ordinary ground now.
    for (const id of w.nodes) if (id !== w.stronghold) expect(warlordAt(run, id)).toBeUndefined();
    expect(TRAITS[w.trait].trophy.name).toBeTruthy();
  });

  it('a win elsewhere in a domain tilts the offer, but leaves the warlord standing', () => {
    for (let k = 0; k < 50; k++) {
      const run = newRun(`domain-${k}`, 0, 'swarm', 0);
      const w = run.warlords!.find((o) => o.nodes.length > 1);
      if (!w) continue;
      const id = w.nodes[1];
      run.at = run.nodes[id].links[0];
      resolveTurn(run, id, WIN, run.fielded, 0);
      expect(w.broken).toBe(false);
      expect(run.offer?.weight).toEqual(DOMAIN_WEIGHT);
      return;
    }
    throw new Error('no domain with more than its stronghold');
  });
});
