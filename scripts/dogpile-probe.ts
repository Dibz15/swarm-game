// FFA pile-ons (#28): 4 players, the human proxy plus 3 bots. Per time window, the share
// of bot attack dots aimed at the proxy (fair share: 1 in 3 rivals) next to the proxy's
// share of all units, so "everyone jumps the human the moment it leads" shows up.
// Usage: npx vite-node scripts/dogpile-probe.ts [games] [difficulty]
import './env';
import { Bot, PERSONALITIES } from '../src/sim/ai/bot';
import type { Command } from '../src/sim/commands';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import type { World } from '../src/sim/world';
import { Proxy } from './proxy';

const games = Number(process.argv[2] ?? 16);
const difficulty = Number(process.argv[3] ?? 2);
const WINDOW = 30 * TICK_HZ;
const WINDOWS = 12;

// Per window: bot attack dots on any player, on the proxy; proxy unit share samples.
const all = new Array(WINDOWS).fill(0), onProxy = new Array(WINDOWS).fill(0), share: number[][] = Array.from({ length: WINDOWS }, () => []);
let proxySeat = 0;
/** each dot counts once per rival it is sent at (bots re-send dots already fighting there) */
let seen = new Set<string>();
const proto = Bot.prototype as unknown as { issue(w: World, c: Command): void };
const real = proto.issue;
proto.issue = function (this: Bot, w: World, c: Command) {
  if (c.t === 'move' && c.nest >= 0) {
    const o = w.nests[c.nest].owner;
    const k = Math.floor(w.tick / WINDOW);
    if (o >= 0 && o !== NEUTRAL && o !== c.p && k < WINDOWS) {
      for (const u of c.units) {
        const key = `${u}>${o}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all[k]++;
        if (o === proxySeat) onProxy[k]++;
      }
    }
  }
  real.call(this, w, c);
};

let proxyWins = 0;
for (let g = 0; g < games; g++) {
  proxySeat = g % 4;
  seen = new Set();
  const w = createWorld({
    seed: 7300 + g,
    size: 'medium',
    terrain: 'standard',
    events: 'normal',
    players: [0, 1, 2, 3].map((i) =>
      i === proxySeat ? { faction: i, team: i, human: true } : { faction: i, team: i, human: false, bot: { difficulty, personality: PERSONALITIES[(i + g) % 4] } },
    ),
  });
  const proxy = new Proxy(proxySeat, { knobs: process.env.PROXY ? JSON.parse(process.env.PROXY) : {} });
  while (!w.over && w.tick < WINDOWS * WINDOW) {
    step(w, proxy.think(w));
    w.fx = [];
    w.deaths = [];
    if (w.tick % (5 * TICK_HZ) === 0) {
      let tot = 0;
      for (let f = 0; f < NEUTRAL; f++) tot += w.unitCount[f];
      share[Math.floor((w.tick - 1) / WINDOW)]?.push(w.unitCount[proxySeat] / Math.max(1, tot));
    }
  }
  if (w.over && w.winnerTeam === w.teamOf[proxySeat]) proxyWins++;
}
console.log(`4p medium, proxy + 3 bots at difficulty ${difficulty}, ${games} games; proxy won ${proxyWins} within ${(WINDOWS * WINDOW) / TICK_HZ / 60} min`);
console.log('window    proxy unit share   bot attack dots on proxy (fair 33%)');
for (let k = 0; k < WINDOWS; k++) {
  const s = share[k].length ? share[k].reduce((a, b) => a + b, 0) / share[k].length : NaN;
  const p = all[k] ? (100 * onProxy[k]) / all[k] : NaN;
  console.log(`${((k * WINDOW) / TICK_HZ / 60).toFixed(1)}-${(((k + 1) * WINDOW) / TICK_HZ / 60).toFixed(1)}m   ${(100 * s).toFixed(0).padStart(5)}%            ${Number.isFinite(p) ? p.toFixed(0).padStart(4) + '%' : '   -'}  (${all[k]} dots)`);
}
