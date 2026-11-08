// World snapshots (#155): diff two snapshots, or dump one from a recording.
// Usage:
//   npx vite-node scripts/snapdiff.ts a.snap b.snap [max]     first differing fields (default 20)
//   npx vite-node scripts/snapdiff.ts --dump rec.json <tick> out.snap
//       replay a recording (its first match) to <tick> and write that tick's snapshot
// Exit code 1 when the snapshots differ, so it can gate scripts.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from '../src/sim/commands';
import { createWorld } from '../src/sim/setup';
import { decodeSnap, diffSnaps, hashBytes, serializeWorld } from '../src/sim/snapshot';
import { step } from '../src/sim/step';
import { loadRecordings } from './recordings';

const args = process.argv.slice(2);
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s && s.length > 80 ? s.slice(0, 77) + '...' : s;
};

if (args[0] === '--dump') {
  const [, file, tickArg, out] = args;
  if (!file || !tickArg || !out) {
    console.error('usage: snapdiff.ts --dump rec.json <tick> out.snap');
    process.exit(2);
  }
  const r = loadRecordings([file])[0];
  const at = Number(tickArg);
  const byTick = new Map<number, Command[]>();
  for (const { tick, cmd } of r.log) (byTick.get(tick) ?? byTick.set(tick, []).get(tick)!).push(cmd);
  const w = createWorld(r.setup);
  while (w.tick < at && !w.over) {
    step(w, byTick.get(w.tick + 1) ?? []);
    w.fx = [];
    w.deaths = [];
  }
  const bytes = serializeWorld(w);
  writeFileSync(out, bytes);
  console.log(`tick ${w.tick}: ${bytes.length} bytes, fullHash ${hashBytes(bytes).toString(16)} -> ${out}`);
} else {
  const [fa, fb, maxArg] = args;
  if (!fa || !fb) {
    console.error('usage: snapdiff.ts a.snap b.snap [max]  |  snapdiff.ts --dump rec.json <tick> out.snap');
    process.exit(2);
  }
  const ba = new Uint8Array(readFileSync(fa)), bb = new Uint8Array(readFileSync(fb));
  const d = diffSnaps(decodeSnap(ba), decodeSnap(bb), Number(maxArg ?? 20));
  if (!d.length) {
    console.log(`identical (fullHash ${hashBytes(ba).toString(16)})`);
  } else {
    console.log(`${d.length}${d.length >= Number(maxArg ?? 20) ? '+' : ''} difference(s), earliest fields first:`);
    for (const x of d) console.log(`  ${x.path}: ${show(x.a)}  vs  ${show(x.b)}`);
    process.exit(1);
  }
}
