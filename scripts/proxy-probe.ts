// The human proxy (src/proxy/proxy.ts) against bots, measured like the recordings (#29, #37):
// win rate, K/L, where each side dies, nest timing, tempo, group size, powers and upgrades.
// Usage: npx vite-node scripts/proxy-probe.ts [duel|ffa] [games] [difficulty] [skill]
//   duel: 1v1 against each personality on small and medium maps, seats swapped
//   ffa:  4 players on medium maps, the proxy against three random personalities
// Knob overrides: PROXY='{"react":4}'
import { CAVES, EVENTS, TERRAIN } from './env';
import { PERSONALITIES, type Personality } from '../src/sim/ai/bot';
import type { Command } from '../src/sim/commands';
import { TICK_HZ } from '../src/sim/constants';
import { Rng } from '../src/sim/rng';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Proxy, type ProxyKnobs } from '../src/proxy/proxy';
import { countDeaths, share, tally, type DeathTally } from './deaths';

const mode = (process.argv[2] ?? 'duel') as 'duel' | 'ffa';
const games = Number(process.argv[3] ?? 6);
const difficulty = Number(process.argv[4] ?? 2);
const skill = Number(process.argv[5] ?? 1);
const knobs: Partial<ProxyKnobs> = process.env.PROXY ? JSON.parse(process.env.PROXY) : {};
const CAP = 12 * 60 * TICK_HZ;

interface Stats {
  played: number;
  won: number;
  place: number[];
  minutes: number[];
  kills: number;
  lost: number;
  n2: number[];
  n3: number[];
  peak: number[];
  orders: number;
  rallies: number;
  moves: number;
  moveUnits: number;
  powers: number;
  upgrades: number;
  died: DeathTally;
  botDied: DeathTally;
}
const stats = (): Stats => ({ played: 0, won: 0, place: [], minutes: [], kills: 0, lost: 0, n2: [], n3: [], peak: [], orders: 0, rallies: 0, moves: 0, moveUnits: 0, powers: 0, upgrades: 0, died: tally(), botDied: tally() });
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const POWERS = new Set<Command['t']>(['surge', 'nova', 'fortify', 'barrage', 'blink', 'lockdown']);

function play(setup: MatchSetup, seat: number, s: Stats): void {
  const w = createWorld(setup);
  const proxy = new Proxy(seat, { skill, knobs });
  const first = [-1, -1];
  let peak = 0;
  // Elimination order, for placement in FFAs.
  const out: number[] = [];
  while (!w.over && w.tick < CAP) {
    const cmds = proxy.think(w);
    for (const c of cmds) {
      s.orders++;
      if (c.t === 'move') (s.moves++, (s.moveUnits += c.units.length));
      if (c.t === 'rally') s.rallies++;
      if (POWERS.has(c.t)) s.powers++;
      if (c.t === 'upgrade') s.upgrades++;
    }
    step(w, cmds);
    countDeaths(w, (o) => (o === seat ? s.died : w.factions[o]?.active ? s.botDied : null));
    w.fx = [];
    w.deaths = [];
    if (w.tick % TICK_HZ === 0) {
      let k = 0;
      for (const n of w.nests) if (n.owner === seat) k++;
      if (k >= 2 && first[0] < 0) first[0] = w.tick / TICK_HZ;
      if (k >= 3 && first[1] < 0) first[1] = w.tick / TICK_HZ;
      peak = Math.max(peak, w.unitCount[seat]);
      for (const p of setup.players) if (w.factions[p.faction].eliminated && !out.includes(p.faction)) out.push(p.faction);
    }
  }
  s.played++;
  const team = w.teamOf[seat];
  const held = (f: number) => w.nests.filter((n) => n.owner === f).length;
  const won = w.over ? w.winnerTeam === team : setup.players.every((p) => p.faction === seat || held(seat) > held(p.faction));
  if (won) s.won++;
  const alive = setup.players.map((p) => p.faction).filter((f) => !out.includes(f));
  const ranked = [...alive.sort((a, b) => (a === seat ? -1 : b === seat ? 1 : held(b) - held(a))), ...out.reverse()];
  s.place.push(won ? 1 : ranked.indexOf(seat) + 1 + (alive.includes(seat) ? 1 : 0));
  s.minutes.push(w.tick / TICK_HZ / 60);
  s.kills += w.factions[seat].stats.kills;
  s.lost += w.factions[seat].stats.lost;
  if (first[0] >= 0) s.n2.push(first[0]);
  if (first[1] >= 0) s.n3.push(first[1]);
  s.peak.push(peak);
}

