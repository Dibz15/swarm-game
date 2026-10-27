// Put the human proxy in the human's seat of a recording: same map, seed and bots (#29, #37).
// Shows how the proxy fares in the exact game the human played. The game diverges from the
// recording at once, so compare outcomes, not moments.
// Usage: npx vite-node scripts/proxy-seat.ts recordings/<file>.json [index]   (PROXY='{...}' for knobs)
import { readFileSync } from 'node:fs';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Proxy } from '../src/proxy/proxy';
import { countDeaths, share, tally } from './deaths';
const d = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = (d.recordings ?? [d])[Number(process.argv[3] ?? 0)];
const w = createWorld(r.setup);
const p = new Proxy(r.human, { knobs: process.env.PROXY ? JSON.parse(process.env.PROXY) : {} });
const died = tally();
let powers = 0, orders = 0;
const ps = r.setup.players.map((x: { faction: number }) => x.faction);
while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
  const c = p.think(w);
  orders += c.length;
  powers += c.filter((x) => !['move', 'rally', 'upgrade'].includes(x.t)).length;
  step(w, c);
  countDeaths(w, (o) => (o === r.human ? died : null));
  w.fx = []; w.deaths = [];
  if (w.tick % (60 * TICK_HZ) === 0) console.log(`${w.tick / TICK_HZ}s`, ps.map((f: number) => `${f === r.human ? 'PROXY' : 'f' + f} n${w.nests.filter((n) => n.owner === f).length} u${w.unitCount[f]}`).join(' | '));
}
const s = w.factions[r.human].stats;
console.log('end', w.winReason ?? 'cap', 'winner team', w.winnerTeam, (w.tick / TICK_HZ / 60).toFixed(1), 'min', 'K/L', (s.kills / s.lost).toFixed(2), 'powers/min', (powers / (w.tick / TICK_HZ / 60)).toFixed(1), 'orders/min', (orders / (w.tick / TICK_HZ / 60)).toFixed(1));
console.log('proxy died:', share(died));
