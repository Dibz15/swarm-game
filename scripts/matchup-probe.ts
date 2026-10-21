// Rock-paper-scissors check: equal-cost armies of each unit kind fight in the
// open. Cost = production time at nest level 1, so armies are comparable.
// Prints win rate and the winner's surviving share of its starting value.
// Usage: npx vite-node scripts/matchup-probe.ts [budgetSeconds] [trials]
import { World, spawnUnit } from '../src/sim/world';
import { step } from '../src/sim/step';
import { Kind, TICK_HZ, UNIT_STATS } from '../src/sim/constants';

const budget = Number(process.argv[2] ?? 70);
const trials = Number(process.argv[3] ?? 8);
const names = ['Dot', 'Tank', 'Lancer', 'Swift'];
const kinds = [Kind.Dot, Kind.Tank, Kind.Lancer, Kind.Swift];

function fight(a: number, b: number, seed: number): { winner: number; left: number } {
  const w = new World(seed, 800, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  const army = (f: number, k: number, x: number) => {
    const n = Math.round(budget / UNIT_STATS[k].interval);
    for (let i = 0; i < n; i++) {
      const y = 250 + ((i * 37 + seed * 11) % 160) - 80;
      spawnUnit(w, f, k, x + ((i * 13) % 50), y, 400, 250, 40);
    }
    return n;
  };
  const na = army(0, a, 150), nb = army(1, b, 600);
  while (w.tick < 90 * TICK_HZ && w.unitCount[0] > 0 && w.unitCount[1] > 0) step(w, []);
  const winner = w.unitCount[0] > w.unitCount[1] ? 0 : w.unitCount[1] > w.unitCount[0] ? 1 : -1;
  const left = winner === 0 ? w.unitCount[0] / na : winner === 1 ? w.unitCount[1] / nb : 0;
  return { winner, left };
}

console.log(`equal ${budget}s armies, ${trials} trials each. Cell = row's win rate (avg survivors of winner)`);
console.log('            ' + names.map((n) => n.padEnd(14)).join(''));
for (const a of kinds) {
  const cells: string[] = [];
  for (const b of kinds) {
    if (a === b) {
      cells.push('—'.padEnd(14));
      continue;
    }
    let wins = 0, left = 0;
    for (let t = 0; t < trials; t++) {
      // alternate sides to cancel positional bias
      const r = t % 2 === 0 ? fight(a, b, 100 + t) : fight(b, a, 100 + t);
      const aWon = t % 2 === 0 ? r.winner === 0 : r.winner === 1;
      if (aWon) {
        wins++;
        left += r.left;
      }
    }
    cells.push(`${Math.round((wins / trials) * 100)}% (${wins ? Math.round((left / wins) * 100) : 0}%)`.padEnd(14));
  }
  console.log(names[a].padEnd(12) + cells.join(''));
}
