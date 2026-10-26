// Chokepoint A/B (#25): bots at one difficulty, half the seats with choke play
// off (choke: 0). Same personality on every seat per game (rotated across
// games) and seats alternated, so only choke play differs. Reports the win
// rate of the choke-on side. Ablate one behavior with CHOKE='{"stage":false}'.
// Usage: CAVES=full npx vite-node scripts/choke-probe.ts [games] [difficulty] [players] [size] [seed offset]
import { CAVES, LAYOUT, TERRAIN } from './env';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';

const games = Number(process.argv[2] ?? 40);
const difficulty = Number(process.argv[3] ?? 2);
const players = Number(process.argv[4] ?? 2);
const size = (process.argv[5] ?? (players > 2 ? 'medium' : 'small')) as MatchSetup['size'];
const offset = Number(process.argv[6] ?? 0);
const CAP = 15 * 60 * TICK_HZ;

let wins = 0, decided = 0, ticks = 0;
for (let g = offset; g < offset + games; g++) {
  const personality = PERSONALITIES[g % 4];
  // Alternate which seats play chokes.
  const on = (f: number) => (f + g) % 2 === 0;
  const w = createWorld({
    seed: 7700 + g, size, terrain: TERRAIN, caves: CAVES, layout: LAYOUT,
    players: Array.from({ length: players }, (_, f) => ({ faction: f, team: f, human: false, bot: { difficulty, personality, choke: on(f) ? undefined : 0 } })),
  });
  while (!w.over && w.tick < CAP) {
    step(w, []);
    w.fx = [];
    w.deaths = [];
  }
  ticks += w.tick;
  // Winner, or the most nests at the cap.
  let top = -1, topN = -1;
  for (let f = 0; f < players; f++) {
    const k = w.nests.filter((n) => n.owner === f).length;
    if (k > topN) (top = f), (topN = k);
  }
  const winner = w.over ? w.factions.findIndex((fa, f) => f < players && fa.team === w.winnerTeam) : top;
  if (winner < 0) continue;
  decided++;
  if (on(winner)) wins++;
}
const p = wins / Math.max(1, decided);
const ci = 1.96 * Math.sqrt((p * (1 - p)) / Math.max(1, decided));
console.log(
  `${players}p ${size}, difficulty ${difficulty}, caves ${CAVES}, terrain ${TERRAIN}, layout ${LAYOUT}: choke-on side won ${wins}/${decided} = ${(100 * p).toFixed(0)}% ±${(100 * ci).toFixed(0)} ` +
    `(fair ${players > 2 ? 50 : 50}%), avg ${(ticks / games / TICK_HZ / 60).toFixed(1)} min`,
);
