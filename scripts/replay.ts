// Re-run recorded matches headlessly and check each lands on its recorded hash.
// Usage: npx vite-node scripts/replay.ts swarm-recordings-2026-10-25.json [...]
// Replays only reproduce on the build that recorded them; others are reported, not failed.
import { replay } from '../src/game/replay';
import { TICK_HZ } from '../src/sim/constants';
import { currentBuild, label, loadRecordings } from './recordings';

const recs = loadRecordings(process.argv.slice(2));
const here = currentBuild();
let bad = 0;
console.log(`${recs.length} recordings, current build ${here}`);
for (const r of recs) {
  const t0 = performance.now();
  const out = replay(r);
  const ms = performance.now() - t0;
  const same = r.build === here;
  const verdict = out.ok ? 'ok' : same ? 'MISMATCH' : `differs (recorded on ${r.build})`;
  if (!out.ok && same) bad++;
  const mins = (r.end.tick / TICK_HZ / 60).toFixed(1);
  console.log(`${r.date.slice(0, 16)}  ${label(r).padEnd(20)} ${r.end.reason.padEnd(8)} ${mins.padStart(5)}m  ${String(r.log.length).padStart(5)} cmds  ${verdict}  (${ms.toFixed(0)} ms)`);
}
if (bad) {
  console.log(`${bad} replay(s) diverged on their own build: the sim is not deterministic (#26)`);
  process.exit(1);
}
