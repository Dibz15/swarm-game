// Layout variety across many seeds (#38, #98): archetype mix, shape, density,
// nest count, spacing, start placement, and how evenly the starts are served.
//   npx vite-node scripts/map-variety.ts [seeds]
import { expansionSpread, generateMap, MAP_LAYOUTS, type MapLayout, type MapSize } from '../src/sim/mapgen';

const SEEDS = Number(process.argv[2] ?? 200);
const stat = (xs: number[]) => {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
  return `${m.toFixed(0)} ± ${sd.toFixed(0)}`.padEnd(11);
};
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

for (const [size, players] of [['small', 2], ['medium', 4], ['medium', 3], ['large', 6]] as [MapSize, number][]) {
  const mix = new Map<MapLayout, number>();
  const aspects = new Map<string, number>(), area: number[] = [], density: number[] = [];
  const count: number[] = [], toCenter: number[] = [], near1: number[] = [], near3: number[] = [], spacing: number[] = [], spread: number[] = [];
  for (let s = 0; s < SEEDS; s++) {
    const m = generateMap({ seed: s, size, players, terrain: 'standard' });
    mix.set(m.layout!, (mix.get(m.layout!) ?? 0) + 1);
    aspects.set(m.aspect!.toFixed(1), (aspects.get(m.aspect!.toFixed(1)) ?? 0) + 1);
    area.push((m.width * m.height) / 1000);
    density.push(m.density! * 100);
    count.push(m.nests.length);
    const cap = m.nests[0];
    toCenter.push(dist(cap, { x: m.width / 2, y: m.height / 2 }));
    const d = m.nests.slice(1).map((n) => dist(cap, n)).sort((a, b) => a - b);
    near1.push(d[0]);
    near3.push(d[2]);
    // mean distance from each nest to its nearest neighbor
    spacing.push(m.nests.reduce((sum, n) => sum + Math.min(...m.nests.filter((o) => o !== n).map((o) => dist(n, o))), 0) / m.nests.length);
    spread.push(expansionSpread(m.nests, players) * 100);
  }
  console.log(`\n${size} ${players}p  (${SEEDS} seeds)`);
  console.log('  layouts      ' + MAP_LAYOUTS.map((l) => `${l} ${mix.get(l) ?? 0}`).join(', '));
  console.log('  aspects      ' + [...aspects].sort().map(([a, n]) => `${a}:1 ${n}`).join(', '));
  console.log(`  area (k px²) ${stat(area)} range ${Math.min(...area).toFixed(0)}–${Math.max(...area).toFixed(0)}`);
  console.log(`  density (%)  ${stat(density)}`);
  console.log(`  nests        ${stat(count)} range ${Math.min(...count)}–${Math.max(...count)}`);
  console.log(`  cap→center   ${stat(toCenter)}`);
  console.log(`  nearest      ${stat(near1)}  3rd nearest ${stat(near3)}`);
  console.log(`  nn spacing   ${stat(spacing)}`);
  console.log(`  start spread ${stat(spread)} (%, 3 nearest expansions, max/min; worst ${Math.max(...spread).toFixed(0)})`);
}
