// Draw the chokepoint map bots read (#25): rock tiles, nests, and each nest's
// mouths (red), guard posts (green) and staging points (yellow), as one SVG.
//   CAVES=full npx vite-node scripts/choke-sheet.ts [out.svg] [size] [players] [maps]
import { writeFileSync } from 'node:fs';
import { CAVES, LAYOUT, TERRAIN } from './env';
import { nestMouths } from '../src/sim/ai/chokes';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { T_BLOCK, TILE } from '../src/sim/terrain';

const out = process.argv[2] ?? 'choke-sheet.svg';
const size = (process.argv[3] ?? 'medium') as MatchSetup['size'];
const players = Number(process.argv[4] ?? 4);
const maps = Number(process.argv[5] ?? 4);
const S = 0.25, PAD = 14;
let body = '', W = 0, H = 0;
let total = 0, nests = 0, bare = 0;
for (let c = 0; c < maps; c++) {
  const w = createWorld({
    seed: 11 + c * 7, size, terrain: TERRAIN, caves: CAVES, layout: LAYOUT,
    players: Array.from({ length: players }, (_, i) => ({ faction: i, team: i, human: false, bot: { difficulty: 2, personality: 'turtler' as const } })),
  });
  const t = w.terrain;
  const x0 = PAD + c * (w.width * S + PAD);
  const p = (x: number, y: number) => `${(x0 + x * S).toFixed(1)},${(PAD + y * S).toFixed(1)}`;
  body += `<rect x="${x0}" y="${PAD}" width="${w.width * S}" height="${w.height * S}" fill="#0d1022"/>`;
  for (let k = 0; k < t.flags.length; k++) {
    if (!(t.flags[k] & T_BLOCK)) continue;
    const [x, y] = p((k % t.cols) * TILE, ((k / t.cols) | 0) * TILE).split(',');
    body += `<rect x="${x}" y="${y}" width="${TILE * S}" height="${TILE * S}" fill="#2a3060"/>`;
  }
  const mouths = nestMouths(w);
  for (const n of w.nests) {
    const [cx, cy] = p(n.x, n.y).split(',');
    body += `<circle cx="${cx}" cy="${cy}" r="${n.r * S}" fill="${n.owner >= 0 && n.owner < 6 ? '#2de2e6' : 'none'}" stroke="#7ee0a0" stroke-width="1"/>`;
    nests++;
    if (!mouths[n.id].length) bare++;
    for (const m of mouths[n.id]) {
      total++;
      body += `<polyline points="${p(n.x, n.y)} ${p(m.gx, m.gy)}" stroke="#7ee0a066" stroke-width="0.8"/>`;
      body += `<polyline points="${p(m.x, m.y)} ${p(m.sx, m.sy)}" stroke="#ffd16688" stroke-width="0.8"/>`;
      const [mx, my] = p(m.x, m.y).split(','), [gx, gy] = p(m.gx, m.gy).split(','), [sx, sy] = p(m.sx, m.sy).split(',');
      body += `<circle cx="${mx}" cy="${my}" r="${(m.width / 2) * S}" fill="none" stroke="#ff5f6d" stroke-width="1.2"/>`;
      body += `<circle cx="${gx}" cy="${gy}" r="2.5" fill="#06d6a0"/><circle cx="${sx}" cy="${sy}" r="2.5" fill="#ffd166"/>`;
    }
  }
  W = Math.max(W, x0 + w.width * S + PAD);
  H = Math.max(H, w.height * S + 2 * PAD);
}
writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#070914"/>${body}</svg>`);
console.log(`${maps} maps, caves ${CAVES}, terrain ${TERRAIN}: ${total} mouths over ${nests} nests (${bare} with none) -> ${out}`);
