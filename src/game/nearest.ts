import type { World } from '../sim/world';

/** Units this far (px) from a cluster's center join it; farther ones start their own. */
const CLUSTER = 200;

/**
 * "Back to the nearest nest" (#42): split the selected units into clusters,
 * and send each cluster to the nest p owns that's the shortest walk away
 * (walls count). Empty when p owns no nest or none of the units are alive.
 */
export function nearestNestOrders(w: World, p: number, uids: readonly number[]): { units: number[]; nest: number }[] {
  const own = w.nests.filter((n) => n.owner === p);
  if (!own.length) return [];

  const clusters: { units: number[]; sx: number; sy: number }[] = [];
  for (const u of uids) {
    const s = w.uidToSlot.get(u);
    if (s === undefined || !w.alive[s] || w.owner[s] !== p) continue;
    const x = w.x[s], y = w.y[s];
    let c = clusters.find((c) => (c.sx / c.units.length - x) ** 2 + (c.sy / c.units.length - y) ** 2 < CLUSTER * CLUSTER);
    if (!c) clusters.push((c = { units: [], sx: 0, sy: 0 }));
    c.units.push(u);
    c.sx += x;
    c.sy += y;
  }

  return clusters.map((c) => {
    const cx = c.sx / c.units.length, cy = c.sy / c.units.length;
    let best = own[0], bd = Infinity;
    for (const n of own) {
      const d = w.terrain.pathDist(cx, cy, n.x, n.y, w.tick);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return { units: c.units, nest: best.id };
  });
}
