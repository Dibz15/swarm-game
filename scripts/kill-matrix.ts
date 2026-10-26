// Who kills whom: are the eventual losers killed by the winner, or by each other?
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { Bot, PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import type { Command } from '../src/sim/commands';
import type { World } from '../src/sim/world';

const players = Number(process.argv[2] ?? 4);
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 20);

let loserByWinner = 0, loserByLoser = 0, winnerByLoser = 0;
let ordersAtLeader = 0, ordersAtOthers = 0, leaderBonusActive = 0, thinks = 0;
let leaderNow = -1;
const orig = (Bot.prototype as any).issue;
(Bot.prototype as any).issue = function (w: World, c: Command) {
  if (c.t === 'move' && c.nest >= 0) {
    const o = w.nests[c.nest].owner;
    if (o >= 0 && o < players && o !== c.p) {
      if (o === leaderNow) ordersAtLeader += c.units.length;
      else ordersAtOthers += c.units.length;
    }
  }
  return orig.call(this, w, c);
};

for (let g = 0; g < games; g++) {
  const w = createWorld({ terrain: TERRAIN, caves: CAVES, layout: LAYOUT, events: EVENTS, 
    seed: 3000 + g, size,
    players: Array.from({ length: players }, (_, i) => ({ faction: i, team: i, human: false, bot: { difficulty: 1, personality: PERSONALITIES[(i + g) % 4] } })),
  });
  const kills: number[][] = Array.from({ length: players }, () => new Array(players).fill(0));
  const was = new Uint32Array(w.alive.length);
  const wasOwner = new Uint8Array(w.alive.length);
  while (!w.over && w.tick < 12 * 60 * TICK_HZ) {
    // the leader (biggest army) after the first 90s
    leaderNow = -1;
    if (w.tick > 90 * TICK_HZ) {
      let best = 0;
      for (let f = 0; f < players; f++) if (!w.factions[f].eliminated && w.unitCount[f] > best) { best = w.unitCount[f]; leaderNow = f; }
    }
    for (let i = 0; i < w.n; i++) { was[i] = w.alive[i] ? w.uid[i] : 0; wasOwner[i] = w.owner[i]; }
    step(w, []);
    for (let i = 0; i < w.n; i++) {
      if (!was[i] || (w.alive[i] && w.uid[i] === was[i])) continue;
      const k = w.lastHit[i], v = wasOwner[i];
      if (k >= 0 && k < players && v < players && k !== v) kills[k][v]++;
    }
    w.fx = []; w.deaths = [];
  }
  const win = w.winnerTeam;
  for (let k = 0; k < players; k++) for (let v = 0; v < players; v++) {
    if (k === win && v !== win) loserByWinner += kills[k][v];
    else if (k !== win && v !== win) loserByLoser += kills[k][v];
    else if (k !== win && v === win) winnerByLoser += kills[k][v];
  }
}
const t = loserByWinner + loserByLoser;
console.log(`losers' dots killed by the winner: ${((loserByWinner / t) * 100).toFixed(0)}%, by other losers: ${((loserByLoser / t) * 100).toFixed(0)}%`);
console.log(`winner's dots killed (by losers): ${winnerByLoser}  vs losers' dots killed by winner: ${loserByWinner}`);
console.log(`after 90s, dots bots ordered at the current army leader: ${((ordersAtLeader / (ordersAtLeader + ordersAtOthers)) * 100).toFixed(0)}% of attacks on players`);
