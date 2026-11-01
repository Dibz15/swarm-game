// Terrain generation probe: feature counts, connectivity and build time per
// size, players and preset; optionally prints one map as ASCII.
// Usage: npx vite-node scripts/terrain-probe.ts [preset] [seeds] [ascii-seed]
//
// Match mode (#114): bot games on the preset, reporting how much the terrain
// is used per match: crystal hold time, unit-seconds spent in nebula, and for
// rifts (#58) the times a unit walks in, unit-seconds inside, damage dealt and
// units that die inside. Report only; tuning is #68.
// Usage: npx vite-node scripts/terrain-probe.ts match [games] [players] [preset]
import { PERSONALITIES } from '../src/sim/ai/bot';
import { DT, TICK_HZ } from '../src/sim/constants';
import { generateMap, MAP_SIZES, type MapSize, type TerrainLevel } from '../src/sim/mapgen';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { riftDps, Terrain, T_BLOCK, T_NEBULA, T_RIFT, TILE } from '../src/sim/terrain';

if (process.argv[2] === 'match') {
  const games = Number(process.argv[3] ?? 12);
  const players = Number(process.argv[4] ?? 2);
  const preset = (process.argv[5] ?? 'standard') as TerrainLevel;
  const CAP = 12 * 60 * TICK_HZ;
  let held = 0, crystals = 0, crystalSec = 0, nebula = 0, rift = 0, riftSec = 0, entries = 0, riftDeaths = 0, unitSec = 0, mins = 0;
  for (let g = 0; g < games; g++) {
    const w = createWorld({
      seed: 3300 + g, size: players > 2 ? 'medium' : 'small', terrain: preset,
      players: Array.from({ length: players }, (_, f) => ({ faction: f, team: f, human: false, bot: { difficulty: 2, personality: PERSONALITIES[(f + g) % 4] } })),
    });
    crystals += w.crystals.length;
    // Units in a rift last tick, by uid: who walked in, and who died inside.
    let inside = new Set<number>();
    while (!w.over && w.tick < CAP) {
      step(w, []);
      for (const u of inside) if (!w.uidToSlot.has(u)) riftDeaths++;
      const now = new Set<number>();
      w.fx = [];
      w.deaths = [];
      for (const c of w.crystals) if (c.holder >= 0) held += DT;
      if (!w.terrain.hasFields) continue;
      for (let i = 0; i < w.n; i++) {
        if (!w.alive[i] || w.owner[i] >= players) continue;
        unitSec += DT;
        const fl = w.terrain.flagsAt(w.x[i], w.y[i]);
        if (fl & T_NEBULA) nebula += DT;
        if (fl & T_RIFT) {
          rift += riftDps(w.heat[i]) * DT;
          riftSec += DT;
          now.add(w.uid[i]);
          if (!inside.has(w.uid[i])) entries++;
        }
      }
      inside = now;
    }
    mins += w.tick / TICK_HZ / 60;
    crystalSec += (w.crystals.length * w.tick) / TICK_HZ;
  }
  console.log(
    `${players}p ${preset}, ${games} games, avg ${(mins / games).toFixed(1)} min: ` +
      `crystals ${(crystals / games).toFixed(1)}/map, held ${(held / Math.max(1, crystals)).toFixed(0)} s each (${((100 * held) / Math.max(1e-9, crystalSec)).toFixed(0)}% of the match), ` +
      `nebula ${(nebula / games).toFixed(0)} unit-s/match (${((100 * nebula) / Math.max(1e-9, unitSec)).toFixed(1)}% of unit time), ` +
      `rift: ${(entries / games).toFixed(0)} walk-ins, ${(riftSec / games).toFixed(0)} unit-s (${((100 * riftSec) / Math.max(1e-9, unitSec)).toFixed(2)}%), ` +
      `damage ${(rift / games).toFixed(0)}, ${(riftDeaths / games).toFixed(1)} deaths inside /match`,
  );
  process.exit(0);
}

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
