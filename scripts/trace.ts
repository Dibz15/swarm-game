// Timeline of one bot match: units/nests per player every 30s.
// Usage: npx vite-node scripts/trace.ts [players] [size] [seed]
import { EVENTS, TERRAIN } from './env';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { TICK_HZ } from '../src/sim/constants';

const players = Number(process.argv[2] ?? 5);
const size = (process.argv[3] ?? 'large') as 'small' | 'medium' | 'large';
const seed = Number(process.argv[4] ?? 1000);
const pers = Array.from({ length: players }, (_, i) => PERSONALITIES[(i + seed - 1000 + 4000) % 4] /* same seating as balance.ts */);
const w = createWorld({ terrain: TERRAIN, events: EVENTS,  seed, size, players: pers.map((p, i) => ({ faction: i, team: i, human: false, bot: { difficulty: 1, personality: p } })) });
console.log(`${players}p ${size} seed ${seed}, ${w.nests.length} nests, domination needs ${Math.ceil(w.nests.length * w.domShare)}`);
console.log('time  ' + pers.map((p) => p.slice(0, 9).padEnd(10)).join('') + 'neutral');
while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
  step(w, []);
  w.fx = []; w.deaths = [];
  if (w.tick % (30 * TICK_HZ) === 0) {
    const cells = pers.map((_, f) => (w.factions[f].eliminated ? 'out' : `${w.unitCount[f]}/${w.nests.filter((n) => n.owner === f).length}`).padEnd(10));
    const neutral = w.nests.filter((n) => n.owner === 6 || n.owner < 0).length;
    console.log(`${(w.tick / TICK_HZ / 60).toFixed(1).padStart(4)}m ${cells.join('')}${neutral}`);
  }
}
console.log(w.over ? `over at ${(w.tick / TICK_HZ / 60).toFixed(1)}m, winner ${w.winnerTeam}` : 'hit 15 min cap');
