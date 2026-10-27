// Where units die (#29, #37): attacking an enemy nest, defending their own, at a
// neutral nest, or in the open. Shared by death-split.ts (recordings) and the
// proxy probes, so the human and the proxy are measured the same way.
import { NEUTRAL } from '../src/sim/constants';
import type { World } from '../src/sim/world';

export type Site = 'attacking' | 'defending' | 'neutral' | 'field';
export const SITES: Site[] = ['attacking', 'defending', 'neutral', 'field'];
/** a death this far outside a nest's radius still counts as at that nest */
const NEAR = 90;

export function deathSite(w: World, x: number, y: number, owner: number): Site {
  let best = -1, bestD = Infinity;
  for (let k = 0; k < w.nests.length; k++) {
    const n = w.nests[k];
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < (n.r + NEAR) ** 2 && d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best < 0) return 'field';
  const n = w.nests[best];
  if (n.owner < 0 || n.owner === NEUTRAL) return 'neutral';
  return w.teamOf[n.owner] === w.teamOf[owner] ? 'defending' : 'attacking';
}

export type DeathTally = Record<Site, number>;
export const tally = (): DeathTally => ({ attacking: 0, defending: 0, neutral: 0, field: 0 });

/** Count this tick's deaths (w.deaths is a flat [x, y, owner] list) into `by[owner]`. */
export function countDeaths(w: World, by: (owner: number) => DeathTally | null): void {
  const d = w.deaths;
  for (let k = 0; k < d.length; k += 3) {
    const t = by(d[k + 2]);
    if (t) t[deathSite(w, d[k], d[k + 1], d[k + 2])]++;
  }
}

export const share = (t: DeathTally): string => {
  const sum = SITES.reduce((s, k) => s + t[k], 0) || 1;
  return SITES.map((k) => `${k} ${((100 * t[k]) / sum).toFixed(0)}%`).join(' · ');
};
