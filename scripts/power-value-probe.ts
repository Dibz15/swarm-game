// What is a power worth in a straight fight? Two equal blobs clash; side 0
// casts one power at first contact. Measures side 0's surviving share (and
// enemies the power itself killed) against a no-power baseline.
// Usage: npx vite-node scripts/power-value-probe.ts [armySize] [trials]
import { applyCommand } from '../src/sim/commands';
import { Kind, NestType, POWER, TICK_HZ } from '../src/sim/constants';
import { step } from '../src/sim/step';
import { spawnUnit, World } from '../src/sim/world';

const size = Number(process.argv[2] ?? 60);
const trials = Number(process.argv[3] ?? 10);

type Cast = 'none' | 'nova' | 'barrage' | 'barrage x1.5';

function fight(cast: Cast, seed: number, kind: number) {
  const w = new World(seed, 900, 500);
  for (const f of [0, 1]) {
    w.factions[f].active = true;
    w.setTeam(f, f);
  }
  // side 0 holds a Spire behind its army, in Barrage range of the fight
  w.nests.push({ id: 0, x: 60, y: 250, r: 26, type: NestType.Spire, owner: 0, level: 1, control: 1, controller: 0, spawnAcc: 0, rallyX: 60, rallyY: 250, feedProgress: 0, feedIncoming: 0, lastSpawn: 0, contested: false, capital: false, lockedUntil: 0, garrison: 0, visited: 0 });
  const mine: number[] = [];
  for (let i = 0; i < size; i++) {
    mine.push(w.uid[spawnUnit(w, 0, kind, 250 + (i % 8) * 7, 200 + Math.floor(i / 8) * 8 + (seed % 5), 450, 250, 40)]);
    spawnUnit(w, 1, kind, 650 - (i % 8) * 7, 200 + Math.floor(i / 8) * 8, 450, 250, 40);
  }
  w.factions[0].energy = 100;
  let cast2 = false;
  let killedByPower = 0;
  for (let t = 0; t < 60 * TICK_HZ && !w.over && w.unitCount[0] > 0 && w.unitCount[1] > 0; t++) {
    // cast when the fronts meet
    if (!cast2 && w.beamCount > 10) {
      cast2 = true;
      const before = w.unitCount[1];
      let ex = 0, ey = 0, n = 0;
      for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 1) { ex += w.x[i]; ey += w.y[i]; n++; }
      w.grid.build(w);
      if (cast === 'nova') applyCommand(w, { t: 'nova', p: 0, units: mine });
      if (cast.startsWith('barrage')) applyCommand(w, { t: 'barrage', p: 0, x: ex / n, y: ey / n });
      if (cast === 'barrage x1.5') {
        // spend the same 60 energy as a Nova: a second, half-value strike later
        w.factions[0].energy += 20;
      }
      // count kills by the power over its window
      const until = w.tick + POWER.barrageDelay + 3;
      while (w.tick < until && !w.over) step(w, []);
      killedByPower = before - w.unitCount[1];
      if (cast === 'barrage x1.5') {
        let fx = 0, fy = 0, m = 0;
        for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 1) { fx += w.x[i]; fy += w.y[i]; m++; }
        if (m) { w.grid.build(w); applyCommand(w, { t: 'barrage', p: 0, x: fx / m, y: fy / m }); }
      }
      continue;
    }
    step(w, []);
  }
  return { left: w.unitCount[0] / size, won: w.unitCount[0] > w.unitCount[1], killedByPower };
}

for (const [kname, kind] of [['Swarmers', Kind.Dot], ['Shields', Kind.Tank]] as const) {
  console.log(`${size} vs ${size} ${kname}, ${trials} trials`);
  for (const cast of ['none', 'nova', 'barrage', 'barrage x1.5'] as Cast[]) {
    let left = 0, won = 0, kp = 0;
    for (let t = 0; t < trials; t++) {
      const r = fight(cast, 200 + t, kind);
      left += r.left; won += r.won ? 1 : 0; kp += r.killedByPower;
    }
    console.log(`  ${cast.padEnd(13)} win ${String(Math.round((won / trials) * 100)).padStart(3)}%  own survivors ${String(Math.round((left / trials) * 100)).padStart(3)}%  enemy deaths in cast window ${(kp / trials).toFixed(1)}`);
  }
}
