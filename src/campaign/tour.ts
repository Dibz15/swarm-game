/**
 * The run map's tour (#217): a first-run walk through the procedural
 * campaign. Each step looks at part of the map, rings what it's about and
 * explains it. Plain data over the run, so it can be tested without a page.
 * The glossary below is the same words, for the campaign's How to play.
 */

import { MAP_H, MAP_W, frontShape, living, moves, revealed, type RunState } from './run';
import type { Warlord } from './warlords';

/** Where a step looks: a point in map space and about how much of the map's width to show (null: all of it). */
export interface TourFocus {
  x: number;
  y: number;
  span: number | null;
}

/** A ring drawn around something on the map: its centre in map units, its radius in screen pixels (node icons don't scale with zoom). */
export interface TourMark {
  x: number;
  y: number;
  r: number;
}

export type TourCamp = 'broods' | 'unlocks' | 'rewards';

export interface TourStep {
  id: string;
  title: string;
  text: string;
  focus: (run: RunState) => TourFocus;
  marks?: (run: RunState) => TourMark[];
  /** nodes shown through the fog for this step (at the start, you know only your neighbours) */
  peek?: (run: RunState) => number[];
  /** a header element (selector inside the run map) to pulse */
  dom?: string;
  /** a node whose card opens for this step */
  select?: (run: RunState) => number | null;
  /** the camp opens on this tab */
  camp?: TourCamp;
  /** skipped when it has nothing to show on this run (no warlords, say) */
  when?: (run: RunState) => boolean;
}

const WHOLE: TourFocus = { x: MAP_W / 2, y: MAP_H / 2, span: null };
const NODE_R = 22;

const at = (run: RunState, id: number, span: number | null = 420): TourFocus => ({ x: run.nodes[id].x, y: run.nodes[id].y, span });
const ring = (run: RunState, id: number, k = 1): TourMark => ({ x: run.nodes[id].x, y: run.nodes[id].y, r: NODE_R * k });

/** The standing warlord nearest your swarm, preferring one whose stronghold you've seen. */
export function tourWarlord(run: RunState): Warlord | null {
  const here = run.nodes[run.at];
  const known = revealed(run);
  const lords = (run.warlords ?? []).filter((w) => living(run, w));
  const d = (w: Warlord) => {
    const s = run.nodes[w.stronghold];
    return Math.hypot(s.x - here.x, s.y - here.y) + (known.has(w.stronghold) ? 0 : 10000);
  };
  return lords.sort((a, b) => d(a) - d(b))[0] ?? null;
}

