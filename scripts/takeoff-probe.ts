// Runaway leaders: how far ahead does the top army get, and how often does an
// early leader get caught? Compares supply cap variants on the same seeds.
//   npx esbuild scripts/takeoff-probe.ts --bundle --platform=node --format=esm --outfile=$TMPDIR/to.mjs && TERRAIN=standard EVENTS=normal node $TMPDIR/to.mjs 24
import { CAVES, EVENTS, TERRAIN } from './env';
import { botMatch } from '../tests/helpers';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { BALANCE, NEUTRAL, SUPPLY, TICK_HZ } from '../src/sim/constants';

const games = Number(process.argv[2] ?? 24);
const base = { ...SUPPLY };
const baseBal = { ...BALANCE };
type Cfg = { supply?: Partial<typeof SUPPLY>; balance?: Partial<typeof BALANCE> };
const variants: [string, Cfg][] = [
  ['linear cap, no upkeep', { supply: { upkeep: 0, fullNests: 99, tail: 1 } }],
  ['upkeep .5 + tail .5@6 (fades)', { supply: { upkeep: 0.5, fullNests: 6, tail: 0.5 } }],
  ['upkeep .4 + tail .5@6 (fades)', { supply: { upkeep: 0.4, fullNests: 6, tail: 0.5 } }],
  ['upkeep .6 + tail .5@6 (fades)', { supply: { upkeep: 0.6, fullNests: 6, tail: 0.5 } }],
];
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
for (const [name, cfg] of variants) {
  Object.assign(SUPPLY, base, cfg.supply ?? {});
  Object.assign(BALANCE, baseBal, cfg.balance ?? {});
  const ratio: number[][] = [[], [], []];
  const at = [3, 5, 7];
  let mins = 0, comebacks = 0, runaway = 0, runawayToEnd = 0;
  for (let g = 0; g < games; g++) {
    const w = createWorld({ ...botMatch(1200 + g), terrain: TERRAIN, caves: CAVES, events: EVENTS });
    let early = -1, runTick = -1;
    while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
      step(w, []);
      w.fx = [];
      w.deaths = [];
      if (w.tick % TICK_HZ) continue;
      const alive = w.factions.filter((f) => f.active && f.id !== NEUTRAL && !f.eliminated).map((f) => w.unitCount[f.id]).sort((a, b) => b - a);
      const r = alive.length > 1 ? alive[0] / Math.max(1, alive[1]) : 0;
      const k = at.indexOf(w.tick / TICK_HZ / 60);
      if (k >= 0 && alive.length > 1) ratio[k].push(r);
      if (w.tick === 120 * TICK_HZ) {
        let l = 0;
        for (let f = 1; f < 4; f++) if (w.unitCount[f] > w.unitCount[l]) l = f;
        early = l;
      }
      // Runaway: the top army is 3x the next while 3+ players are still in.
      if (runTick < 0 && alive.length >= 3 && r >= 3) runTick = w.tick;
    }
    mins += w.tick / TICK_HZ / 60;
    if (early >= 0 && w.winnerTeam !== early) comebacks++;
    if (runTick >= 0) {
      runaway++;
      runawayToEnd += (w.tick - runTick) / TICK_HZ / 60;
    }
  }
  console.log(
    `${name.padEnd(28)} avg ${(mins / games).toFixed(1)} min  comebacks ${String(comebacks).padStart(2)}/${games}` +
      `  top/2nd army med ${at.map((m, k) => `${m}m ${med(ratio[k]).toFixed(2)}`).join(' ')}` +
      `  runaways ${runaway}/${games}${runaway ? ` (end ${(runawayToEnd / runaway).toFixed(1)} min later)` : ''}`,
  );
}
