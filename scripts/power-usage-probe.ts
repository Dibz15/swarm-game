// How often do bots use each power, and what do armies end up made of?
// Usage: npx vite-node scripts/power-usage-probe.ts [games] [players] [size]
import { TERRAIN } from './env';
import { Bot, PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { TICK_HZ } from '../src/sim/constants';
import type { Command } from '../src/sim/commands';
import type { World } from '../src/sim/world';

const games = Number(process.argv[2] ?? 12);
const players = Number(process.argv[3] ?? 4);
const size = (process.argv[4] ?? 'medium') as 'small' | 'medium' | 'large';
const used: Record<string, number> = {};
const orig = (Bot.prototype as any).issue;
(Bot.prototype as any).issue = function (w: World, c: Command) {
  if (c.t !== 'move' && c.t !== 'rally' && c.t !== 'upgrade') {
    const before = w.factions[c.p].energy;
    orig.call(this, w, c);
    if (w.factions[c.p].energy < before) used[c.t] = (used[c.t] ?? 0) + 1; // count only successful casts
    return;
  }
  return orig.call(this, w, c);
};
const spawned = [0, 0, 0, 0];
let minutes = 0;
for (let g = 0; g < games; g++) {
  const w = createWorld({ terrain: TERRAIN, 
    seed: 9000 + g, size,
    players: Array.from({ length: players }, (_, i) => ({ faction: i, team: i, human: false, bot: { difficulty: 2, personality: PERSONALITIES[(i + g) % 4] } })),
  });
  const seen = new Set<number>();
  while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
    step(w, []);
    w.fx = []; w.deaths = [];
    if (w.tick % 15 === 0) for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] < players && !seen.has(w.uid[i])) { seen.add(w.uid[i]); spawned[w.kind[i]]++; }
  }
  minutes += w.tick / TICK_HZ / 60;
}
const per = (n: number) => (n / games).toFixed(1);
console.log(`${games} games, ${players}p ${size}, Hard bots, avg ${(minutes / games).toFixed(1)} min`);
console.log('casts per game:', Object.entries(used).map(([k, v]) => `${k} ${per(v)}`).join(', '));
const tot = spawned.reduce((a, b) => a + b, 0);
console.log('unit mix:', ['Dot', 'Tank', 'Lancer', 'Swift'].map((n, i) => `${n} ${Math.round((spawned[i] / tot) * 100)}%`).join(', '));