function report(name: string, s: Stats): void {
  const mins = s.minutes.reduce((a, b) => a + b, 0);
  console.log(
    [
      name.padEnd(12),
      `win ${((100 * s.won) / s.played).toFixed(0).padStart(3)}%`,
      mode === 'ffa' ? `place ${avg(s.place).toFixed(1)}` : '',
      `${avg(s.minutes).toFixed(1).padStart(4)}m`,
      `K/L ${(s.kills / Math.max(1, s.lost)).toFixed(2)}`,
      `nest2/3 ${avg(s.n2).toFixed(0)}/${avg(s.n3).toFixed(0)}s`,
      `peak ${avg(s.peak).toFixed(0).padStart(3)}`,
      `orders/min ${(s.orders / mins).toFixed(1)} (move ${pct(s.moves, s.orders)} rally ${pct(s.rallies, s.orders)} power ${pct(s.powers, s.orders)} upg ${pct(s.upgrades, s.orders)})`,
      `dots/move ${(s.moveUnits / Math.max(1, s.moves)).toFixed(0)}`,
      `powers/min ${(s.powers / mins).toFixed(1)}`,
      `upg/min ${(s.upgrades / mins).toFixed(1)}`,
    ]
      .filter(Boolean)
      .join('  '),
  );
  console.log(`${''.padEnd(12)}  proxy died: ${share(s.died)}`);
  console.log(`${''.padEnd(12)}  bots died:  ${share(s.botDied)}`);
}

console.log(`${mode}, difficulty ${difficulty}, skill ${skill}, ${games} games per row, terrain ${TERRAIN}, caves ${CAVES}, events ${EVENTS}${Object.keys(knobs).length ? `, knobs ${JSON.stringify(knobs)}` : ''}`);
const all = stats();
const merge = (s: Stats) => {
  for (const k of Object.keys(all) as (keyof Stats)[]) {
    const v = s[k];
    if (typeof v === 'number') (all[k] as number) += v;
    else if (Array.isArray(v)) (all[k] as number[]).push(...v);
    else for (const site of Object.keys(v) as (keyof DeathTally)[]) (all[k] as DeathTally)[site] += v[site];
  }
};
if (mode === 'duel') {
  for (const pers of PERSONALITIES as readonly Personality[]) {
    const s = stats();
    for (const [si, size] of (['small', 'medium'] as const).entries()) {
      for (let g = 0; g < games; g++) {
        const seat = g % 2;
        play(
          {
            seed: 9100 + g * 7 + si * 1000,
            size,
            terrain: TERRAIN,
            caves: CAVES,
            events: EVENTS,
            players: [0, 1].map((i) => (i === seat ? { faction: i, team: i, human: true } : { faction: i, team: i, human: false, bot: { difficulty, personality: pers } })),
          },
          seat,
          s,
        );
      }
    }
    report(pers, s);
    merge(s);
  }
} else {
  const s = all;
  for (let g = 0; g < games; g++) {
    const rng = new Rng(4400 + g);
    const seat = g % 4;
    play(
      {
        seed: 4400 + g * 13,
        size: 'medium',
        terrain: TERRAIN,
        caves: CAVES,
        events: EVENTS,
        players: [0, 1, 2, 3].map((i) => (i === seat ? { faction: i, team: i, human: true } : { faction: i, team: i, human: false, bot: { difficulty, personality: rng.pick(PERSONALITIES) } })),
      },
      seat,
      s,
    );
  }
}
report('ALL', all);
