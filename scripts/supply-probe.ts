// Army size vs nests held over a match: how big armies get, and how much
// headroom a supply cap (base + perNest x nests) would leave.
//   npx esbuild scripts/supply-probe.ts --bundle --platform=node --format=esm --outfile=$TMPDIR/sp.mjs && TERRAIN=standard EVENTS=normal node $TMPDIR/sp.mjs 20
import { CAVES, EVENTS, TERRAIN } from './env';
import { botMatch } from '../tests/helpers';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';

const games = Number(process.argv[2] ?? 20);
const minutes = [1, 2, 3, 4, 5, 6, 7, 8];
const rows = minutes.map(() => ({ n: 0, units: [] as number[], perNest: [] as number[], nests: [] as number[] }));
for (let g = 0; g < games; g++) {
  const w = createWorld({ ...botMatch(9100 + g), terrain: TERRAIN, caves: CAVES, events: EVENTS });
  while (!w.over && w.tick < 8 * 60 * TICK_HZ) {
    step(w, []);
    w.fx = [];
    w.deaths = [];
    const m = w.tick / TICK_HZ / 60;
    const k = minutes.indexOf(m);
    if (k < 0) continue;
    for (const f of w.factions) {
      if (!f.active || f.id === NEUTRAL || f.eliminated) continue;
      const nests = w.nests.filter((n) => n.owner === f.id).length;
      rows[k].units.push(w.unitCount[f.id]);
      rows[k].nests.push(nests);
      if (nests > 0) rows[k].perNest.push(w.unitCount[f.id] / nests);
    }
  }
}
const q = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
for (let k = 0; k < minutes.length; k++) {
  const r = rows[k];
  console.log(
    `${minutes[k]}m  players ${String(r.units.length).padStart(3)}  units med ${q(r.units, 0.5).toFixed(0).padStart(3)} p90 ${q(r.units, 0.9).toFixed(0).padStart(3)} max ${q(r.units, 1).toFixed(0).padStart(3)}` +
      `  nests med ${q(r.nests, 0.5)} p90 ${q(r.nests, 0.9)}  units/nest med ${q(r.perNest, 0.5).toFixed(0).padStart(3)} p90 ${q(r.perNest, 0.9).toFixed(0).padStart(3)} max ${q(r.perNest, 1).toFixed(0)}`,
  );
}
