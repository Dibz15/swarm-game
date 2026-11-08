// Sim performance work: prints a worldHash per second of play for a spread
// of matches, so a change meant to keep results identical can be checked
// against the code before it (run on both, diff the output).
//   npx vite-node scripts/hashtrace.ts > after.txt
import { worldHash } from '../src/sim/hash';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Kind, TICK_HZ } from '../src/sim/constants';
import { spawnUnit, type World } from '../src/sim/world';

const bots = (seed: number, n: number, extra: Partial<MatchSetup> = {}): MatchSetup => ({
  seed,
  size: n > 4 ? 'large' : 'medium',
  terrain: 'standard',
  players: Array.from({ length: n }, (_, f) => ({
    faction: f,
    team: extra.players ? f : f,
    human: false,
    bot: { difficulty: (f % 3) as 0 | 1 | 2, personality: (['rusher', 'turtler', 'expander'] as const)[(f + seed) % 3] },
  })),
  ...extra,
});

const teams = (s: MatchSetup): MatchSetup => ({ ...s, players: s.players.map((p, i) => ({ ...p, team: i % 2 })) });

const CASES: [string, MatchSetup][] = [];
for (let seed = 1; seed <= 4; seed++) {
  CASES.push([`4 bots ${seed}`, bots(seed, 4)]);
  CASES.push([`6 bots wild heavy ${seed}`, bots(100 + seed, 6, { terrain: 'heavy', events: 'wild' })]);
  CASES.push([`2v2 caves ${seed}`, teams(bots(200 + seed, 4, { caves: 'full', form: 'caves', events: 'normal' }))]);
  CASES.push([`3v3 open ${seed}`, teams(bots(300 + seed, 6, { terrain: 'none' }))]);
}

/** the ?bench scene: two dense blobs of Dots (n per side) meeting in the middle */
function blobs(w: World, n: number): void {
  for (let k = 0; k < n * 2; k++) {
    const side = k % 2;
    let x = side ? w.width * 0.75 + (k % 37) * 4 : w.width * 0.25 - (k % 37) * 4;
    let y = w.height * 0.2 + ((k * 7) % Math.floor(w.height * 0.6));
    [x, y] = w.terrain.freePoint(x, y, 4);
    spawnUnit(w, side, Kind.Dot, x, y, w.width / 2, w.height / 2, 60);
  }
}
const BLOBS: Record<string, number> = {};
for (const [n, terrain] of [[1500, 'none'], [3000, 'standard'], [2000, 'heavy']] as const) {
  const name = `blobs ${n} ${terrain}`;
  BLOBS[name] = n;
  CASES.push([name, { ...bots(99, 2), size: 'large', terrain, events: 'calm' }]);
}

const secs = Number(process.argv[2] ?? 240);
for (const [name, setup] of CASES) {
  const w = createWorld(setup);
  if (BLOBS[name]) blobs(w, BLOBS[name]);
  const out: string[] = [];
  for (let t = 1; t <= secs * TICK_HZ && !w.over; t++) {
    step(w, []);
    w.fx = [];
    w.deaths = [];
    if (t % TICK_HZ === 0) out.push(worldHash(w).toString(16));
  }
  console.log(`${name}: tick ${w.tick} units ${w.count} ${out.join(' ')}`);
}
