import { PERSONALITIES } from '../sim/ai/bot';
import type { EventLevel } from '../sim/mapgen';
import { Rng } from '../sim/rng';
import type { MatchSetup } from '../sim/setup';
import { TICK_HZ } from '../sim/constants';
import type { World } from '../sim/world';
import { MILITIA, fighters, veteran, type BattleReport } from './broods';
import { modsFor } from './rewards';
import { maxFielded, pressure, type RunState } from './run';

/**
 * Conquest is won by wiping out every rival, or by holding this share of the
 * nests for the usual 30 s: without it, two rivals can turtle and stall the
 * battle (the run probe saw 11-15% of Normal × 2 battles hit its 15-minute cap).
 */
export const CONQUEST_SHARE = 0.8;
/** Domination nodes: hold half the nests (the usual share is 0.6-0.7). */
const DOMINATION_SHARE = 0.5;

/** The fielded broods (fit ones only, at most three) as a starting army; the militia if none. Lone wolf doubles it. */
export function armyFor(run: RunState, fielded: number[]): { kind: number; count: number; vet?: boolean }[] {
  const out = fighters(run.broods, fielded, maxFielded(run));
  const scale = run.perks.includes('lone-wolf') ? 2 : 1;
  return out.length ? out.map((b) => ({ kind: b.kind, count: b.size * scale, vet: veteran(b) })) : [MILITIA];
}

/** The match for a run node. Same node, same battle (its seed is fixed). */
export function nodeSetup(run: RunState, id: number, portrait: boolean, fielded: number[] = []): MatchSetup {
  const n = run.nodes[id];
  const rng = new Rng(n.seed);
  const others = [0, 1, 2, 3, 4, 5].filter((c) => c !== run.color);
  // Shuffle rival colors per node so battles don't all look alike.
  for (let i = others.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [others[i], others[j]] = [others[j], others[i]];
  }
  // The closer the Bloom, the wilder the map events (its swarms come in phase 4).
  const p = n.kind === 'finale' ? 1 : pressure(run, id);
  const events: EventLevel = p > 0.66 ? 'wild' : p > 0.2 ? 'normal' : 'calm';
  return {
    seed: n.seed,
    size: n.size,
    terrain: n.terrain,
    caves: n.caves,
    layout: 'random',
    events,
    portrait,
    domShare: n.kind === 'domination' ? DOMINATION_SHARE : n.kind === 'finale' ? undefined : CONQUEST_SHARE,
    players: [
      {
        faction: run.color,
        team: 0,
        human: true,
        army: armyFor(run, fielded),
        nestTypes: run.unlocks.nests,
        mods: modsFor(run.perks, fighters(run.broods, fielded, maxFielded(run))),
      },
      ...others.slice(0, n.rivals).map((faction, i) => ({
        faction,
        team: i + 1,
        human: false,
        bot: { difficulty: n.difficulty, personality: rng.pick(PERSONALITIES) },
      })),
    ],
  };
}

/** Events level the node's battle would get right now, for previews. */
export function bloomLabel(run: RunState, id: number): string {
  const p = run.nodes[id].kind === 'finale' ? 1 : pressure(run, id);
  return p > 0.66 ? 'Bloom close: wild swarms' : p > 0.2 ? 'Bloom nearing' : 'Bloom far';
}

/** How a battle ended for the run: the human's survivors by kind, nests fully held, time. */
export function battleReport(w: World, human: number, won: boolean): BattleReport {
  const survivors = [0, 0, 0, 0];
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === human && w.kind[i] < survivors.length) survivors[w.kind[i]]++;
  const nests = w.nests.filter((n) => n.owner === human && n.control >= 1).length;
  return { won, survivors, nests, seconds: w.tick / TICK_HZ };
}
