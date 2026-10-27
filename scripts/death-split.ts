// Kill/loss and where units died, human vs bots, from recordings (#29, #37).
// Replays need the build that recorded them (see scripts/replay.ts); run this
// in a worktree of that build. Recordings that don't reproduce are skipped.
// Usage: npx vite-node scripts/death-split.ts recordings/*.json
import type { Command } from '../src/sim/commands';
import { TICK_HZ } from '../src/sim/constants';
import { worldHash } from '../src/sim/hash';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { SITES, countDeaths, share, tally, type DeathTally } from './deaths';
import { label, loadRecordings } from './recordings';

const recs = loadRecordings(process.argv.slice(2));
const human = tally(), bots = tally();
let hk = 0, hl = 0, bk = 0, bl = 0, used = 0;
const rows: string[] = [];
for (const r of recs) {
  const w = createWorld(r.setup);
  const byTick = new Map<number, Command[]>();
  for (const { tick, cmd } of r.log) byTick.set(tick, [...(byTick.get(tick) ?? []), cmd]);
  const h = tally(), b = tally();
  while (w.tick < r.end.tick && !w.over) {
    step(w, byTick.get(w.tick + 1) ?? []);
    countDeaths(w, (o) => (o === r.human ? h : w.factions[o]?.active ? b : null));
    w.fx = [];
    w.deaths = [];
  }
  if (worldHash(w) !== r.end.hash) continue;
  used++;
  const me = w.factions[r.human].stats;
  let k = 0, l = 0;
  for (const [f, fa] of w.factions.entries()) if (f !== r.human && fa.active) (k += fa.stats.kills), (l += fa.stats.lost);
  hk += me.kills;
  hl += me.lost;
  bk += k;
  bl += l;
  for (const s of SITES) (human[s] += h[s]), (bots[s] += b[s]);
  const opp = r.setup.players.filter((p) => !p.human).map((p) => `${p.bot?.personality ?? '?'}:${p.bot?.difficulty ?? '?'}`).join(',');
  rows.push(
    `${r.date.slice(0, 16)} ${label(r).padEnd(18)} ${opp.padEnd(28)} ${(r.end.tick / TICK_HZ / 60).toFixed(1).padStart(4)}m  K/L ${(me.kills / Math.max(1, me.lost)).toFixed(2)}  human ${fmt(h)} | bots ${fmt(b)}`,
  );
}
function fmt(t: DeathTally): string {
  return SITES.map((s) => String(t[s]).padStart(4)).join('');
}
console.log(`${used} of ${recs.length} recordings reproduce on this build. Deaths: ${SITES.join(' / ')}`);
for (const row of rows) console.log(row);
console.log(`\nhuman K/L ${(hk / Math.max(1, hl)).toFixed(2)} (${hk}/${hl})   bots K/L ${(bk / Math.max(1, bl)).toFixed(2)} (${bk}/${bl})`);
console.log(`human died: ${share(human)}   (${JSON.stringify(human)})`);
console.log(`bots died:  ${share(bots)}   (${JSON.stringify(bots)})`);
