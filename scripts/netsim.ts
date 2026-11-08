// Net-sim probe (#160): whole networked matches on a virtual clock, swept
// over link quality. One host (its own client at 0 ms) and one friend; the
// friend's link varies. Prints order-to-effect latency, buffer and stalls
// for co-op and PvP, and whether every hash matched.
//   npx vite-node scripts/netsim.ts [secs=120]
//   npx vite-node scripts/netsim.ts --only=300 [secs]   (just the 300 ms rows)
import { runNetMatch, type NetMatchReport } from '../src/net/harness';
import type { MatchSetup } from '../src/sim/setup';

const args = process.argv.slice(2);
const secs = Number(args.find((a) => !a.startsWith('--')) ?? 120);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
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

const RTTS = [50, 150, 300, 500];
const JITTERS = [20, 80];
const LOSSES = [0, 0.02, 0.05];

const pad = (v: unknown, n: number) => String(v).padStart(n);
const ok = (r: NetMatchReport) => (r.desyncs.length || !r.finalAgree || r.hashTicks === 0 ? 'DESYNC' : 'ok');

console.log(`${secs} s matches, host + one friend; latencies are order-to-effect ms (p50/p95); stall is the friend's, s per minute\n`);
console.log('  rtt  jit  loss | co-op host  friend   buf stall | pvp host   friend   buf stall |  hashes');
for (const rtt of RTTS) {
  if (only && String(rtt) !== only) continue;
  for (const jitter of JITTERS) {
    for (const loss of LOSSES) {
      const peers = [{ seat: 0, rtt: 0 }, { seat: 1, rtt, jitter, loss }];
      const row: string[] = [pad(rtt, 5), pad(jitter, 4), pad(`${loss * 100}%`, 5), '|'];
      const checks: string[] = [];
      for (const pvp of [false, true]) {
        const r = runNetMatch({ setup: setup(pvp, rtt + jitter), peers, secs });
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
      row.push(pad(checks.every((c) => c === 'ok') ? 'ok' : 'DESYNC', 7));
      console.log(row.join(' '));
    }
  }
}
