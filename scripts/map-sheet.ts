// Draw generated maps as one SVG contact sheet: one row per layout (#38).
//   npx vite-node scripts/map-sheet.ts [out.svg] [size] [players]
import { writeFileSync } from 'node:fs';
import { generateMap, MAP_LAYOUTS, type MapSize } from '../src/sim/mapgen';
import { NEST_RADIUS } from '../src/sim/constants';

const out = process.argv[2] ?? 'map-sheet.svg';
const size = (process.argv[3] ?? 'medium') as MapSize;
const players = Number(process.argv[4] ?? 4);
const COLS = 4, S = 0.2, PAD = 14;
const NEST_COLOR = ['#7ee0a0', '#e0b07e', '#7ec8e0', '#e07ec8', '#c8c8c8'];
const PLAYER_COLOR = ['#2de2e6', '#ff5f6d', '#ffd166', '#9b5de5', '#06d6a0', '#f15bb5'];
let body = '', W = 0, y0 = 0;
for (const layout of MAP_LAYOUTS) {
  let rowH = 0;
  for (let c = 0; c < COLS; c++) {
    const m = generateMap({ seed: 11 + c * 7, size, players, layout, terrain: 'standard' });
    const x0 = PAD + c * (m.width * S + PAD);
    const t = (x: number, y: number) => `${(x0 + x * S).toFixed(1)},${(y0 + 22 + y * S).toFixed(1)}`;
    body += `<rect x="${x0}" y="${y0 + 22}" width="${m.width * S}" height="${m.height * S}" fill="#0d1022" stroke="#2a3060"/>`;
    for (const f of m.terrain.fields) body += `<polyline points="${t(f.x1, f.y1)} ${t(f.x2, f.y2)}" stroke="${f.kind === 'rift' ? '#c0392b' : '#4b2a6a'}" stroke-width="${f.r * 2 * S}" stroke-linecap="round" opacity="0.8"/>`;
    for (const wl of m.terrain.walls) body += `<polyline points="${t(wl.x1, wl.y1)} ${t(wl.x2, wl.y2)}" stroke="#3a4380" stroke-width="${wl.r * 2 * S}" stroke-linecap="round"/>`;
    for (const k of m.terrain.crystals) body += `<circle cx="${t(k.x, k.y).split(',')[0]}" cy="${t(k.x, k.y).split(',')[1]}" r="${k.r * S}" fill="none" stroke="#b9f" stroke-width="1.5"/>`;
    for (const n of m.nests) {
      const [cx, cy] = t(n.x, n.y).split(',');
      const col = n.player >= 0 ? PLAYER_COLOR[n.player] : NEST_COLOR[n.type];
      body += `<circle cx="${cx}" cy="${cy}" r="${NEST_RADIUS[n.type] * S * (n.level > 1 ? 1.4 : 1)}" fill="${n.player >= 0 ? col : 'none'}" stroke="${col}" stroke-width="1.5"/>`;
    }
    W = Math.max(W, x0 + m.width * S + PAD);
    rowH = Math.max(rowH, m.height * S + 30);
  }
  body += `<text x="${PAD}" y="${y0 + 16}" fill="#cfd3ff" font-family="sans-serif" font-size="13">${layout}</text>`;
  y0 += rowH;
}
writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y0}" viewBox="0 0 ${W} ${y0}"><rect width="100%" height="100%" fill="#070914"/>${body}</svg>`);
console.log(`wrote ${out}`);
