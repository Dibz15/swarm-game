import { describe, expect, it } from 'vitest';
import { loadProgress, MISSIONS, MissionRun, missionUnlocked, type Lock } from '../src/game/tutorial';
import type { TimedCommand } from '../src/game/session';
import { applyCommand, hasPower, type Command } from '../src/sim/commands';
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
  // The nest powers (#146): each on its own lesson, once held and with energy for it.
  const tgt = hl.length ? w.nests[hl[0]] : null;
  if (!locked.has('fortify') && hasPower(w, me, 'fortify') && energy >= POWER.fortifyCost && run.current?.pulse === '[data-a=fortify]') {
    out.push({ t: 'fortify', p: me, units: uids(army) });
  }
  if (!locked.has('blink') && hasPower(w, me, 'blink') && energy >= POWER.blinkCost && tgt && tgt.owner !== me && run.current?.pulse === '[data-a=blink]') {
    out.push({ t: 'blink', p: me, units: uids(army), x: tgt.x, y: tgt.y });
  }
  if (!locked.has('lockdown') && hasPower(w, me, 'lockdown') && energy >= POWER.lockdownCost && run.current?.pulse === '[data-a=lockdown]') {
    const foe = w.nests.find((n) => n.owner >= 0 && n.owner !== NEUTRAL && w.hostile(n.owner, me) && n.lockedUntil <= w.tick);
    if (foe) out.push({ t: 'lockdown', p: me, nest: foe.id });
  }
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
    // A real match (#147) is a Normal bot: not something a scripted autopilot is sure to beat.
    if (m.real) continue;
    {
      it(`mission ${i + 1} "${m.title}" can be finished by plain play`, () => {
        const w = createWorld(m.setup());
        const me = 0;
        const run = new MissionRun(m, i);
        const log: TimedCommand[] = [];
        const locked = new Set(m.locked);
        // A match that ends early (an early knockout) must fail the test, not spin forever.
        while (!run.complete && !w.over && w.tick < 6 * 60 * TICK_HZ && !w.factions[me].eliminated) {
          const cmds = [...run.take({ w, human: me, log }), ...(w.tick % 30 === 0 ? autopilot(w, me, run, locked) : [])];
          for (const c of cmds) log.push({ tick: w.tick + 1, cmd: c });
          step(w, cmds);
          w.fx = [];
          w.deaths = [];
          // A player reads each tour step and presses Next.
          if (run.current?.next) run.ack();
          run.update({ w, human: me, log });
          // Every step's demo must build from live state without throwing.
          if (w.tick % 90 === 0) {
            expect(Array.isArray(run.current?.demo?.({ w, human: me, log }) ?? [])).toBe(true);
            run.current?.status?.({ w, human: me, log });
          }
        }
        times.push(`${m.id} ${(w.tick / TICK_HZ).toFixed(0)}s`);
        expect(run.step, `stuck on step ${run.step + 1} (over: ${w.over} ${w.winReason} team ${w.winnerTeam}, energy ${w.factions[me].energy.toFixed(0)}, enemy nests ${w.nests.filter((n) => n.owner === 1).length} dots ${w.unitCount[1]}): ${run.current?.text.desktop.slice(0, 30)}`).toBe(m.steps.length);
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
    run.step = m.steps.findIndex((s) => s.enter);
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

describe('tutorial hints (#115)', () => {
  const play = (id: string) => {
    const i = MISSIONS.findIndex((m) => m.id === id);
    const m = MISSIONS[i];
    const w = createWorld(m.setup());
    return { m, w, run: new MissionRun(m, i), log: [] as TimedCommand[] };
  };
  const army = (w: World) => {
    const out: number[] = [];
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 0) out.push(w.uid[i]);
    return out;
  };

  /** Send some of your dots at a spot, as the player would: through the sim, and logged. */
  const send = (w: World, log: TimedCommand[], x: number, y: number, nest = -1, units = army(w)) => {
    const cmd: Command = { t: 'move', p: 0, units, x, y, nest };
    applyCommand(w, cmd);
    log.push({ tick: w.tick, cmd });
  };
  const sendNest = (w: World, log: TimedCommand[], id: number, units?: number[]) => send(w, log, w.nests[id].x, w.nests[id].y, id, units);

  it('waits on the world once dots head for the goal, not before', () => {
    const { w, run, log } = play('move');
    const ctx = { w, human: 0, log };
    expect(run.waiting(ctx)).toBe(false);
    // An order somewhere else doesn't count.
    send(w, log, 20, 20);
    expect(run.waiting(ctx)).toBe(false);
    sendNest(w, log, 1);
    expect(run.waiting(ctx)).toBe(true);
  });

  it('dots sent a step early count: the next step waits at once', () => {
    const { w, run, log } = play('move');
    const all = army(w);
    sendNest(w, log, 1, all.slice(0, Math.ceil(all.length / 2)));
    sendNest(w, log, 2, all.slice(Math.ceil(all.length / 2)));
    w.nests[1].owner = 0;
    run.update({ w, human: 0, log });
    expect(run.step).toBe(1);
    expect(run.waiting({ w, human: 0, log })).toBe(true);
  });

  it('the next step starts afresh when no dots are headed for its goal', () => {
    const { w, run, log } = play('move');
    sendNest(w, log, 1);
    w.nests[1].owner = 0;
    run.update({ w, human: 0, log });
    expect(run.step).toBe(1);
    expect(run.waiting({ w, human: 0, log })).toBe(false);
  });

  it('two nests to take: waiting starts with the first send, and names what is left', () => {
    const { w, run, log } = play('fight');
    const ctx = { w, human: 0, log };
    expect(run.waitText(ctx)).toBeNull();
    const all = army(w);
    sendNest(w, log, 2, all.slice(0, 5));
    expect(run.waitText(ctx)?.desktop).toContain('other glowing nest');
    sendNest(w, log, 3, all.slice(5));
    expect(run.waitText(ctx)?.desktop).toContain('hold both nests');
  });

  it('every step that waits on the world in missions 3 to 5 has a waiting line', () => {
    // Steps done by the order itself need none: tour steps, and the casts listed here by index.
    const casts: Record<string, Record<number, string>> = { fight: { 4: 'surge' }, nestpowers: { 1: 'fortify', 5: 'blink', 7: 'lockdown' }, powers: { 1: 'nova' }, domination: {} };
    for (const [id, cast] of Object.entries(casts)) {
      const m = MISSIONS.find((x) => x.id === id)!;
      m.steps.forEach((s, k) => {
        if (s.next) return;
        if (cast[k]) {
          // Still the cast this list says it is.
          expect(s.text.desktop.toLowerCase(), `${id} step ${k}`).toContain(cast[k]);
          return;
        }
        expect(s.wait, `${id}: ${s.text.desktop.slice(0, 40)}`).toBeDefined();
      });
    }
  });

  it('domination: sending dots at a glowing nest says so', () => {
    const { m, w, run, log } = play('domination');
    run.step = m.steps.length - 1;
    const ctx = { w, human: 0, log };
    expect(run.waiting(ctx)).toBe(false);
    sendNest(w, log, 2);
    expect(run.waitText(ctx)?.desktop).toContain('Keep taking');
    for (const k of w.nests) if (!k.capital) k.owner = 0;
    expect(run.waitText(ctx)?.desktop).toContain('30 seconds');
  });

  it('a power cast in an earlier step does not pass the lesson about it', () => {
    const { m, w, run, log } = play('nestpowers');
    // Barrage fired while the Spire is still being taken: the Barrage lesson still waits for one.
    run.step = 2;
    log.push({ tick: 1, cmd: { t: 'barrage', p: 0, x: 0, y: 0 } });
    w.nests[2].owner = 0;
    run.update({ w, human: 0, log });
    expect(m.steps[run.step].text.desktop).toContain('Barrage');
  });

  it('the mission 3 tour moves on only with Next', () => {
    const { m, w, run, log } = play('fight');
    w.nests[2].owner = w.nests[3].owner = 0;
    run.update({ w, human: 0, log });
    const tour = m.steps.filter((s) => s.next).length;
    expect(tour).toBe(3);
    for (let k = 0; k < tour; k++) {
      const at = run.step;
      expect(run.current?.next).toBe(true);
      run.update({ w, human: 0, log });
      expect(run.step).toBe(at);
      run.ack();
      run.update({ w, human: 0, log });
      expect(run.step).toBe(at + 1);
    }
    expect(run.current?.next).toBeUndefined();
  });

  it('Barrage waits for its shell to land before moving on', () => {
    const { m, w, run, log } = play('nestpowers');
    run.step = m.steps.findIndex((s) => s.text.desktop.includes('Barrage'));
    log.push({ tick: 1, cmd: { t: 'barrage', p: 0, x: 0, y: 0 } });
    w.barrages.push({ x: 1, y: 1, owner: 0, impact: 99, r: 40, x0: 0, y0: 0, t0: 0 });
    expect(run.waiting({ w, human: 0, log })).toBe(true);
    run.update({ w, human: 0, log });
    expect(m.steps[run.step].text.desktop).toContain('Barrage');
    w.barrages.length = 0;
    run.update({ w, human: 0, log });
    expect(m.steps[run.step].text.desktop).not.toContain('Barrage');
  });

  it('missions unlock one after another', () => {
    const p = { done: ['move'], graduated: false, offered: true };
    expect([0, 1, 2].map((i) => missionUnlocked(p, i))).toEqual([true, true, false]);
    // Older saves that skipped ahead, or graduated, keep everything open.
    expect(missionUnlocked({ done: ['domination'], graduated: false, offered: true }, 2)).toBe(true);
    expect(missionUnlocked({ done: [], graduated: true, offered: true }, 4)).toBe(true);
  });

  it('the nest powers mission (#146) slots in after mission 3, old saves included', () => {
    const at = (id: string) => MISSIONS.findIndex((m) => m.id === id);
    expect(at('nestpowers')).toBe(at('fight') + 1);
    expect(at('powers')).toBe(at('nestpowers') + 1);
    const fresh = { done: ['move', 'rally', 'fight'], graduated: false, offered: true };
    expect(missionUnlocked(fresh, at('nestpowers'))).toBe(true);
    expect(missionUnlocked(fresh, at('powers'))).toBe(false);
    // A save from before it existed, already past "Grow stronger".
    const old = { done: ['move', 'rally', 'fight', 'powers'], graduated: false, offered: true };
    expect(missionUnlocked(old, at('nestpowers'))).toBe(true);
    expect(missionUnlocked(old, at('domination'))).toBe(true);
  });
});

describe('the graduation match (#147)', () => {
  const i = MISSIONS.length - 1;
  const m = MISSIONS[i];

  it('is the last mission: a real 1v1 against a Normal bot, nothing locked', () => {
    expect(m.id).toBe('final');
    expect(m.real).toBe(true);
    expect(m.locked).toEqual([]);
    const bots = m.setup().players.filter((p) => p.bot);
    expect(bots.length).toBe(1);
    expect(bots[0].bot!.difficulty).toBe(1);
  });

  it('is done when you win, and opens once Domination is done', () => {
    const w = createWorld(m.setup());
    const run = new MissionRun(m, i);
    const log: TimedCommand[] = [];
    w.nests.filter((n) => n.owner === NEUTRAL).slice(0, 2).forEach((n) => (n.owner = 0));
    run.update({ w, human: 0, log });
    expect(run.step).toBe(1);
    w.over = true;
    w.winnerTeam = w.teamOf[0];
    run.update({ w, human: 0, log });
    expect(run.complete).toBe(true);
    expect(missionUnlocked({ done: ['move', 'rally', 'fight', 'nestpowers', 'powers'], graduated: false, offered: true }, i)).toBe(false);
    expect(missionUnlocked({ done: ['move', 'rally', 'fight', 'nestpowers', 'powers', 'domination'], graduated: false, offered: true }, i)).toBe(true);
  });

  it('old saves that already won the 1v1 load with it done', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      store.set('swarm.tutorial', JSON.stringify({ done: ['domination'], graduated: true, offered: true, next: 'ffa' }));
      expect(loadProgress().done).toContain('final');
      // Graduated but lost (or never played) the old 1v1: still to do.
      store.set('swarm.tutorial', JSON.stringify({ done: ['domination'], graduated: true, offered: true, next: 'graduate' }));
      expect(loadProgress().done).not.toContain('final');
    } finally {
      g.localStorage = before;
    }
  });
});
