// Army size of an idle (never-acting) player vs the bots over time.
import { CAVES, EVENTS, TERRAIN } from './env';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { SUPPLY, TICK_HZ } from '../src/sim/constants';

const games = Number(process.argv[2] ?? 20);
const base = { ...SUPPLY };
const variants: [string, () => void][] = [
  ['current supply', () => {}],
  ['no supply cap', () => (SUPPLY.base = 1e9)],
  ['tight 15+14/n', () => Object.assign(SUPPLY, { base: 15, perNest: 14 })],
  ['loose 30+20/n', () => Object.assign(SUPPLY, { base: 30, perNest: 20 })],
];
for (const [name, apply] of variants) {
  Object.assign(SUPPLY, base);
  apply();
  const at = [2, 3, 4].map(() => ({ idle: 0, top: 0, mean: 0, n: 0 }));
  for (let g = 0; g < games; g++) {
    const w = createWorld({ terrain: TERRAIN, caves: CAVES, events: EVENTS, 
      seed: 7000 + g, size: 'medium',
      players: [{ faction: 0, team: 0, human: true }, ...[1, 2, 3].map((f, i) => ({ faction: f, team: f, human: false, bot: { difficulty: 1, personality: PERSONALITIES[(i + g) % 4] } }))],
    });
    while (!w.over && w.tick < 4 * 60 * TICK_HZ) {
      step(w, []); w.fx = []; w.deaths = [];
      const k = [2, 3, 4].indexOf(w.tick / TICK_HZ / 60);
      if (k >= 0) {
        const botsU = [1, 2, 3].map((f) => w.unitCount[f]);
        at[k].idle += w.unitCount[0]; at[k].top += Math.max(...botsU); at[k].mean += botsU.reduce((a, b) => a + b, 0) / 3; at[k].n++;
      }
    }
  }
  console.log(name.padEnd(28), at.map((a, i) => `${i + 2}m idle ${(a.idle / a.n).toFixed(0)} vs bot avg ${(a.mean / a.n).toFixed(0)} / top ${(a.top / a.n).toFixed(0)}`).join(' | '));
}
