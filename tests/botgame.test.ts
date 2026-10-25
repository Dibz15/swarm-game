import { it, expect } from 'vitest';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { TICK_HZ } from '../src/sim/constants';
import { botMatch } from './helpers';

// Smoke test: a 4-bot FFA should make progress and stay fast.
it('bot FFA plays out', () => {
  const w = createWorld(botMatch(42));
  const t0 = performance.now();
  let maxTick = 0;
  const minutes = 8;
  for (let t = 0; t < minutes * 60 * TICK_HZ && !w.over; t++) {
    const s = performance.now();
    step(w, []);
    maxTick = Math.max(maxTick, performance.now() - s);
    if (t % (60 * TICK_HZ) === 0) {
      const owners = w.nests.map((n) => n.owner).join('');
      console.log(`min ${t / 1800}: units=${w.count} counts=${[...w.unitCount].join(',')} nests=${owners}`);
    }
  }
  const ms = performance.now() - t0;
  console.log(`ticks=${w.tick} over=${w.over} winner=${w.winnerTeam} avg=${(ms / w.tick).toFixed(3)}ms max=${maxTick.toFixed(2)}ms`);
  console.log(w.factions.slice(0, 4).map((f) => JSON.stringify(f.stats)).join('\n'));
  expect(w.factions.slice(0, 4).some((f) => f.stats.captured > 0)).toBe(true);
}, 60000);

// #28: Hard bots open like the recorded human, taking a 2nd nest within ~30 s
// on small 1v1 maps instead of splitting dots off to hold crystals.
it('Hard bots expand early in a 1v1', () => {
  const second: number[] = [];
  for (const seed of [11, 12, 13, 14]) {
    const w = createWorld({
      seed,
      size: 'small',
      terrain: 'standard',
      events: 'normal',
      players: [0, 1].map((f) => ({ faction: f, team: f, human: false, bot: { difficulty: 2, personality: 'turtler' as const } })),
    });
    const at = [-1, -1];
    while (w.tick < 60 * TICK_HZ && at.some((t) => t < 0)) {
      step(w, []);
      w.fx = [];
      w.deaths = [];
      for (const f of [0, 1]) if (at[f] < 0 && w.nests.filter((n) => n.owner === f).length >= 2) at[f] = w.tick / TICK_HZ;
    }
    second.push(...at);
  }
  console.log('2nd nest at', second.join(', '));
  expect(second.every((t) => t > 0)).toBe(true);
  expect(second.reduce((a, b) => a + b, 0) / second.length).toBeLessThan(32);
}, 60000);
