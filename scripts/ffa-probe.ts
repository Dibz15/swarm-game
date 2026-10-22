// Why do FFAs collapse to two players? Logs who bots attack (by victim size
// rank), who actually takes nests from whom, and when each player drops out.
// Usage: npx vite-node scripts/ffa-probe.ts [players] [size] [games]
import { TERRAIN } from './env';
import { Bot, PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import type { Command } from '../src/sim/commands';
import type { World } from '../src/sim/world';

const players = Number(process.argv[2] ?? 4);
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 20);

/** rank of f among alive players by unit count: 1 = biggest */
function rank(w: World, f: number): number {
  let r = 1;
  for (let o = 0; o < players; o++) {
    if (o !== f && !w.factions[o].eliminated && w.unitCount[o] > w.unitCount[f]) r++;
  }
  return r;
}
function aliveCount(w: World) {
  return w.factions.slice(0, players).filter((f) => !f.eliminated).length;
}

const sentByRank = new Array(players + 1).fill(0); // dots ordered at enemy nests, by victim rank
let sentNeutral = 0;
const takenByRank = new Array(players + 1).fill(0); // enemy nests neutralized, by victim rank
const attackersOnVictim: number[] = []; // distinct attackers in victim's last 60s
const knockTimes: number[][] = [];
let current: World;

const origIssue = (Bot.prototype as any).issue;
(Bot.prototype as any).issue = function (w: World, c: Command) {
  if (c.t === 'move' && c.nest >= 0) {
    const n = w.nests[c.nest];
    if (n.owner === NEUTRAL || n.owner < 0) sentNeutral += c.units.length;
    else if (w.teamOf[n.owner] !== w.teamOf[c.p] && n.owner < players) sentByRank[rank(w, n.owner)] += c.units.length;
  }
  return origIssue.call(this, w, c);
};

for (let g = 0; g < games; g++) {
  const w = (current = createWorld({ terrain: TERRAIN, 
    seed: 3000 + g,
    size,
    players: Array.from({ length: players }, (_, i) => ({
      faction: i, team: i, human: false,
      bot: { difficulty: 1, personality: PERSONALITIES[(i + g) % 4] },
    })),
  }));
  const hits: { t: number; from: number; to: number }[] = [];
  const knocks: number[] = [];
  let lastAlive = players;
  while (!w.over && w.tick < 15 * 60 * TICK_HZ) {
    // ranks must be taken before the step mutates counts
    const ranks = Array.from({ length: players }, (_, f) => rank(w, f));
    step(w, []);
    for (const e of w.fx) {
      if (e.type === 'neutralize' && e.prev >= 0 && e.prev < players) {
        takenByRank[ranks[e.prev]]++;
        hits.push({ t: w.tick, from: e.f, to: e.prev });
      }
      if (e.type === 'eliminated') {
        const recent = new Set(hits.filter((h) => h.to === e.f && h.t > w.tick - 60 * TICK_HZ).map((h) => h.from));
        attackersOnVictim.push(recent.size);
      }
    }
    w.fx = [];
    w.deaths = [];
    const a = aliveCount(w);
    if (a < lastAlive) {
      for (let k = a; k < lastAlive; k++) knocks.push(w.tick / TICK_HZ / 60);
      lastAlive = a;
    }
  }
  knockTimes.push(knocks);
}

const pct = (arr: number[]) => {
  const t = arr.reduce((s, v) => s + v, 0) || 1;
  return arr.slice(1).map((v, i) => `#${i + 1}:${((v / t) * 100).toFixed(0)}%`).join(' ');
};
const avgK = (k: number) => {
  const v = knockTimes.map((ks) => ks[k]).filter((x) => x !== undefined);
  return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) + 'm' : '-';
};
console.log(`${players}p ${size}, ${games} games`);
console.log(`dots ordered vs enemy nests, by victim's size rank (1=biggest): ${pct(sentByRank)}  | vs neutral: ${sentNeutral}, vs enemies: ${sentByRank.reduce((a, b) => a + b, 0)}`);
console.log(`enemy nests actually taken, by victim rank: ${pct(takenByRank)}`);
console.log(`knockout times: ${Array.from({ length: players - 1 }, (_, k) => `${k + 1}st out ${avgK(k)}`).join(', ')}`);
const multi = attackersOnVictim.filter((n) => n >= 2).length;
console.log(`eliminated players hit by 2+ attackers in their last minute: ${multi}/${attackersOnVictim.length}`);
