// Hold the line (#67), headless: the human proxy holds each run's first hold
// node, or (IDLE=1) nobody gives an order at all, which should lose. A sanity
// probe for #68. Usage: [IDLE=1] [MILITIA=1] [SIZE=14] npx vite-node scripts/siege-probe.ts [seeds]
import { nodeSetup } from '../src/campaign/battle';
import { newRun } from '../src/campaign/run';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { TICK_HZ } from '../src/sim/constants';
import { Proxy } from '../src/proxy/proxy';
const N = Number(process.argv[2] ?? 8);
const militia = !!process.env.MILITIA;
const idle = !!process.env.IDLE;
const SIZE = Number(process.env.SIZE ?? 14);
let held = 0, n = 0;
for (let k = 0; n < N && k < N * 4; k++) {
  const run = newRun(`siege-probe-${k}`, 0, 'swarm', 0);
  const node = run.nodes.find((x) => x.kind === 'hold');
  if (!node) continue;
  n++;
  for (const b of run.broods) b.size = b.cap = SIZE;
  // Militia: no broods at all, just the militia's handful.
  if (militia) run.broods = [];
  const setup = nodeSetup(run, node.id, false, run.broods.map((b) => b.id));
  const w = createWorld(setup);
  const proxy = new Proxy(run.color, { skill: 1 });
  while (!w.over && w.tick < 8 * 60 * TICK_HZ) {
    step(w, idle ? [] : proxy.think(w));
    w.fx = [];
    w.deaths = [];
  }
  const won = w.winReason === 'held';
  held += +won;
  const sg = w.siege!;
  const bloom = sg.bloomNests.filter((id) => w.nests[id].owner === 6).length;
  console.log(`run ${k} depth ${node.depth} ${setup.siege!.seconds}s: ${won ? 'HELD' : 'lost'} (${w.winReason || '-'}) at ${Math.round(w.tick / TICK_HZ)}s, waves ${sg.next}/${sg.waves.length}, bloom nests ${bloom}/${sg.bloomNests.length}, boons ${sg.boons.join(',')}`);
}
console.log(`${held}/${n} held${militia ? ' (militia only)' : ''}${idle ? ' (idle)' : ''}`);
