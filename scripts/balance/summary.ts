// Run reports for the surrogate and its validation (#68): win rates against
// the targets, where runs are lost, run length, the biomass curve, warlords.
import type { RunDifficulty } from '../../src/campaign/run';
import type { RunOutcome } from './runs';

/** #68's targets: run win rate by difficulty and proxy skill (skill 1 ≈ a strong player). */
export const TARGETS: Record<RunDifficulty, Record<string, number>> = {
  gentle: { 1: 0.9, 0.5: 0.6 },
  standard: { 1: 0.7, 0.5: 0.35 },
  hard: { 1: 0.45 },
  brutal: { 1: 0.2 },
};
/** no depth band may take more than this share of run losses */
export const LOSS_SPREAD = 0.35;
export const LOSS_BANDS = 4;

export const winRate = (os: RunOutcome[]) => os.filter((o) => o.status === 'won').length / Math.max(1, os.length);

/** Share of lost runs by depth band (depth over the heart's depth, in quarters). */
export function lossBands(os: RunOutcome[]): number[] {
  const lost = os.filter((o) => o.status === 'lost');
  const h = new Array(LOSS_BANDS).fill(0);
  for (const o of lost) h[Math.min(LOSS_BANDS - 1, Math.floor((LOSS_BANDS * o.depth) / Math.max(1, o.far)))]++;
  return h.map((n) => n / Math.max(1, lost.length));
}

/** Battle minutes per run, sorted. */
export const runMinutes = (os: RunOutcome[]) => os.map((o) => o.battles.reduce((s, b) => s + b.minutes, 0)).sort((a, b) => a - b);

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** A few lines on one difficulty × skill's runs. */
export function summarize(os: RunOutcome[], difficulty: RunDifficulty, skill: number): string[] {
  const target = TARGETS[difficulty][skill];
  const lost = (why: string) => os.filter((o) => o.lostTo === why).length / os.length;
  const bands = lossBands(os);
  const mins = runMinutes(os);
  const lords = (k: keyof RunOutcome['lords']) => (os.reduce((s, o) => s + o.lords[k], 0) / os.length).toFixed(1);
  const curve = Array.from({ length: 12 }, (_, i) => {
    const at = os.filter((o) => o.curve.length > i).map((o) => o.curve[i]);
    return at.length >= os.length / 4 ? avg(at).toFixed(0) : '';
  }).filter(Boolean);
  return [
    `${difficulty} at skill ${skill}: ${pct(winRate(os))} won of ${os.length}${target !== undefined ? ` (target ${pct(target)})` : ''}; lost to broods ${pct(lost('broods'))}, Bloom ${pct(lost('bloom'))}`,
    `  losses by depth band: ${bands.map(pct).join(' / ')}${Math.max(...bands) > LOSS_SPREAD ? `  (over ${pct(LOSS_SPREAD)})` : ''}`,
    `  run minutes (battles): mean ${avg(mins).toFixed(0)}, median ${(mins[mins.length >> 1] ?? NaN).toFixed(0)}, 10–90% ${(mins[Math.floor(mins.length * 0.1)] ?? NaN).toFixed(0)}–${(mins[Math.floor(mins.length * 0.9)] ?? NaN).toFixed(0)}`,
    `  biomass after each battle: ${curve.join(' ')}`,
    `  warlords per run: broken ${lords('broken')}, eaten ${lords('eaten')}, fought ${lords('fought')}, avoided ${lords('avoided')}`,
  ];
}
