// Nest-type mix across many generated maps (neutral nests only).
import { generateMap } from '../src/sim/mapgen';
import { NEST_NAMES } from '../src/sim/constants';
const counts = [0, 0, 0, 0, 0];
let worst = 0;
for (let s = 0; s < 200; s++) {
  for (const size of ['small', 'medium', 'large'] as const) {
    const m = generateMap(s, size, 2 + (s % 5));
    const neutral = m.nests.filter((n) => n.player < 0);
    neutral.forEach((n) => counts[n.type]++);
    worst = Math.max(worst, neutral.filter((n) => n.type === 4).length / neutral.length);
  }
}
const total = counts.reduce((a, b) => a + b, 0);
console.log(counts.map((c, i) => `${NEST_NAMES[i]} ${((c / total) * 100).toFixed(0)}%`).join(', '), `| worst Bastion share ${(worst * 100).toFixed(0)}%`);
