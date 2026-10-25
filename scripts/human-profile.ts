// How the human plays vs how the bots in the same matches play (#29).
// Usage: npx vite-node scripts/human-profile.ts swarm-recordings-*.json [...]
// Human numbers come from the recorded trace; bot tempo needs a replay, so it is
// only shown for recordings made on the current build.
import type { Command } from '../src/sim/commands';
import { Bot } from '../src/sim/ai/bot';
import { TICK_HZ } from '../src/sim/constants';
import type { World } from '../src/sim/world';
import { STAT_FIELDS, type Recording } from '../src/game/recording';
import { replay } from '../src/game/replay';
import { currentBuild, label, loadRecordings } from './recordings';

const POWERS = new Set<Command['t']>(['surge', 'nova', 'fortify', 'barrage', 'blink', 'lockdown']);
/** an order this close to an alerted nest counts as answering it */
const ANSWER_R = 260;
/** alerts unanswered after this long count as missed */
const ANSWER_MAX = 30;

type Row = Record<string, number>;

// Count bot commands during replays.
let botLog: { tick: number; f: number; cmd: Command }[] | null = null;
const proto = Bot.prototype as unknown as { issue(w: World, c: Command): void };
const realIssue = proto.issue;
proto.issue = function (this: Bot, w: World, c: Command) {
  botLog?.push({ tick: w.tick, f: c.p, cmd: c });
  realIssue.call(this, w, c);
};

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Metrics both humans and bots have: tempo, order mix, group size, expansion, supply. */
function common(r: Recording, f: number, orders: { tick: number; t: Command['t']; units: number }[]): Row {
  const mins = r.end.tick / TICK_HZ / 60;
  const n = orders.length || 1;
  const moves = orders.filter((o) => o.t === 'move');
  let gap = 0;
  for (let k = 1; k < orders.length; k++) gap = Math.max(gap, orders[k].tick - orders[k - 1].tick);
  const row: Row = {
    'orders/min': orders.length / mins,
    'move %': (100 * moves.length) / n,
    'rally %': (100 * orders.filter((o) => o.t === 'rally').length) / n,
    'upgrade %': (100 * orders.filter((o) => o.t === 'upgrade').length) / n,
    'power %': (100 * orders.filter((o) => POWERS.has(o.t)).length) / n,
    'units per move': median(moves.map((o) => o.units)),
    'longest gap s': gap / TICK_HZ,
  };
  const at = (k: number) => 1 + f * STAT_FIELDS + k;
  for (const want of [2, 3, 5]) {
    const hit = r.trace.stats.find((s) => s[at(0)] >= want);
    row[`nest ${want} at s`] = hit ? hit[0] / TICK_HZ : NaN;
  }
  const live = r.trace.stats.filter((s) => s[at(0)] > 0);
  row['supply-capped %'] = live.length ? (100 * live.filter((s) => s[at(1)] >= s[at(2)]).length) / live.length : NaN;
  row['peak units'] = Math.max(0, ...r.trace.stats.map((s) => s[at(1)]));
  return row;
}

