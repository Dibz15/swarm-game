// How well does a player who never issues a command do against bots?
// Runs the same games with individual anti-snowball rules switched off.
// Usage: npx vite-node scripts/idle-probe.ts [games] [size] [bots]
import { PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { BALANCE, CAPITAL, TICK_HZ } from '../src/sim/constants';

const games = Number(process.argv[2] ?? 40);
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const bots = Number(process.argv[4] ?? 3);
const base = { ...BALANCE };
const baseCap = { ...CAPITAL };

const variants: [string, () => void][] = [
  ['current', () => {}],
  ['linear nests (exp 1.0)', () => (BALANCE.nestExponent = 1)],
  ['no soft cap', () => (BALANCE.softCap = 1e9)],
  ['no home armor', () => (BALANCE.homeArmor = 1)],
  ['no capital defense', () => { CAPITAL.armor = 1; CAPITAL.dps = 0; }],
  ['no underdog energy', () => (BALANCE.underdogEnergy = 0)],
];

for (const [name, apply] of variants) {
  Object.assign(BALANCE, base);
  Object.assign(CAPITAL, baseCap);
  apply();
  const places: number[] = [];
  let wins = 0, minutes = 0;
  for (let g = 0; g < games; g++) {
    const w = createWorld({
      seed: 7000 + g, size,
      players: [
        { faction: 0, team: 0, human: true },
        ...Array.from({ length: bots }, (_, i) => ({ faction: i + 1, team: i + 1, human: false, bot: { difficulty: 1, personality: PERSONALITIES[(i + g) % 4] } })),
      ],
    });
    while (!w.over && !w.factions[0].eliminated && w.tick < 15 * 60 * TICK_HZ) {
      step(w, []);
      w.fx = []; w.deaths = [];
    }
    minutes += w.tick / TICK_HZ / 60;
    // place: 1 + players still alive (or winner) when the idle player went out
    let place = 1;
    if (w.factions[0].eliminated) place = 1 + w.factions.slice(0, bots + 1).filter((f, i) => i > 0 && (!f.eliminated || f.eliminatedTick > w.factions[0].eliminatedTick)).length;
    else if (w.over && w.winnerTeam !== 0) place = 2;
    else if (!w.over) {
      const nests = (f: number) => w.nests.filter((n) => n.owner === f).length;
      place = 1 + [1, 2, 3].slice(0, bots).filter((f) => !w.factions[f].eliminated && nests(f) > nests(0)).length;
    }
    if (place === 1) wins++;
    places.push(place);
  }
  const avg = places.reduce((a, b) => a + b, 0) / games;
  const dist = [1, 2, 3, 4].slice(0, bots + 1).map((p) => `${p}:${places.filter((x) => x === p).length}`).join(' ');
  console.log(`${name.padEnd(24)} idle player avg place ${avg.toFixed(2)} (wins ${wins}/${games}; ${dist}) avg ${(minutes / games).toFixed(1)} min`);
}
