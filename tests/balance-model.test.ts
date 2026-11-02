import { describe, expect, it } from 'vitest';
import { mixedLogistic, sigmoid } from '../scripts/balance/fit';
import { KINDS, surrogateFight, winOdds, type Panel } from '../scripts/balance/surrogate';
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { Rng } from '../src/sim/rng';

describe('balance surrogate model (#68)', () => {
  it('recovers a slope and a group spread from synthetic battles', () => {
    const rng = new Rng(3);
    const normal = () => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
    const xs: number[][] = [], ys: number[] = [], gs: number[] = [];
    for (let g = 0; g < 400; g++) {
      const u = 1.5 * normal();
      for (const a of [-0.7, -0.2, 0.1]) {
        xs.push([1, a]);
        ys.push(+(rng.next() < sigmoid(0.5 + 2 * a + u)));
        gs.push(g);
      }
    }
    const fit = mixedLogistic(xs, ys, gs, 0.01);
    expect(fit.w[0]).toBeCloseTo(0.5, 0);
    expect(fit.w[1]).toBeGreaterThan(1.3);
    expect(fit.w[1]).toBeLessThan(2.7);
    expect(fit.sd).toBeGreaterThan(1);
    expect(fit.sd).toBeLessThan(2.1);
  });

  it('is plain ridge logistic regression without groups', () => {
    const xs = [[1], [1], [1], [1]], ys = [1, 1, 1, 0];
    const fit = mixedLogistic(xs, ys, [-1, -1, -1, -1], 1e-6);
    expect(sigmoid(fit.w[0])).toBeCloseTo(0.75, 3);
    expect(fit.sd).toBe(0);
  });
});

describe('balance surrogate fight (#68)', () => {
  const panel: Panel = {
    fp: 'test',
    typical: [20, 30, 40, 40],
    battles: KINDS.flatMap((kind) => [0, 1, 2, 3].map((band) => ({ kind, band }) as Panel['battles'][number])),
    weights: Object.fromEntries(KINDS.map((k) => [k, [1, 0.5, 0, -0.5, 0, 0, 0, 0, 0, 1, -1]])),
    hardness: Object.fromEntries(KINDS.map((k) => [k, 1])),
    outcomes: Object.fromEntries(KINDS.map((k) => [k, [0, 1, 2, 3].map(() => [{ n: 1, survive: 5, nests: 6, seconds: 200, capped: 0 }, { n: 1, survive: 0, nests: 0, seconds: 300, capped: 0.5 }])])),
  };

  it('is seeded by the run and turn, and harder nodes are less likely won', async () => {
    const run = newRun('surrogate-test', 0, 'swarm', 0);
    const id = run.nodes[run.start].links[0];
    const fielded = run.broods.map((b) => b.id);
    const job = { setup: nodeSetup(run, id, fielded), human: run.color, proxy: { skill: 1 }, cap: 1 };
    const at = { run, id, fielded, army: 24 };
    const fight = surrogateFight(panel);
    expect(await fight(job, at)).toEqual(await fight(job, at));
    const where = { band: 1, difficulty: 1, rivals: 2, pressure: 0, strength: 0, shift: 0, ratio: 1, skill: 1 };
    expect(winOdds(panel, 'conquest', where, 1)).toBeLessThan(winOdds(panel, 'conquest', where, 0));
    expect(winOdds(panel, 'conquest', { ...where, skill: 0.5 })).toBeLessThan(winOdds(panel, 'conquest', where));
  });
});
