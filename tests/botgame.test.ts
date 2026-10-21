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
