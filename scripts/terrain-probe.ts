// Terrain generation probe: feature counts, connectivity and build time per
// size, players and preset; optionally prints one map as ASCII.
// Usage: npx vite-node scripts/terrain-probe.ts [preset] [seeds] [ascii-seed]
import { generateMap, MAP_SIZES, type MapSize, type TerrainLevel } from '../src/sim/mapgen';
import { Terrain, T_BLOCK, T_NEBULA, T_RIFT, TILE } from '../src/sim/terrain';

const preset = (process.argv[2] ?? 'standard') as TerrainLevel;
const seeds = Number(process.argv[3] ?? 40);
const asciiSeed = process.argv[4];

for (const size of Object.keys(MAP_SIZES) as MapSize[]) {
  for (const players of [2, 3, 4, 6]) {
    {
      let walls = 0, neb = 0, rift = 0, crys = 0, bad = 0, ms = 0, blocked = 0;
      for (let s = 0; s < seeds; s++) {
        const t0 = performance.now();
        const m = generateMap({ seed: 5000 + s, size, players, terrain: preset });
        const tr = new Terrain(m.terrain, m.width, m.height);
        ms += performance.now() - t0;
        walls += m.terrain.walls.length;
        neb += m.terrain.fields.filter((f) => f.kind === 'nebula').length;
        rift += m.terrain.fields.filter((f) => f.kind === 'rift').length;
        crys += m.terrain.crystals.length;
        if (!tr.connected(m.nests.map((n) => [n.x, n.y]))) bad++;
        let b = 0;
        for (const f of tr.flags) if (f & T_BLOCK) b++;
        blocked += b / tr.flags.length;
      }
      console.log(
        `${size.padEnd(6)} ${players}p: walls ${(walls / seeds).toFixed(1)}, nebula ${(neb / seeds).toFixed(1)}, rifts ${(rift / seeds).toFixed(1)}, crystals ${(crys / seeds).toFixed(1)}, blocked ${((100 * blocked) / seeds).toFixed(1)}%, disconnected ${bad}, gen ${(ms / seeds).toFixed(1)} ms`,
      );
    }
  }
}

if (asciiSeed) {
  const m = generateMap({ seed: Number(asciiSeed), size: 'medium', players: Number(process.argv[5] ?? 3), terrain: preset });
  const tr = new Terrain(m.terrain, m.width, m.height);
  const rows: string[] = [];
  for (let y = 0; y < tr.rows; y += 2) {
    let line = '';
    for (let x = 0; x < tr.cols; x++) {
      const px = (x + 0.5) * TILE, py = (y + 0.5) * TILE;
      const nest = m.nests.find((n) => (n.x - px) ** 2 + (n.y - py) ** 2 < 20 * 20);
      const cr = m.terrain.crystals.find((c) => (c.x - px) ** 2 + (c.y - py) ** 2 < 14 * 14);
      const f = tr.flags[y * tr.cols + x];
      line += nest ? (nest.player >= 0 ? String(nest.player) : 'N') : cr ? '*' : f & T_BLOCK ? '#' : f & T_RIFT ? '~' : f & T_NEBULA ? ':' : '.';
    }
    rows.push(line);
  }
  console.log(rows.join('\n'));
}
