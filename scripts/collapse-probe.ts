// Trace how the first-eliminated player loses: where its dots die, its army
// and nest curve, and personalities of early losers vs winners.
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import { UNIT_FEEDING } from '../src/sim/world';

const players = Number(process.argv[2] ?? 4);
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const games = Number(process.argv[4] ?? 20);

type Loss = { neutral: number; enemy: number; turret: number; other: number };
const firstOutPers: Record<string, number> = {};
const winnerPers: Record<string, number> = {};
const lossFirst: Loss = { neutral: 0, enemy: 0, turret: 0, other: 0 };
const lossOthers: Loss = { neutral: 0, enemy: 0, turret: 0, other: 0 };
const curves: string[] = [];
let spawnFirst = 0, spawnOthers = 0, nOthers = 0;

for (let g = 0; g < games; g++) {
  const pers = Array.from({ length: players }, (_, i) => PERSONALITIES[(i + g) % 4]);
  const w = createWorld({ terrain: TERRAIN, caves: CAVES, layout: LAYOUT, events: EVENTS, 
    seed: 3000 + g, size,
    players: pers.map((p, i) => ({ faction: i, team: i, human: false, bot: { difficulty: 1, personality: p } })),
  });
  const loss: Loss[] = Array.from({ length: players }, () => ({ neutral: 0, enemy: 0, turret: 0, other: 0 }));
  const hist: string[][] = Array.from({ length: players }, () => []);
  const wasAlive = new Uint8Array(w.alive.length);
  const wasUid = new Uint32Array(w.alive.length);
  const wasOwner = new Uint8Array(w.alive.length);
  let firstOut = -1;
  while (!w.over && w.tick < 12 * 60 * TICK_HZ) {
    for (let i = 0; i < w.n; i++) {
      wasAlive[i] = w.alive[i];
      wasUid[i] = w.uid[i];
      wasOwner[i] = w.owner[i];
    }
    const feeding = new Set<number>();
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.state[i] === UNIT_FEEDING) feeding.add(w.uid[i]);
    step(w, []);
    for (let i = 0; i < w.n; i++) {
      if (!wasAlive[i] || (w.alive[i] && w.uid[i] === wasUid[i])) continue;
      const o = wasOwner[i];
      if (o >= players) continue;
      if (feeding.has(wasUid[i])) continue; // upgrade, not a loss
      const k = w.lastHit[i];
      // turret kills set lastHit to the nest owner too; approximate by checking beams from nests
      let byTurret = false;
      for (let b = 0; b < w.beamCount; b++) if (w.beams[b * 2] < 0 && w.beams[b * 2 + 1] === i) byTurret = true;
      if (byTurret) loss[o].turret++;
      else if (k === NEUTRAL) loss[o].neutral++;
      else if (k >= 0 && k !== o) loss[o].enemy++;
      else loss[o].other++;
    }
    if (firstOut < 0) firstOut = w.factions.slice(0, players).findIndex((f) => f.eliminated);
    if (w.tick % (30 * TICK_HZ) === 0) {
      for (let f = 0; f < players; f++) hist[f].push(`${w.unitCount[f]}/${w.nests.filter((n) => n.owner === f).length}`);
    }
    w.fx = [];
    w.deaths = [];
  }
  if (firstOut < 0) continue;
  firstOutPers[pers[firstOut]] = (firstOutPers[pers[firstOut]] ?? 0) + 1;
  for (let f = 0; f < players; f++) if (w.teamOf[f] === w.winnerTeam) winnerPers[pers[f]] = (winnerPers[pers[f]] ?? 0) + 1;
  for (let f = 0; f < players; f++) {
    const tgt = f === firstOut ? lossFirst : lossOthers;
    for (const k of ['neutral', 'enemy', 'turret', 'other'] as const) tgt[k] += loss[f][k];
    if (f === firstOut) spawnFirst += w.factions[f].stats.spawned;
    else { spawnOthers += w.factions[f].stats.spawned; nOthers++; }
  }
  if (g < 6) {
    curves.push(`seed ${3000 + g} (units/nests every 30s)\n` + pers.map((p, f) => `  ${f === firstOut ? '*' : ' '}${p.padEnd(11)} ${hist[f].join(' ')}`).join('\n'));
  }
}
const fmt = (l: Loss) => {
  const t = l.neutral + l.enemy + l.turret + l.other || 1;
  return `neutral guards ${((l.neutral / t) * 100).toFixed(0)}%, enemies ${((l.enemy / t) * 100).toFixed(0)}%, turrets ${((l.turret / t) * 100).toFixed(0)}%, other ${((l.other / t) * 100).toFixed(0)}%`;
};
console.log(curves.join('\n'));
console.log('first out by personality:', firstOutPers, '| winners:', winnerPers);
console.log('losses of first-out player:', fmt(lossFirst));
console.log('losses of the others:      ', fmt(lossOthers));
console.log(`spawned: first-out avg ${(spawnFirst / games).toFixed(0)}, others avg ${(spawnOthers / Math.max(1, nOthers)).toFixed(0)}`);
