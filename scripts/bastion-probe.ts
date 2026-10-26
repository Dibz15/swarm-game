// Repro: a medium map where every neutral nest is a Bastion. Do bots expand?
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { NEST_RADIUS, NEUTRAL, NestType, TICK_HZ } from '../src/sim/constants';

for (let g = 0; g < 4; g++) {
  const w = createWorld({ terrain: TERRAIN, caves: CAVES, layout: LAYOUT, events: EVENTS, 
    seed: 2000 + g,
    size: 'medium',
    players: Array.from({ length: 4 }, (_, i) => ({
      faction: i, team: i, human: false,
      bot: { difficulty: 1, personality: PERSONALITIES[(i + g) % 4] },
    })),
  });
  for (const n of w.nests) {
    if (n.owner === NEUTRAL) {
      n.type = NestType.Bastion;
      n.r = NEST_RADIUS[NestType.Bastion];
    }
  }
  const line: string[] = [];
  while (!w.over && w.tick < 6 * 60 * TICK_HZ) {
    step(w, []);
    if (w.tick % (60 * TICK_HZ) === 0) {
      const owned = w.nests.filter((n) => n.owner >= 0 && n.owner < NEUTRAL).length;
      line.push(`${w.tick / TICK_HZ / 60}m: owned ${owned}/${w.nests.length} units ${[...w.unitCount].slice(0, 4).join(',')}`);
    }
  }
  console.log(`seed ${2000 + g} ->`, line.join(' | '), w.over ? `(over at ${(w.tick / TICK_HZ / 60).toFixed(1)}m)` : '');
}
