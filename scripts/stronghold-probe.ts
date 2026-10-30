// Stronghold battles (#100), headless: the human proxy against each run's first
// stronghold, fortified and the same node without walls. A sanity probe for #68.
// Usage: [RUSH=1] [SIZE=14] npx vite-node scripts/stronghold-probe.ts [seeds]
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { TICK_HZ } from '../src/sim/constants';
import { Proxy } from '../src/proxy/proxy';
const N = Number(process.argv[2] ?? 8);
/** RUSH=1: the proxy goes for the citadel from the first second (the early cheese) */
const rush = !!process.env.RUSH;
/** SIZE=n: each brood's size (a late run brings bigger ones) */
const SIZE = Number(process.env.SIZE ?? 14);
const rows: string[] = [];
let wins = 0, plainWins = 0, cit = 0;
for (let k = 0; k < N; k++) {
  for (const fort of [true, false]) {
    const run = newRun(`hold-probe-${k}`, 0, 'swarm', 0);
    const w0 = run.warlords![0];
    for (const b of run.broods) b.size = b.cap = SIZE;
    const setup = nodeSetup(run, w0.stronghold, false, run.broods.map((b) => b.id));
    if (!fort) { delete setup.stronghold; for (const p of setup.players) if (p.bot) delete p.bot.citadel; }
    const w = createWorld(setup);
    const proxy = new Proxy(run.color, { skill: 1, citadelBlob: rush ? 1 : undefined });
    while (!w.over && w.tick < 12 * 60 * TICK_HZ) { step(w, proxy.think(w)); w.fx = []; w.deaths = []; }
    const won = w.over && w.winnerTeam === w.teamOf[run.color];
    if (fort) { wins += +won; if (w.winReason === 'citadel') cit++; } else plainWins += +won;
    rows.push(`seed ${k} ${fort ? 'fort ' : 'plain'} d${run.nodes[w0.stronghold].difficulty} r${setup.players.length - 1} ${w0.trait.padEnd(11)} ${won ? 'WIN ' : 'loss'} ${w.winReason || '-'} ${Math.round(w.tick / TICK_HZ)}s`);
  }
}
console.log(rows.join('\n'));
console.log(`fortified ${wins}/${N} (citadel ${cit}), plain ${plainWins}/${N}`);
