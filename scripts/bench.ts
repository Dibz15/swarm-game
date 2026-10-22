// Headless sim benchmark, the same scene as ?bench=N: two blobs of Dots
// marching into each other on a large map. Bundle it first, since vite-node
// adds its own overhead:
//   npx esbuild scripts/bench.ts --bundle --platform=node --outfile=$TMPDIR/bench.mjs --format=esm && TERRAIN=heavy node $TMPDIR/bench.mjs 5000
import { TERRAIN } from './env';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Kind, MAX_UNITS } from '../src/sim/constants';
import { spawnUnit } from '../src/sim/world';

const n = Number(process.argv[2] ?? 5000);
const ticks = Number(process.argv[3] ?? 600);
const w = createWorld({
  terrain: TERRAIN,
  seed: 99,
  size: 'large',
  players: [
    { faction: 0, team: 0, human: false, bot: { difficulty: 0, personality: 'turtler' } },
    { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'turtler' } },
  ],
});
const half = Math.floor(Math.min(n, MAX_UNITS - w.count - 64) / 2);
for (let k = 0; k < half * 2; k++) {
  const side = k % 2;
  let x = side ? w.width * 0.75 + (k % 37) * 4 : w.width * 0.25 - (k % 37) * 4;
  let y = w.height * 0.2 + ((k * 7) % Math.floor(w.height * 0.6));
  [x, y] = w.terrain.freePoint(x, y, 4);
  spawnUnit(w, side, Kind.Dot, x, y, w.width / 2, w.height / 2, 60);
}
const times: number[] = [];
let maxUnits = 0;
for (let t = 0; t < ticks && !w.over; t++) {
  const t0 = performance.now();
  step(w, []);
  times.push(performance.now() - t0);
  maxUnits = Math.max(maxUnits, w.count);
}
const warm = times.slice(30);
const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
const first = times.slice(0, 120).reduce((a, b) => a + b, 0) / Math.min(120, times.length);
warm.sort((a, b) => a - b);
console.log(`terrain ${TERRAIN}: ${maxUnits} units, avg ${avg.toFixed(2)} ms/tick (first 4s ${first.toFixed(2)}), p95 ${warm[Math.floor(warm.length * 0.95)].toFixed(2)}, max ${warm[warm.length - 1].toFixed(2)}`);
