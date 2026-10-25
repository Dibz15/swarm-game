// 1v1: each bot personality against the human proxy (scripts/proxy.ts), seats swapped.
// Reports the bot's win rate, match length, and opening/power numbers next to the proxy's,
// which are tuned to look like the recorded human (2nd/3rd nest at ~19/36 s).
// Usage: npx vite-node scripts/duel-probe.ts [games per personality] [difficulty] [sizes, e.g. small,medium]
import { CAVES, EVENTS, TERRAIN } from './env';
import { Bot, PERSONALITIES, type Personality } from '../src/sim/ai/bot';
import type { Command } from '../src/sim/commands';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import type { World } from '../src/sim/world';
import { Proxy } from './proxy';

const games = Number(process.argv[2] ?? 8);
const difficulty = Number(process.argv[3] ?? 2);
const sizes = (process.argv[4] ?? 'small,medium').split(',') as MatchSetup['size'][];
const CAP = 10 * 60 * TICK_HZ;
const POWERS = new Set<Command['t']>(['surge', 'nova', 'fortify', 'barrage', 'blink', 'lockdown']);

// Count bot powers.
let botPowers = 0;
const proto = Bot.prototype as unknown as { issue(w: World, c: Command): void };
const realIssue = proto.issue;
proto.issue = function (this: Bot, w: World, c: Command) {
  if (POWERS.has(c.t)) botPowers++;
  realIssue.call(this, w, c);
};

interface Side {
  n2: number[];
  n3: number[];
  peak: number[];
  powersPerMin: number[];
}
const side = (): Side => ({ n2: [], n3: [], peak: [], powersPerMin: [] });
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '-').padStart(5);

console.log(`1v1 vs human proxy, difficulty ${difficulty}, ${games} games per personality per size (${sizes.join(', ')}), terrain ${TERRAIN}, caves ${CAVES}, events ${EVENTS}`);
console.log(`${'personality'.padEnd(12)}  bot win  avg min  |  2nd nest s  3rd nest s  peak army  powers/min  (bot vs proxy)`);
for (const pers of PERSONALITIES as readonly Personality[]) {
  let wins = 0, played = 0, ticks = 0;
  const bot = side(), px = side();
  for (const size of sizes) {
    for (let g = 0; g < games; g++) {
      const proxySeat = g % 2;
      const w = createWorld({
        seed: 9100 + g * 7 + sizes.indexOf(size) * 1000,
        size,
        terrain: TERRAIN,
        caves: CAVES,
        events: EVENTS,
        players: [0, 1].map((i) => (i === proxySeat ? { faction: i, team: i, human: true } : { faction: i, team: i, human: false, bot: { difficulty, personality: pers } })),
      });
      const proxy = new Proxy(proxySeat);
      const botF = 1 - proxySeat;
      const firsts = [[-1, -1], [-1, -1]];
      const peaks = [0, 0];
      let proxyPowers = 0;
      botPowers = 0;
      while (!w.over && w.tick < CAP) {
        const cmds = proxy.think(w);
        for (const c of cmds) if (POWERS.has(c.t)) proxyPowers++;
        step(w, cmds);
        w.fx = [];
        w.deaths = [];
        if (w.tick % TICK_HZ === 0) {
          for (const f of [0, 1]) {
            let k = 0;
            for (const n of w.nests) if (n.owner === f) k++;
            if (k >= 2 && firsts[f][0] < 0) firsts[f][0] = w.tick / TICK_HZ;
            if (k >= 3 && firsts[f][1] < 0) firsts[f][1] = w.tick / TICK_HZ;
            peaks[f] = Math.max(peaks[f], w.unitCount[f]);
          }
        }
      }
      played++;
      ticks += w.tick;
      const botWon = w.over ? w.winnerTeam === w.teamOf[botF] : w.nests.filter((n) => n.owner === botF).length > w.nests.filter((n) => n.owner === proxySeat).length;
      if (botWon) wins++;
      const mins = w.tick / TICK_HZ / 60;
      for (const [s, f, p] of [[bot, botF, botPowers], [px, proxySeat, proxyPowers]] as const) {
        if (firsts[f][0] >= 0) s.n2.push(firsts[f][0]);
        if (firsts[f][1] >= 0) s.n3.push(firsts[f][1]);
        s.peak.push(peaks[f]);
        s.powersPerMin.push(p / mins);
      }
    }
  }
  const pct = ((100 * wins) / played).toFixed(0).padStart(4);
  const len = (ticks / played / TICK_HZ / 60).toFixed(1).padStart(6);
  console.log(
    `${pers.padEnd(12)}  ${pct}%  ${len}   |  ${f1(avg(bot.n2))} ${f1(avg(px.n2))}  ${f1(avg(bot.n3))} ${f1(avg(px.n3))}  ${f1(avg(bot.peak))} ${f1(avg(px.peak))}  ${avg(bot.powersPerMin).toFixed(1).padStart(5)} ${avg(px.powersPerMin).toFixed(1).padStart(5)}`,
  );
}
