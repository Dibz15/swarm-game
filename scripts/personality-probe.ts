// Personality balance: win rate and average finishing place per personality.
// Every game seats all personalities, rotated across seats, so map position
// doesn't bias results. Finish order: winner 1st, then survivors by nests,
// then eliminated players by how long they lasted.
// Usage: npx vite-node scripts/personality-probe.ts [players] [size] [games] [difficulty]
import { CAVES, EVENTS, TERRAIN } from './env';
import { PERSONALITIES, type Personality } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { TICK_HZ } from '../src/sim/constants';

const players = Number(process.argv[2] ?? 4);
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 40);
const difficulty = Number(process.argv[5] ?? 1);

const stat = new Map<Personality, { games: number; wins: number; place: number; spawned: number; kills: number; captured: number }>();
for (const p of PERSONALITIES) stat.set(p, { games: 0, wins: 0, place: 0, spawned: 0, kills: 0, captured: 0 });

for (let g = 0; g < games; g++) {
  const pers = Array.from({ length: players }, (_, i) => PERSONALITIES[(i + g) % 4]);
  const w = createWorld({ terrain: TERRAIN, caves: CAVES, events: EVENTS, 
    seed: 5000 + g, size,
    players: pers.map((p, i) => ({ faction: i, team: i, human: false, bot: { difficulty, personality: p } })),
  });
  while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
    step(w, []);
    w.fx = []; w.deaths = [];
  }
  const nests = (f: number) => w.nests.filter((n) => n.owner === f).length;
  const order = pers.map((_, f) => f).sort((a, b) => {
    const fa = w.factions[a], fb = w.factions[b];
    const sa = fa.team === w.winnerTeam ? 1e9 : fa.eliminated ? fa.eliminatedTick : 1e8 + nests(a);
    const sb = fb.team === w.winnerTeam ? 1e9 : fb.eliminated ? fb.eliminatedTick : 1e8 + nests(b);
    return sb - sa;
  });
  order.forEach((f, place) => {
    const s = stat.get(pers[f])!;
    s.games++;
    s.place += place + 1;
    if (place === 0) s.wins++;
    s.spawned += w.factions[f].stats.spawned;
    s.kills += w.factions[f].stats.kills;
    s.captured += w.factions[f].stats.captured;
  });
}
console.log(`${players}p ${size}, ${games} games, difficulty ${difficulty} (fair win rate ${(100 / players).toFixed(0)}%)`);
for (const [p, s] of stat) {
  if (!s.games) continue;
  console.log(
    `${p.padEnd(12)} win ${((s.wins / s.games) * 100).toFixed(0).padStart(3)}%  avg place ${(s.place / s.games).toFixed(2)}  ` +
      `spawned ${(s.spawned / s.games).toFixed(0).padStart(4)}  kills ${(s.kills / s.games).toFixed(0).padStart(4)}  captures ${(s.captured / s.games).toFixed(1)}`,
  );
}
