// Desync reports (#165): replay a report bundle downloaded from a match and
// say whose world left the true course, when, and in which fields.
// Usage:
//   npx vite-node scripts/desync.ts swarm-desync-<tick>.json
//   npx vite-node scripts/desync.ts bundle.json --dump <seat> out.snap   that seat's world at the desync tick
// The host's bundle holds the whole match; a guest's only what that guest saw.
// Exit code 1 when any seat diverged.
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeBundle, unb64, type DesyncBundle } from '../src/net/desync';
import { currentBuild } from './recordings';

const [file, flag, seatArg, out] = process.argv.slice(2);
if (!file) {
  console.error('usage: desync.ts bundle.json [--dump <seat> out.snap]');
  process.exit(2);
}
const b = JSON.parse(readFileSync(file, 'utf8')) as DesyncBundle;
if (b.swarmDesync !== 1) {
  console.error(`${file}: not a desync report`);
  process.exit(2);
}

if (flag === '--dump') {
  const snap = b.snaps[Number(seatArg)];
  if (!snap || !out) {
    console.error(`no world for seat ${seatArg} in this report (have: ${Object.keys(b.snaps).join(', ') || 'none'})`);
    process.exit(2);
  }
  writeFileSync(out, unb64(snap));
  console.log(`seat ${seatArg}'s world at tick ${b.tick} -> ${out}`);
  process.exit(0);
}

const build = currentBuild();
console.log(`desync at tick ${b.tick} (${(b.tick / 30).toFixed(1)} s), reported by seat ${b.seat}${b.host ? ' (host)' : ''} on ${b.date}`);
console.log(`  ${b.env.ua}`);
if (b.build !== build) console.log(`  warning: the report is from build ${b.build}; this checkout is ${build}. A replay only reproduces on the same build.`);
console.log(`  hashes at ${b.tick}: ${Object.entries(b.hashes).map(([s, h]) => `seat ${s} ${(h >>> 0).toString(16)}`).join(', ')}`);
for (const [seat, diffs] of Object.entries(b.diffs)) {
  if (diffs.length) console.log(`  the host saw seat ${seat} differ in: ${diffs.map((d) => d.path).join(', ')}`);
}

const r = analyzeBundle(b);
if (r.partial) {
  console.log(`\nThis is a guest's report: it holds the turns from ${b.turns.first} on, not the whole match, so it can't be replayed. Use the host's.`);
  process.exit(0);
}
console.log(`\nreplayed ${b.turns.list.length} turns:`);
let diverged = false;
for (const f of r.findings) {
  if (f.divergedAt === null) console.log(`  seat ${f.seat}: matches the replay`);
  else {
    diverged = true;
    console.log(`  seat ${f.seat}: diverges at tick ${f.divergedAt} (${(f.divergedAt / 30).toFixed(1)} s)`);
  }
  if (f.paths.length) console.log(`    its world at ${b.tick} differs in: ${f.paths.join(', ')}`);
}
process.exit(diverged ? 1 : 0);