/** Human-only: selection habits, input sources, attention. */
function humanOnly(r: Recording, w: World | null): Row {
  const t = r.trace;
  const mins = r.end.tick / TICK_HZ / 60;
  const row: Row = { 'selections/min': t.sel.length / mins };
  for (const m of ['box', 'click', 'paint', 'all', 'type', 'kind', 'group']) row[`sel ${m} %`] = (100 * t.sel.filter((s) => s[1] === m).length) / (t.sel.length || 1);
  for (const s of ['key', 'hud', 'mouse', 'touch']) row[`from ${s} %`] = (100 * t.orders.filter((o) => o[2] === s).length) / (t.orders.length || 1);
  // Camera: how far it moves and how much of the map it shows.
  let jumps = 0;
  for (let k = 1; k < t.cam.length; k++) {
    const [, x0, y0, hw] = t.cam[k - 1];
    const [, x1, y1] = t.cam[k];
    if (Math.abs(x1 - x0) > hw || Math.abs(y1 - y0) > hw) jumps++;
  }
  row['camera jumps/min'] = jumps / mins;
  row['view width % of map'] = w ? (100 * median(t.cam.map((c) => c[3] * 2))) / w.width : NaN;
  // Alerts: was the nest on screen, and how long until an order went near it.
  const onScreen: number[] = [];
  const answer: number[] = [];
  let missed = 0;
  for (const [tick, , x, y] of t.alerts) {
    const cam = t.cam.find((c) => c[0] >= tick);
    if (cam) onScreen.push(Math.abs(cam[1] - x) < cam[3] && Math.abs(cam[2] - y) < cam[4] ? 1 : 0);
    const o = t.orders.find((o) => o[0] >= tick && o[4] >= 0 && (o[4] - x) ** 2 + (o[5] - y) ** 2 < ANSWER_R ** 2);
    const s = o ? (o[0] - tick) / TICK_HZ : Infinity;
    if (s <= ANSWER_MAX) answer.push(s);
    else missed++;
  }
  row['alerts'] = t.alerts.length;
  row['alert on screen %'] = onScreen.length ? (100 * onScreen.reduce((a, b) => a + b, 0)) / onScreen.length : NaN;
  row['alert answer s'] = median(answer);
  row['alerts missed %'] = t.alerts.length ? (100 * missed) / t.alerts.length : NaN;
  row['paused s'] = t.pauses.reduce((a, p) => a + p[1], 0);
  return row;
}

const recs = loadRecordings(process.argv.slice(2));
const here = currentBuild();
const humans = new Map<string, Row[]>();
const bots = new Map<string, Row[]>();
const extra = new Map<string, Row[]>();
const push = (m: Map<string, Row[]>, k: string, r: Row) => {
  for (const key of [k, 'ALL']) m.set(key, [...(m.get(key) ?? []), r]);
};

for (const r of recs) {
  const key = label(r);
  const h = r.trace.orders.map((o) => ({ tick: o[0], t: o[1], units: o[3] }));
  push(humans, key, common(r, r.human, h));
  let w: World | null = null;
  if (r.build === here) {
    botLog = [];
    const out = replay(r);
    w = out.world;
    if (!out.ok) console.warn(`${r.id}: replay diverged on its own build`);
    for (const p of r.setup.players) {
      if (p.human || !p.bot) continue;
      const mine = botLog.filter((b) => b.f === p.faction).map((b) => ({ tick: b.tick, t: b.cmd.t, units: 'units' in b.cmd ? b.cmd.units.length : 0 }));
      push(bots, key, common(r, p.faction, mine));
    }
    botLog = null;
  }
  push(extra, key, humanOnly(r, w));
}

const mean = (rows: Row[], k: string) => {
  const xs = rows.map((r) => r[k]).filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
};
const fmt = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : '-').padStart(8);

const stale = recs.filter((r) => r.build !== here).length;
console.log(`${recs.length} recordings (${stale} from other builds: no bot tempo for those), current build ${here}`);
for (const key of [...humans.keys()].sort((a, b) => (a === 'ALL' ? 1 : b === 'ALL' ? -1 : a.localeCompare(b)))) {
  const hs = humans.get(key)!;
  const bs = bots.get(key) ?? [];
  const results = recs.filter((r) => key === 'ALL' || label(r) === key);
  const wins = results.filter((r) => r.end.reason === 'victory').length;
  console.log(`\n== ${key}: ${hs.length} games, ${wins} won, ${(results.reduce((a, r) => a + r.end.tick, 0) / results.length / TICK_HZ / 60).toFixed(1)} min avg`);
  console.log(`${''.padEnd(22)}${'human'.padStart(8)}${'bots'.padStart(8)}`);
  for (const k of Object.keys(hs[0])) console.log(`${k.padEnd(22)}${fmt(mean(hs, k))}${fmt(mean(bs, k))}`);
  const xs = extra.get(key)!;
  for (const k of Object.keys(xs[0])) console.log(`${k.padEnd(22)}${fmt(mean(xs, k))}`);
}
