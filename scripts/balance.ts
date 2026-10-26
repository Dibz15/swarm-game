// Headless balance probe: run bot FFAs and report match length, how they
// ended, and how often the lead changed hands.
// Usage: npx vite-node scripts/balance.ts [players] [size] [games] [difficulty]
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { TICK_HZ } from '../src/sim/constants';

const players = Number(process.argv[2] ?? 3);
const size = (process.argv[3] ?? 'small') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 12);
const difficulty = Number(process.argv[5] ?? 1);
let totalMin = 0, totalChanges = 0, comebacks = 0, firstOut = 0, straggle = 0;
for (let g = 0; g < games; g++) {
  const w = createWorld({ terrain: TERRAIN, caves: CAVES, layout: LAYOUT, events: EVENTS, 
    seed: 1000 + g,
    size,
    players: Array.from({ length: players }, (_, i) => ({
      faction: i, team: i, human: false,
      bot: { difficulty, personality: PERSONALITIES[(i + g) % 4] },
    })),
  });
  let leader = -1, changes = 0, earlyLeader = -1, out = 0;
  while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
    step(w, []);
    if (!out && w.factions.some((f) => f.eliminated)) out = w.tick;
    if (w.tick % TICK_HZ === 0) {
      // seconds spent as a straggler: alive, <=1 nest, under 20% of the leader's army
      const top = Math.max(...Array.from({ length: players }, (_, f) => w.unitCount[f]));
      for (let f = 0; f < players; f++) {
        if (w.factions[f].eliminated) continue;
        const nests = w.nests.filter((n) => n.owner === f).length;
        if (nests <= 1 && w.unitCount[f] < top * 0.2) straggle++;
      }
    }
    if (w.tick % (10 * TICK_HZ) === 0) {
      let l = 0;
      for (let f = 1; f < players; f++) if (w.unitCount[f] > w.unitCount[l]) l = f;
      if (l !== leader && w.tick > 30 * TICK_HZ) { if (leader >= 0) changes++; leader = l; }
      if (w.tick === 120 * TICK_HZ) earlyLeader = l;
    }
  }
  const min = w.tick / TICK_HZ / 60;
  const how = w.factions.filter((f) => f.active && f.id < 6 && !f.eliminated).length > 1 ? 'domination' : 'elimination';
  totalMin += min; totalChanges += changes; firstOut += out / TICK_HZ / 60;
  if (earlyLeader >= 0 && w.winnerTeam !== earlyLeader) comebacks++;
  console.log(`seed ${1000 + g}: ${min.toFixed(1)} min ${how}, first out ${(out / TICK_HZ / 60).toFixed(1)} min, lead changes ${changes}`);
}
console.log(`avg ${(totalMin / games).toFixed(1)} min, first knockout ${(firstOut / games).toFixed(1)} min, lead changes ${(totalChanges / games).toFixed(1)}, comebacks ${comebacks}/${games}, straggler time ${(straggle / games).toFixed(0)}s/game`);
