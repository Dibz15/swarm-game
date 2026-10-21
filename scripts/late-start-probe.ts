// A bot that does nothing until `wake`, then plays normally (Expander, Normal).
// Compares its finishing place with an identical bot that plays from the start.
import { PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { BALANCE, TICK_HZ } from '../src/sim/constants';

const games = Number(process.argv[2] ?? 40);
const wakeMin = Number(process.argv[3] ?? 2.5);
const base = { ...BALANCE };
const econ: [string, Partial<typeof BALANCE>][] = [
  ['old economy (exp .75, cap 110)', { nestExponent: 0.75, softCap: 110, capPerNest: 0, softScale: 260 }],
  ['new economy (exp .9, cap 30+25/nest)', {}],
];
for (const [name, cfg] of econ) {
  for (const late of [false, true]) {
    Object.assign(BALANCE, base, cfg);
    let placeSum = 0, wins = 0;
    for (let g = 0; g < games; g++) {
      const w = createWorld({
        seed: 8000 + g, size: 'medium',
        players: [0, 1, 2, 3].map((f, i) => ({ faction: f, team: f, human: false, bot: { difficulty: 1, personality: i === 0 ? 'expander' : PERSONALITIES[(i + g) % 4] } })),
      });
      const me = w.bots.find((b) => b.faction === 0)!;
      if (late) {
        const orig = me.update.bind(me);
        me.update = (ww) => { if (ww.tick >= wakeMin * 60 * TICK_HZ) orig(ww); };
      }
      while (!w.over && w.tick < 15 * 60 * TICK_HZ) { step(w, []); w.fx = []; w.deaths = []; }
      const f0 = w.factions[0];
      let place: number;
      if (w.winnerTeam === 0) place = 1;
      else if (f0.eliminated) place = 1 + [1, 2, 3].filter((f) => !w.factions[f].eliminated || w.factions[f].eliminatedTick > f0.eliminatedTick).length;
      else place = 2;
      placeSum += place;
      if (place === 1) wins++;
    }
    console.log(`${name.padEnd(36)} ${late ? `idle until ${wakeMin}m` : 'plays from start '}  wins ${String(wins).padStart(2)}/${games}  avg place ${(placeSum / games).toFixed(2)}`);
  }
}
