// Headless sim benchmark. Bundle it first, since vite-node adds its own overhead:
//   npx esbuild scripts/bench.ts --bundle --platform=node --outfile=$TMPDIR/bench.mjs --format=esm
//
// Classic mode, the same scene as ?bench=N: two blobs of Dots marching into
// each other on a large map:
//   TERRAIN=heavy node $TMPDIR/bench.mjs 5000 [ticks]
//
// Multiplayer budgets (#153): four bots on a large standard-terrain map with
// events, plus N extra Dots, at each size. Reports step time, snapshot size
// and cost, restore, fullHash, and how fast a client can catch up:
//   node $TMPDIR/bench.mjs --net [1000,3000,6000] [frame budget ms, default 8]
import { gzipSync } from 'node:zlib';
import { CAVES, EVENTS, TERRAIN } from './env';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Kind, MAX_UNITS, TICK_HZ } from '../src/sim/constants';
import { spawnUnit, type World } from '../src/sim/world';
import { decodeSnap, encodeSnap, fullHash, restoreWorld, snapshotWorld } from '../src/sim/snapshot';

/** Spawn `n` Dots split among `sides` factions, each blob marching to the centre. */
function blobs(w: World, n: number, sides: number): void {
  const count = Math.min(n, MAX_UNITS - w.count - 64);
  for (let k = 0; k < count; k++) {
    const side = k % sides;
    const a = (side / sides) * Math.PI * 2; // plain arithmetic on a constant table is fine here: bench only
    const cx = w.width / 2 + Math.cos(a) * w.width * 0.3, cy = w.height / 2 + Math.sin(a) * w.height * 0.3;
    let x = cx + ((k * 13) % 41) * 4 - 80, y = cy + ((k * 7) % 37) * 4 - 72;
    [x, y] = w.terrain.freePoint(Math.max(8, Math.min(w.width - 8, x)), Math.max(8, Math.min(w.height - 8, y)), 4);
    spawnUnit(w, side, Kind.Dot, x, y, w.width / 2, w.height / 2, 60);
  }
}

const pct = (xs: number[], p: number) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const time = (f: () => void) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

function classic(): void {
  const n = Number(process.argv[2] ?? 5000);
  const ticks = Number(process.argv[3] ?? 600);
  const w = createWorld({
    terrain: TERRAIN,
    caves: CAVES,
    events: EVENTS,
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
    times.push(time(() => step(w, [])));
    maxUnits = Math.max(maxUnits, w.count);
  }
  const warm = times.slice(30);
  const first = mean(times.slice(0, 120));
  console.log(`terrain ${TERRAIN}: ${maxUnits} units, avg ${mean(warm).toFixed(2)} ms/tick (first 4s ${first.toFixed(2)}), p95 ${pct(warm, 0.95).toFixed(2)}, max ${Math.max(...warm).toFixed(2)}`);
}

function net(): void {
  const sizes = (process.argv[3] ?? '1000,3000,6000').split(',').map(Number);
  const budget = Number(process.argv[4] ?? 8);
  const setup: MatchSetup = {
    seed: 99,
    size: 'large',
    terrain: 'standard',
    events: 'normal',
    players: (['rusher', 'turtler', 'expander', 'opportunist'] as const).map((personality, f) => ({
      faction: f, team: f, human: false, bot: { difficulty: 2, personality },
    })),
  };
  console.log(`large map, standard terrain, normal events, 4 Normal bots; catch-up budget ${budget} ms per frame\n`);
  console.log('| extra dots | units | step p50 | p95 | max | snapshot | gzip | encode | createWorld | decode+restore | fullHash | catch-up ticks/frame | catch-up speed |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const n of sizes) {
    const w = createWorld(setup);
    for (let t = 0; t < 5 * TICK_HZ; t++) step(w, []); // let the bots open
    blobs(w, n, 4);
    for (let t = 0; t < 2 * TICK_HZ; t++) step(w, []); // warm up the JIT and the flow fields
    const steps: number[] = [];
    let units = 0;
    for (let t = 0; t < 10 * TICK_HZ && !w.over; t++) {
      steps.push(time(() => step(w, [])));
      units = Math.max(units, w.count);
      w.fx = [];
      w.deaths = [];
    }
    let bytes = new Uint8Array();
    const enc = mean(Array.from({ length: 10 }, () => time(() => (bytes = encodeSnap(snapshotWorld(w))))));
    const gz = gzipSync(bytes).length;
    const make = mean(Array.from({ length: 3 }, () => time(() => createWorld(setup))));
    const rest = mean(Array.from({ length: 3 }, () => time(() => restoreWorld(setup, decodeSnap(bytes)))));
    const hash = mean(Array.from({ length: 10 }, () => time(() => fullHash(w))));
    // catch-up: how many ticks fit in one frame's budget, back to back
    const per: number[] = [];
    for (let f = 0; f < 30 && !w.over; f++) {
      const t0 = performance.now();
      let k = 0;
      while (performance.now() - t0 < budget && !w.over) {
        step(w, []);
        w.fx = [];
        w.deaths = [];
        k++;
      }
      per.push(k);
    }
    const tpf = mean(per);
    const speed = (tpf * 60) / TICK_HZ; // at 60 fps
    const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;
    const ms = (x: number) => `${x.toFixed(2)} ms`;
    console.log(
      `| ${n} | ${units} | ${ms(pct(steps, 0.5))} | ${ms(pct(steps, 0.95))} | ${ms(Math.max(...steps))} | ${kb(bytes.length)} | ${kb(gz)} | ${ms(enc)} | ${ms(make)} | ${ms(rest)} | ${ms(hash)} | ${tpf.toFixed(1)} | ${speed.toFixed(1)}× |`,
    );
  }
}

if (process.argv[2] === '--net') net();
else classic();
