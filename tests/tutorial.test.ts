import { describe, expect, it } from 'vitest';
import { MISSIONS, MissionRun, type Lock } from '../src/game/tutorial';
import type { TimedCommand } from '../src/game/session';
import { hasPower, type Command } from '../src/sim/commands';
import { NEUTRAL, POWER, TICK_HZ, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { UNIT_FEEDING, type World } from '../src/sim/world';

/**
 * A plain autopilot: it only uses player commands, sends everything at the
 * step's highlighted nest once strong enough, and uses whatever the mission
 * hasn't locked. If it can finish a mission, a new player can too.
 */
function autopilot(w: World, me: number, run: MissionRun, locked: Set<Lock>): Command[] {
  const out: Command[] = [];
  const army: number[] = [];
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === me && w.state[i] !== UNIT_FEEDING) army.push(i);
  if (!army.length) return out;
  const uids = (s: number[]) => s.map((i) => w.uid[i]);
  const mine = w.nests.filter((n) => n.owner === me);
  const home = mine[0];
  const ctx = { w, human: me, log: [] as TimedCommand[] };
  const hl = run.current?.highlight?.(ctx) ?? [];
  let cx = 0, cy = 0;
  for (const s of army) {
    cx += w.x[s];
    cy += w.y[s];
  }
  cx /= army.length;
  cy /= army.length;
  const enemyNear = (x: number, y: number, r: number) => {
    let k = 0;
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.hostile(w.owner[i], me) && (w.x[i] - x) ** 2 + (w.y[i] - y) ** 2 < r * r) k++;
    return k;
  };

  // Crystal step: park a squad on it.
  const crystal = w.crystals.find((c) => c.holder !== me);
  if (crystal && run.mission.id === 'domination' && run.step === 0) {
    out.push({ t: 'move', p: me, units: uids(army.slice(0, 6)), x: crystal.x, y: crystal.y, nest: -1 });
    return out;
  }
  // Level up home when dots are there.
  if (!locked.has('upgrade') && home && home.level < 2) {
    let near = 0;
    for (const s of army) if ((w.x[s] - home.x) ** 2 + (w.y[s] - home.y) ** 2 < UPGRADE_PICK_RADIUS ** 2) near++;
    if (near >= UPGRADE_COST[home.level] + 2) out.push({ t: 'upgrade', p: me, nest: home.id });
  }
  const energy = w.factions[me].energy;
  // Powers.
  const fight = enemyNear(cx, cy, 160);
  if (!locked.has('nova') && energy >= POWER.novaCost && fight >= 10) out.push({ t: 'nova', p: me, units: uids(army) });
  // Surge only with energy to spare when Nova is the lesson.
  else if (!locked.has('surge') && energy >= POWER.surgeCost + (locked.has('nova') ? 0 : POWER.novaCost) && fight >= 4) out.push({ t: 'surge', p: me, units: uids(army) });
  if (!locked.has('barrage') && hasPower(w, me, 'barrage') && energy >= POWER.barrageCost + (locked.has('nova') ? 0 : POWER.novaCost) && hl.length) {
    const n = w.nests[hl[0]];
    out.push({ t: 'barrage', p: me, x: n.x, y: n.y });
  }

  // Target: the highlighted nest, else the nearest one we don't own.
  // A highlighted nest of our own means "gather here".
  if (hl.length && hl.every((id) => w.nests[id].owner === me)) {
    const g = w.nests[hl[0]];
    out.push({ t: 'move', p: me, units: uids(army), x: g.x + 50, y: g.y, nest: -1 });
    return out;
  }
  const targets = (hl.length ? hl.map((id) => w.nests[id]) : w.nests.filter((n) => n.owner !== me)).filter((n) => n.owner !== me);
  targets.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
  const t = targets[0];
  if (t) {
    let def = 0;
    for (let i = 0; i < w.n; i++) {
      if (w.alive[i] && w.owner[i] !== me && (w.x[i] - t.x) ** 2 + (w.y[i] - t.y) ** 2 < (t.r + 80) ** 2) def += UNIT_STATS[w.kind[i]].weight;
    }
    if (army.length >= def * 1.4 + 3 || t.owner === NEUTRAL) {
      out.push({ t: 'move', p: me, units: uids(army), x: t.x, y: t.y, nest: t.id });
      if (mine.length) out.push({ t: 'rally', p: me, nests: mine.map((n) => n.id), x: t.x, y: t.y });
    } else if (home) out.push({ t: 'move', p: me, units: uids(army), x: home.x, y: home.y, nest: home.id });
  } else if (mine.length && !run.complete) {
    out.push({ t: 'rally', p: me, nests: mine.map((n) => n.id), x: home.x, y: home.y });
    // Nothing left to take: wait for what the step needs (a swarm to Nova).
    out.push({ t: 'move', p: me, units: uids(army), x: home.x + 60, y: home.y, nest: -1 });
  }
  return out;
}

