// Living-map events: how often each fires, who profits, and whether the
// profits decide matches. Every game seats all personalities, rotated.
// Usage: EVENTS=normal TERRAIN=standard npx vite-node scripts/event-probe.ts [players] [size] [games] [difficulty]
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';

const players = Number(process.argv[2] ?? 4);
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 20);
const difficulty = Number(process.argv[5] ?? 1);

const tally = { swarms: 0, drops: 0, dropsTaken: 0, colossi: 0, colossusKills: 0, reverts: 0 };
const byPers: Record<string, { drops: number; colossus: number; wins: number }> = {};
for (const p of PERSONALITIES) byPers[p] = { drops: 0, colossus: 0, wins: 0 };
let leaderDrops = 0;
let winnerHadMostDrops = 0, decided = 0, minutes = 0;

for (let g = 0; g < games; g++) {
  const pers = Array.from({ length: players }, (_, i) => PERSONALITIES[(i + g) % 4]);
  const w = createWorld({
    terrain: TERRAIN, caves: CAVES, layout: LAYOUT, events: EVENTS, seed: 6000 + g, size,
    players: pers.map((p, i) => ({ faction: i, team: i, human: false, bot: { difficulty, personality: p } })),
  });
  const drops = new Array(players).fill(0);
  while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
    step(w, []);
    for (const e of w.fx) {
      if (e.type === 'swarmSpawn') tally.swarms++;
      if (e.type === 'dropIncoming') tally.drops++;
      if (e.type === 'dropTaken') {
        tally.dropsTaken++;
        let lead = 0;
        for (let f = 1; f < players; f++) if (w.unitCount[f] > w.unitCount[lead]) lead = f;
        if (lead === e.f) leaderDrops++;
        drops[e.f]++;
        byPers[pers[e.f]].drops++;
      }
      if (e.type === 'colossusSpawn') tally.colossi++;
      if (e.type === 'colossusDown' && e.f >= 0 && e.f < NEUTRAL) {
        tally.colossusKills++;
        byPers[pers[e.f]].colossus++;
      }
      if (e.type === 'neutralize' && e.f === NEUTRAL) tally.reverts++;
    }
    w.fx = [];
  }
  minutes += w.tick / TICK_HZ / 60;
  if (w.winnerTeam >= 0 && w.winnerTeam < players) {
    byPers[pers[w.winnerTeam]].wins++;
    if (drops.some((d) => d > 0)) {
      decided++;
      if (drops[w.winnerTeam] === Math.max(...drops)) winnerHadMostDrops++;
    }
  }
}
const per = (n: number) => (n / games).toFixed(1);
console.log(`${players}p ${size}, events ${EVENTS}, terrain ${TERRAIN}, ${games} games, avg ${(minutes / games).toFixed(1)} min`);
console.log(`per game: swarms ${per(tally.swarms)}, drops ${per(tally.drops)} (taken ${per(tally.dropsTaken)}), colossi ${per(tally.colossi)} (slain ${per(tally.colossusKills)}), nests gone wild ${per(tally.reverts)}`);
console.log(`drops taken by the current army leader: ${Math.round((100 * leaderDrops) / Math.max(1, tally.dropsTaken))}% (even split ≈ ${Math.round(100 / players)}%)`);
console.log(`winner had the most drops in ${winnerHadMostDrops}/${decided} games where drops were taken (chance ≈ ${Math.round(100 / players)}%+ with ties)`);
for (const [p, v] of Object.entries(byPers)) console.log(`${p.padEnd(12)} wins ${String(v.wins).padStart(3)}  drops ${String(v.drops).padStart(3)}  colossus kills ${v.colossus}`);
