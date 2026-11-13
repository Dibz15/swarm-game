// Net-sim probe (#160): whole networked matches on a virtual clock, swept
// over link quality. One host (its own client at 0 ms) and one friend; the
// friend's link varies. Prints order-to-effect latency, buffer and stalls
// for co-op and PvP, and whether every hash matched.
//   npx vite-node scripts/netsim.ts [secs=120]
//   npx vite-node scripts/netsim.ts --only=300 [secs]   (just the 300 ms rows)
//   npx vite-node scripts/netsim.ts --seq='{"dMin":2}' --net='{"marginMs":33}'   (other settings, #198)
import { runNetMatch, type NetMatchReport } from '../src/net/harness';
import type { MatchSetup } from '../src/sim/setup';

const args = process.argv.slice(2);
const secs = Number(args.find((a) => !a.startsWith('--')) ?? 120);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const json = (flag: string) => {
  const v = args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  return v ? JSON.parse(v) : undefined;
};
const seqOpts = json('seq');
const netOpts = json('net');
if (!(secs > 0)) throw new Error(`netsim: bad match length ${secs}`);

function setup(pvp: boolean, seed: number): MatchSetup {
  return {
    seed,
    size: 'small',
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: pvp ? 1 : 0, human: true },
      { faction: 2, team: 12, human: false, bot: { difficulty: 1, personality: 'expander' } },
      { faction: 3, team: 13, human: false, bot: { difficulty: 1, personality: 'rusher' } },
    ],
  };
}

// rows: [rtt, jitter]; 60 ms with little jitter is a good home connection (#198)
const LINKS: [number, number][] = [[60, 0], [60, 10], [60, 20], [50, 80], [150, 20], [150, 80], [300, 20], [300, 80], [500, 20], [500, 80]];
const LOSSES = [0, 0.02, 0.05];

const pad = (v: unknown, n: number) => String(v).padStart(n);
/** 'ok', or what went wrong: worlds that disagree, or orders that never ran */
const ok = (r: NetMatchReport) =>
  r.desyncs.length || r.mismatches.length || !r.finalAgree || r.hashTicks === 0 ? 'DESYNC' : r.seats.some((s) => s.ran !== s.issued) ? 'LOST' : 'ok';

console.log(`${secs} s matches, host + one friend; latencies are order-to-effect ms (p50/p95); stall is the friend's, s per minute\n`);
console.log('  rtt  jit  loss | co-op host  friend   buf stall | pvp host   friend   buf stall |  hashes');
for (const [rtt, jitter] of LINKS) {
  if (only && String(rtt) !== only) continue;
  {
    for (const loss of LOSSES) {
      // the host's own client: turns in-process, one held (as NetMatch does, #198)
      const peers = [{ seat: 0, rtt: 0, net: { fixedBuffer: 1 } }, { seat: 1, rtt, jitter, loss }];
      const row: string[] = [pad(rtt, 5), pad(jitter, 4), pad(`${loss * 100}%`, 5), '|'];
      const checks: string[] = [];
      for (const pvp of [false, true]) {
        const r = runNetMatch({ setup: setup(pvp, rtt + jitter), peers, secs, seq: seqOpts, net: netOpts });
        const [h, f] = r.seats;
        row.push(
          pad(`${Math.round(h.effect.p50)}`, 9),
          pad(`${Math.round(f.effect.p50)}/${Math.round(f.effect.p95)}`, 9),
          pad(f.target, 4),
          pad(((f.stallMs / 1000) * (60 / secs)).toFixed(2), 5),
          '|',
        );
        checks.push(ok(r));
      }
      row.push(pad(checks.find((c) => c !== 'ok') ?? 'ok', 7));
      console.log(row.join(' '));
    }
  }
}
