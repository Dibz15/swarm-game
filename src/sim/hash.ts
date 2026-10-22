import type { World } from './world';

/** Checksum of simulation state, for desync detection and tests. */
export function worldHash(w: World): number {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
  };
  mix(w.tick);
  mix(w.count);
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i]) continue;
    mix(i);
    mix(w.uid[i]);
    mix(Math.round(w.x[i] * 64));
    mix(Math.round(w.y[i] * 64));
    mix(Math.round(w.hp[i] * 64));
    mix(w.owner[i]);
    mix(w.state[i]);
  }
  for (const n of w.nests) {
    mix(n.owner);
    mix(n.level);
    mix(Math.round(n.control * 1e4));
    mix(n.feedProgress);
  }
  for (const f of w.factions) mix(Math.round(f.energy * 100));
  for (const c of w.crystals) mix(c.holder);
  if (w.events) {
    for (const d of w.events.drops) {
      mix(Math.round(d.progress * 1e4));
      mix(d.holder);
    }
    for (const s of w.events.swarms) mix(Math.round(s.tx * 64) ^ Math.round(s.ty * 64));
    for (const c of w.events.colossi) mix(c.leg);
  }
  for (const b of w.barrages) {
    mix(Math.round(b.x * 64));
    mix(Math.round(b.y * 64));
    mix(b.impact);
  }
  return h >>> 0;
}
