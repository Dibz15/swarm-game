// Team domination (#213): when would each share rule end a team match, and how
// decided is the match by then? Plays bot matches with domination off, samples
// each team's nest share every second, then replays the samples against each
// rule: a rule fires once a team holds its need for DOMINATION.ticks.
// Bots react to a team that is dominating, so this is an approximation; LIVE=1
// plays the match with the shipped rule instead and reports how it really ended.
// Usage: npx vite-node scripts/team-dom-probe.ts [splits] [size] [games]
//   e.g. npx vite-node scripts/team-dom-probe.ts 2v2,3v2,4v2,5v1,2v1,2v2v2,2v2v1 medium 12
import { CAVES, EVENTS, LAYOUT, TERRAIN } from './env';
import { PERSONALITIES } from '../src/sim/ai/bot';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { DOMINATION, NEUTRAL, TICK_HZ } from '../src/sim/constants';
import type { MapSize } from '../src/sim/mapgen';

const splits = (process.argv[2] ?? '2v2,3v2,4v2,5v1,2v1,2v2v2,2v2v1').split(',');
const size = (process.argv[3] ?? 'medium') as MapSize;
const games = Number(process.argv[4] ?? 10);
const live = process.env.LIVE === '1';
const MINUTES = Number(process.env.MINUTES ?? 30);

type Rule = { name: string; share: (fair: number) => number };
const flat = DOMINATION.share[size] ?? 0.7;
const RULES: Rule[] = [
  { name: `flat ${flat}`, share: () => flat },
  ...[0.5, 0.6, 0.7].map((t) => ({ name: `take ${t}`, share: (fair: number) => fair + t * (1 - fair) })),
];

function setupOf(split: string, seed: number): MatchSetup {
  const sizes = split.split('v').map(Number);
  const players: MatchSetup['players'] = [];
  sizes.forEach((k, team) => {
    for (let i = 0; i < k; i++) {
      const f = players.length;
      players.push({ faction: f, team, human: false, bot: { difficulty: 2, personality: PERSONALITIES[(seed + f) % PERSONALITIES.length] } });
    }
  });
  return { seed, size, terrain: TERRAIN, events: EVENTS, caves: CAVES, layout: LAYOUT === 'random' ? undefined : LAYOUT, players, domShare: live ? undefined : 2 };
}

interface Game {
  sizes: number[];
  /** per second, each team's share of the nests */
  shares: number[][];
  /** per second, each team's live players */
  alive: number[][];
  winner: number;
  reason: string;
  end: number;
}

function play(split: string, seed: number): Game {
  const s = setupOf(split, seed);
  const w = createWorld(s);
  const sizes = split.split('v').map(Number);
  const shares: number[][] = [], alive: number[][] = [];
  while (!w.over && w.tick < MINUTES * 60 * TICK_HZ) {
    step(w, []);
    w.fx = [];
    w.deaths = [];
    if (w.tick % TICK_HZ === 0) {
      const held = sizes.map(() => 0), up = sizes.map(() => 0);
      for (const n of w.nests) if (n.owner >= 0 && n.owner !== NEUTRAL) held[w.teamOf[n.owner]]++;
      for (const p of s.players) if (!w.factions[p.faction].eliminated) up[p.team]++;
      shares.push(held.map((h) => h / w.nests.length));
      alive.push(up);
    }
  }
  return { sizes, shares, alive, winner: w.over ? w.winnerTeam : -1, reason: w.over ? w.winReason : 'timeout', end: w.tick / TICK_HZ };
}

/** When the rule would end the game: [second, team], or null. */
function fires(g: Game, rule: Rule, nests: number): [number, number] | null {
  const total = g.sizes.reduce((a, b) => a + b, 0);
  const team = g.sizes.some((k) => k > 1);
  const need = g.sizes.map((k) => (team ? rule.share(k / total) : flat));
  const run = g.sizes.map(() => 0);
  const hold = DOMINATION.ticks / TICK_HZ;
  for (let t = 0; t < g.shares.length; t++) {
    for (let k = 0; k < g.sizes.length; k++) {
      if (g.alive[t][k] === 0) continue;
      const enough = g.shares[t][k] * nests >= Math.ceil(nests * need[k]) - 1e-9;
      run[k] = enough ? run[k] + 1 : 0;
      if (run[k] >= hold) return [t + 1, k];
    }
  }
  return null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mins = (s: number) => `${(s / 60).toFixed(1)}m`;
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

for (const split of splits) {
  const sizes = split.split('v').map(Number);
  const total = sizes.reduce((a, b) => a + b, 0);
  const results: Game[] = [];
  const nestCounts: number[] = [];
  for (let g = 0; g < games; g++) {
    const seed = 1000 + g * 7;
    const r = play(split, seed);
    results.push(r);
    nestCounts.push(createWorld(setupOf(split, seed)).nests.length);
  }
  console.log(`\n=== ${split} on ${size}: ${games} games, ${avg(nestCounts).toFixed(0)} nests on average${live ? ' (LIVE, shipped rule)' : ''}`);
  const wins = sizes.map((_, k) => results.filter((r) => r.winner === k).length);
  console.log(`  played out: wins by team ${wins.join(' / ')}, timeouts ${results.filter((r) => r.winner < 0).length}; ` +
    `elimination at ${mins(avg(results.filter((r) => r.reason === 'elimination').map((r) => r.end)))}` +
    (live ? `, domination ${results.filter((r) => r.reason === 'domination').length} at ${mins(avg(results.filter((r) => r.reason === 'domination').map((r) => r.end)))}` : ''));
  if (live) {
    for (const r of results) console.log(`    team ${r.winner} by ${r.reason} at ${mins(r.end)}; teams alive at end ${r.alive.at(-1)!.join('/')}`);
    continue;
  }
  for (const rule of RULES) {
    const team = sizes.some((k) => k > 1);
    const needs = sizes.map((k) => (team ? rule.share(k / total) : flat));
    let n = 0, sooner: number[] = [], beaten: number[] = [], survivors: number[] = [], upset = 0;
    for (let g = 0; g < games; g++) {
      const r = results[g];
      const f = fires(r, rule, nestCounts[g]);
      if (!f) continue;
      n++;
      const [t, k] = f;
      if (r.winner >= 0 && r.winner !== k) upset++;
      sooner.push(r.end - t);
      // the losers' players still alive, and their share against their start
      let up = 0, start = 0, now = 0;
      sizes.forEach((sz, j) => {
        if (j === k) return;
        up += r.alive[t - 1][j];
        start += sz / total;
        now += r.shares[t - 1][j];
      });
      survivors.push(up);
      beaten.push(1 - now / start);
    }
    console.log(`  ${rule.name.padEnd(9)} need ${needs.map(pct).join(' / ').padEnd(18)} fires ${n}/${games}, ${mins(avg(sooner))} before the end, ` +
      `rival players alive ${avg(survivors).toFixed(1)}, rivals' land lost ${pct(avg(beaten))}${upset ? `, ${upset} UPSET` : ''}`);
  }
}
