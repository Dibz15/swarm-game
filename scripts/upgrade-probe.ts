// Do upgrades pay? Mirror matches between the same personality, where one
// side upgrades eagerly and the other never does. Seats swap every game.
// Usage: npx vite-node scripts/upgrade-probe.ts [personality] [size] [games] [difficulty]
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { type Personality } from '../src/sim/ai/bot';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';

const pers = (process.argv[2] ?? 'expander') as Personality;
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 40);
const difficulty = Number(process.argv[5] ?? 2);

let upWins = 0, decided = 0, levels = 0, minutes = 0;
for (let g = 0; g < games; g++) {
  const w = createWorld({
    terrain: TERRAIN, caves: CAVES, layout: LAYOUT, events: EVENTS, seed: 4000 + g, size,
    players: [0, 1].map((i) => ({ faction: i, team: i, human: false, bot: { difficulty, personality: pers } })),
  });
  const up = g % 2; // which seat upgrades
  for (const b of w.bots) {
    const k = b as unknown as { p: { upgrade: number } };
    k.p = { ...k.p, upgrade: b.faction === up ? 2 : 0 };
  }
  let lv = 0;
  while (!w.over && w.tick < 12 * 60 * TICK_HZ) {
    step(w, []);
    for (const e of w.fx) if (e.type === 'levelup' && e.f === up) lv++;
    w.fx = [];
  }
  levels += lv;
  minutes += w.tick / TICK_HZ / 60;
  if (w.winnerTeam >= 0) {
    decided++;
    if (w.winnerTeam === up) upWins++;
  }
}
console.log(`${pers} mirror, ${size}, ${games} games (${decided} decided), avg ${(minutes / games).toFixed(1)} min`);
console.log(`upgrader wins ${upWins}/${decided} (${Math.round((100 * upWins) / Math.max(1, decided))}%), ${(levels / games).toFixed(1)} level-ups per game`);