/** The nearest unswallowed node of a kind, or null. */
function nearestOf(run: RunState, kind: RunState['nodes'][number]['kind']): number | null {
  const here = run.nodes[run.at];
  let best: number | null = null, bestD = Infinity;
  for (const n of run.nodes) {
    if (n.kind !== kind || run.swallowed.includes(n.id) || run.visited.includes(n.id)) continue;
    const d = Math.hypot(n.x - here.x, n.y - here.y);
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}

/** Where the Bloom's band is, level with your swarm (its edge, kept on the map). */
export function bloomEdge(run: RunState): { x: number; y: number } {
  const y = run.nodes[run.at].y;
  const x = run.bloom.front + frontShape(run.bloom, y);
  return { x: Math.max(0, Math.min(MAP_W, x)), y };
}

export const TOUR: TourStep[] = [
  {
    id: 'swarm',
    title: 'Your swarm',
    text: 'This is your swarm, and the tent beside it is your camp. A run is a march across this map: one territory a turn, each one a battle.',
    focus: (run) => at(run, run.at, 360),
    marks: (run) => [ring(run, run.at, 1.6)],
  },
  {
    id: 'heart',
    title: 'The goal',
    text: "The star on the far side is the Bloom's heart. Reach it and destroy it in the final battle to win the run.",
    focus: () => WHOLE,
    marks: (run) => [ring(run, run.heart, 1.8), ring(run, run.at, 1.4)],
  },
  {
    id: 'moves',
    title: 'Moving',
    text: "Each turn, pick a highlighted territory linked to yours. Its card shows the battle: the enemies, the map, what wins it and what it pays. Win, and it's yours; you can march back through it without a fight.",
    focus: (run) => at(run, run.at, 460),
    marks: (run) => moves(run).map((id) => ring(run, id, 1.3)),
    select: (run) => moves(run)[0] ?? null,
  },
  {
    id: 'bloom',
    title: 'The Bloom',
    text: "The Bloom waits off the left edge and grows every turn, spreading out from the places you've left. Anything it swallows is lost, and each territory it takes makes its swarms stronger. Keep moving, and don't let it cut off your road.",
    focus: (run) => {
      const e = bloomEdge(run);
      return { x: e.x + 80, y: e.y, span: 520 };
    },
    marks: (run) => {
      // On the band, a little above or below your swarm (toward the middle), so it rings the Bloom and not you.
      const y0 = run.nodes[run.at].y;
      const y = y0 < MAP_H / 2 ? y0 + 120 : y0 - 120;
      const x = Math.max(0, Math.min(MAP_W, run.bloom.front + frontShape(run.bloom, y)));
      return [{ x, y, r: 46 }];
    },
  },
  {
    id: 'warlord',
    title: 'Warlords',
    text: "Rival warlords rule domains, washed in their colour. Each has a trait that changes how its battles play. The Bloom eats into their domains too, weakening them.",
    when: (run) => !!tourWarlord(run),
    focus: (run) => {
      const w = tourWarlord(run)!;
      const pts = w.nodes.map((id) => run.nodes[id]);
      const x = pts.reduce((s, n) => s + n.x, 0) / pts.length, y = pts.reduce((s, n) => s + n.y, 0) / pts.length;
      return { x, y, span: 520 };
    },
    marks: (run) => tourWarlord(run)!.nodes.map((id) => ring(run, id, 1.2)),
    peek: (run) => tourWarlord(run)!.nodes,
  },
  {
    id: 'stronghold',
    title: 'Strongholds',
    text: "The crowned, walled node is the warlord's stronghold: a hard fight against its citadel, but it pays double, breaks the domain and wins you the warlord's trophy, a run-wide perk.",
    when: (run) => !!tourWarlord(run),
    focus: (run) => at(run, tourWarlord(run)!.stronghold, 360),
    marks: (run) => [ring(run, tourWarlord(run)!.stronghold, 2)],
    peek: (run) => tourWarlord(run)!.nodes,
  },
  {
    id: 'battles',
    title: 'Kinds of battle',
    text: "Conquest: beat the rivals or hold most nests. Domination: score on the gold key nests. Hold the line: dig in behind your walls and outlast the Bloom's waves. Each card spells out what wins it, and the first time you play one, it's explained in the battle.",
    focus: (run) => {
      const id = nearestOf(run, 'hold') ?? nearestOf(run, 'domination');
      return id === null ? WHOLE : at(run, id, 520);
    },
    marks: (run) => {
      const id = nearestOf(run, 'hold') ?? nearestOf(run, 'domination');
      return id === null ? [] : [ring(run, id, 1.6)];
    },
    peek: (run) => {
      const id = nearestOf(run, 'hold') ?? nearestOf(run, 'domination');
      return id === null ? [] : [id];
    },
  },
  {
    id: 'broods',
    title: 'Broods and strains',
    text: 'Your army is your broods: squads that carry over from battle to battle. Pick up to three to field each fight. Winners grow and become veterans; losers come back wounded and smaller. Strains are rewards that change one brood for good.',
    focus: (run) => at(run, run.at, 360),
    camp: 'broods',
  },
  {
    id: 'camp',
    title: 'The camp',
    text: "Battles pay biomass (top right). Spend it at the camp, by tapping your swarm: heal and grow broods, and unlock nest types. Until a nest type is unlocked, it only makes Swarmers for you. After each win you also pick a reward, kept on the Rewards tab.",
    focus: (run) => at(run, run.at, 360),
    camp: 'unlocks',
    dom: '.run-stats',
  },
];

/** The steps for this run, minus any it has nothing to show for. */
export const tourFor = (run: RunState): TourStep[] => TOUR.filter((s) => !s.when || s.when(run));

/** The campaign's terms, for How to play. */
export const GLOSSARY: { term: string; text: string }[] = [
  { term: 'The goal', text: "Cross the map one territory a turn and destroy the Bloom's heart, the star on the far side, before the Bloom swallows your road or your broods." },
  { term: 'The Bloom', text: "It waits off the left edge and spreads from the places you've left, a turn behind you. What it swallows is lost, and each territory it takes makes its swarms stronger." },
  { term: 'Warlords', text: 'Rivals who rule domains (washed in their colour). Each has a trait that shapes its battles; the Bloom eating their domain weakens them.' },
  { term: 'Strongholds', text: "A warlord's walled, crowned node. Take its citadel to win: double pay, better rewards, the domain broken and the warlord's trophy perk." },
  { term: 'Broods', text: 'Your squads, kept between battles: up to four, three fielded per fight. Winners grow and turn veteran after two wins; losers are wounded and cut down.' },
  { term: 'Strains', text: 'Rewards that attach to one brood of the right kind, two slots each.' },
  { term: 'The camp', text: 'Tap your swarm to open it. Spend biomass to heal and grow broods and to unlock nest types and Nova; see your run-wide rewards.' },
  { term: 'Rewards', text: 'After each win, pick one: a strain, a power variant, a perk or a pact.' },
  { term: 'Battles', text: 'Conquest (beat the rivals or hold most nests; the Bloom surges in late), Domination (score on key nests), Hold the line (keep your walled capital against Bloom waves), strongholds, and the heart.' },
];

// ---- seen ----------------------------------------------------------------

const KEY = 'swarm.runGuide';

export interface RunGuide {
  /** the map tour was finished or skipped */
  toured: boolean;
}

export function loadGuide(): RunGuide {
  try {
    const raw = localStorage.getItem(KEY);
    const g = raw ? (JSON.parse(raw) as Partial<RunGuide>) : {};
    return { toured: !!g.toured };
  } catch {
    return { toured: false };
  }
}

export function saveGuide(g: RunGuide): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    /* storage full or unavailable */
  }
}

/** Should this run open with the tour? Its first turn, and only until the tour's been seen once. */
export const wantsTour = (run: RunState, g = loadGuide()): boolean => !g.toured && run.turn === 0 && run.status === 'active';