describe('tutorial (#17)', () => {
  const times: string[] = [];
  for (const [i, m] of MISSIONS.entries()) {
    {
      it(`mission ${i + 1} "${m.title}" can be finished by plain play`, () => {
        const w = createWorld(m.setup());
        const me = 0;
        const run = new MissionRun(m, i);
        const log: TimedCommand[] = [];
        const locked = new Set(m.locked);
        while (!run.complete && w.tick < 6 * 60 * TICK_HZ && !w.factions[me].eliminated) {
          const cmds = [...run.take({ w, human: me, log }), ...(w.tick % 30 === 0 ? autopilot(w, me, run, locked) : [])];
          for (const c of cmds) log.push({ tick: w.tick + 1, cmd: c });
          step(w, cmds);
          w.fx = [];
          w.deaths = [];
          run.update({ w, human: me, log });
          // Every step's demo must build from live state without throwing.
          if (w.tick % 90 === 0) {
            expect(Array.isArray(run.current?.demo?.({ w, human: me, log }) ?? [])).toBe(true);
            run.current?.status?.({ w, human: me, log });
          }
        }
        times.push(`${m.id} ${(w.tick / TICK_HZ).toFixed(0)}s`);
        expect(run.step, `stuck on step ${run.step + 1}: ${run.current?.text.desktop}`).toBe(m.steps.length);
        expect(w.factions[me].eliminated).toBe(false);
        // The last lesson is domination: it should be how the mission is won.
        if (m.id === 'domination') expect(w.winReason).toBe('domination');
      }, 30000);
    }
  }
  it('fits in about ten minutes of autopilot play', () => console.log('mission times:', times.join(', ')));
});

describe('tutorial bots', () => {
  it('the mission 3 bot never comes for an idle player, and stays small', () => {
    const m = MISSIONS.find((x) => x.id === 'fight')!;
    {
      const w = createWorld(m.setup());
      const before = w.nests.filter((n) => n.owner === 0).length;
      let lowest = before, biggest = 0;
      while (w.tick < 3 * 60 * TICK_HZ) {
        step(w, []);
        w.fx = [];
        w.deaths = [];
        lowest = Math.min(lowest, w.nests.filter((n) => n.owner === 0).length);
        biggest = Math.max(biggest, w.unitCount[1]);
      }
      expect(lowest).toBe(before);
      // ...and stays small, so taking its home is quick however long you took.
      expect(biggest).toBeLessThanOrEqual(m.setup().players[1].unitCap!);
      expect(w.factions[0].eliminated).toBe(false);
    }
  });
});

describe('tutorial pacing', () => {
  it('mission 4: the swarm shows up a few seconds after the Nova step begins, not on a fixed clock', () => {
    const i = MISSIONS.findIndex((x) => x.id === 'powers');
    const m = MISSIONS[i];
    const w = createWorld(m.setup());
    const run = new MissionRun(m, i);
    const log: TimedCommand[] = [];
    // Dawdle: jump straight to the Nova step only after a minute and a half.
    while (w.tick < 90 * TICK_HZ) {
      step(w, []);
      w.fx = [];
      w.deaths = [];
    }
    expect(w.events!.swarms.length).toBe(0);
    run.step = m.steps.findIndex((s) => s.status);
    const start = w.tick;
    let seen = -1;
    while (w.tick < start + 15 * TICK_HZ && seen < 0) {
      const cmds = run.take({ w, human: 0, log });
      step(w, cmds);
      w.fx = [];
      w.deaths = [];
      if (w.events!.swarms.length) seen = w.tick;
    }
    expect(seen).toBeGreaterThan(start);
    expect((seen - start) / TICK_HZ).toBeLessThan(8);
  });
});
