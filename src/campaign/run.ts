/**
 * A procedural campaign run (#18, phase 1 #62): an organic map of territory
 * nodes, a Bloom front that rolls across it a little further every turn, and
 * the rules for moving and fighting. Pure and seeded: the same seed text
 * always gives the same map, and nothing here touches the DOM.
 *
 * Map space is MAP_W x MAP_H. You start at the left; the Bloom's heart (the
 * finale) is the rightmost node; the Bloom rolls in from behind you and its
 * front bulges ahead along the top and bottom, so it closes off nodes behind
 * you and to the sides.
 */

import { Rng, hashString } from '../sim/rng';
import type { CaveLevel, MapSize, TerrainLevel } from '../sim/mapgen';

export const MAP_W = 1000;
export const MAP_H = 620;
export const RUN_VERSION = 1;
/** stand-in for broods until phase 2: losing a battle costs one */
export const START_LIVES = 3;
/**
 * The Bloom's speed as a share of the fastest the shortest route survives.
 * At 0.6 one lost battle is almost always survivable and two spread-out ones
 * usually are (measured over 150 seeds).
 */
const BLOOM_PACE = 0.6;

export type NodeKind = 'start' | 'conquest' | 'domination' | 'finale';

export interface RunNode {
  id: number;
  x: number;
  y: number;
  links: number[];
  kind: NodeKind;
  /** hops from the start */
  depth: number;
  /** the battle's own seed */
  seed: number;
  size: MapSize;
  caves: CaveLevel;
  terrain: TerrainLevel;
  rivals: number;
  /** bot difficulty 0..3 */
  difficulty: number;
  /** biomass for winning here */
  reward: number;
}

/** The Bloom's front: x of the boundary at height y is `front + shape(y)`. */
export interface Bloom {
  /** where the front stands now (advances by `step` each turn) */
  front: number;
  step: number;
  /** how far ahead the front runs at the top and bottom edges */
  bulge: number;
  /** [amplitude, frequency, phase] ripples along the front */
  waves: [number, number, number][];
}

export type RunStatus = 'active' | 'won' | 'lost';

export interface RunState {
  v: number;
  id: string;
  seedText: string;
  seed: number;
  /** the player's color */
  color: number;
  nodes: RunNode[];
  start: number;
  heart: number;
  /** the node you're standing on */
  at: number;
  /** nodes you've taken (a visited node is passed through without a battle) */
  visited: number[];
  /** nodes the Bloom has swallowed */
  swallowed: number[];
  bloom: Bloom;
  turn: number;
  lives: number;
  biomass: number;
  status: RunStatus;
  /** why a lost run ended */
  lostTo?: 'battles' | 'bloom';
  created: number;
  updated: number;
  log: { turn: number; node: number; won: boolean }[];
}

// ---- generation -----------------------------------------------------------

/** Is (x, y) inside the run's irregular region? A noisy ellipse. */
function inside(x: number, y: number, lobes: [number, number, number][]): boolean {
  const dx = (x - MAP_W / 2) / (MAP_W * 0.48);
  const dy = (y - MAP_H / 2) / (MAP_H * 0.46);
  const a = Math.atan2(dy, dx);
  let edge = 1;
  for (const [amp, k, ph] of lobes) edge += amp * Math.sin(a * k + ph);
  return dx * dx + dy * dy < edge * edge;
}

/** Dart-throwing Poisson-disk sampling, loosened or tightened until the count lands in range. */
function scatter(rng: Rng, want: number, lobes: [number, number, number][]): { x: number; y: number }[] {
  let min = 150;
  let best: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 30; tries++) {
    const pts: { x: number; y: number }[] = [];
    for (let k = 0; k < 4000 && pts.length < want + 4; k++) {
      const x = rng.range(30, MAP_W - 30);
      const y = rng.range(30, MAP_H - 30);
      if (!inside(x, y, lobes)) continue;
      if (pts.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= min * min)) pts.push({ x, y });
    }
    if (Math.abs(pts.length - want) < Math.abs(best.length - want)) best = pts;
    if (pts.length >= want && pts.length <= want + 2) return pts.slice(0, want);
    min *= pts.length < want ? 0.93 : 1.06;
  }
  return best.slice(0, want);
}

/** Relative neighbourhood graph: a-b is a link unless some c is closer to both. Always connected. */
function link(pts: { x: number; y: number }[]): number[][] {
  const d = (a: number, b: number) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
  const links: number[][] = pts.map(() => []);
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const ab = d(a, b);
      let blocked = false;
      for (let c = 0; c < pts.length && !blocked; c++) {
        if (c !== a && c !== b && Math.max(d(a, c), d(b, c)) < ab) blocked = true;
      }
      if (!blocked) {
        links[a].push(b);
        links[b].push(a);
      }
    }
  }
  return links;
}

/** Hops from `from` to every node, avoiding `blocked`. -1 = unreachable. */
export function hops(nodes: { links: number[] }[], from: number, blocked: (id: number) => boolean = () => false): number[] {
  const dist = nodes.map(() => -1);
  dist[from] = 0;
  const queue = [from];
  while (queue.length) {
    const a = queue.shift()!;
    for (const b of nodes[a].links) {
      if (dist[b] >= 0 || blocked(b)) continue;
      dist[b] = dist[a] + 1;
      queue.push(b);
    }
  }
  return dist;
}

/** How far the front's shape runs ahead of `front` at height y. */
export function frontShape(b: Bloom, y: number): number {
  const e = (y - MAP_H / 2) / (MAP_H / 2);
  let s = b.bulge * e * e;
  for (const [amp, k, ph] of b.waves) s += amp * Math.sin(y * k + ph);
  return s;
}

/** Is (x, y) behind the front, i.e. in the Bloom? */
export function inBloom(b: Bloom, x: number, y: number, front = b.front): boolean {
  return x < front + frontShape(b, y);
}

/** Battle settings for a node, harder the further it is from the start. */
function battle(node: RunNode, t: number, rng: Rng): void {
  if (node.kind === 'start') return;
  if (node.kind === 'finale') {
    Object.assign(node, { size: 'large', rivals: 3, difficulty: 2, caves: rng.pick<CaveLevel>(['off', 'belt']), terrain: 'standard', reward: 0 });
    return;
  }
  node.difficulty = t < 0.3 ? 0 : t < 0.7 ? 1 : 2;
  node.rivals = t < 0.35 ? 1 : t < 0.7 ? 2 : 2 + rng.int(2);
  // Domination maps run one rival busier: a race for nests rather than a purge.
  if (node.kind === 'domination') node.rivals = Math.min(3, node.rivals + 1);
  node.size = node.rivals <= 1 ? 'small' : 'medium';
  node.caves = rng.pick<CaveLevel>(['off', 'off', 'off', 'belt', 'belt', 'full']);
  node.terrain = rng.pick<TerrainLevel>(['light', 'standard', 'standard', 'heavy']);
  node.reward = Math.round(10 + 20 * t + node.rivals * 4 + (node.kind === 'domination' ? 4 : 0));
}

export function newRun(seedText: string, color: number, now = Date.now()): RunState {
  const seed = hashString(`run:${seedText.trim() || 'swarm'}`);
  const rng = new Rng(seed);
  const lobes: [number, number, number][] = [1, 2, 3].map((k) => [rng.range(0.03, 0.09), k + 1, rng.range(0, Math.PI * 2)]);
  const pts = scatter(rng, 18 + rng.int(7), lobes);
  const links = link(pts);

  let start = 0, heart = 0;
  pts.forEach((p, i) => {
    if (p.x < pts[start].x) start = i;
    if (p.x > pts[heart].x) heart = i;
  });
  const nodes: RunNode[] = pts.map((p, i) => ({
    id: i,
    x: Math.round(p.x),
    y: Math.round(p.y),
    links: links[i],
    kind: i === start ? 'start' : i === heart ? 'finale' : rng.next() < 0.35 ? 'domination' : 'conquest',
    depth: 0,
    seed: hashString(`${seed}:${i}`),
    size: 'small',
    caves: 'off',
    terrain: 'standard',
    rivals: 1,
    difficulty: 0,
    reward: 0,
  }));
  const depth = hops(nodes, start);
  const far = Math.max(1, depth[heart]);
  for (const n of nodes) {
    n.depth = depth[n.id];
    battle(n, Math.min(1, n.depth / far), rng);
  }

  // The Bloom: starts just behind everything, and moves at a pace the
  // shortest route to the heart keeps ahead of with room for a lost battle or
  // two (a loss means staying put while it advances).
  const bloom: Bloom = {
    front: 0,
    step: 0,
    bulge: rng.range(90, 150),
    waves: [
      [rng.range(14, 26), rng.range(0.008, 0.014), rng.range(0, Math.PI * 2)],
      [rng.range(6, 12), rng.range(0.025, 0.04), rng.range(0, Math.PI * 2)],
    ],
  };
  bloom.front = Math.min(...nodes.map((n) => n.x - frontShape(bloom, n.y))) - 40;
  bloom.step = paceFor(nodes, start, heart, bloom) * BLOOM_PACE;

  return {
    v: RUN_VERSION,
    id: `${now.toString(36)}-${(seed % 46656).toString(36)}`,
    seedText: seedText.trim() || 'swarm',
    seed,
    color,
    nodes,
    start,
    heart,
    at: start,
    visited: [start],
    swallowed: [],
    bloom,
    turn: 0,
    lives: START_LIVES,
    biomass: 0,
    status: 'active',
    created: now,
    updated: now,
    log: [],
  };
}

/**
 * The fastest front the shortest route survives: after turn t the front has
 * moved t steps, and the route's next node must still be clear when you step
 * onto it.
 */
function paceFor(nodes: RunNode[], start: number, heart: number, b: Bloom): number {
  const back = hops(nodes, heart);
  const route = [start];
  while (route[route.length - 1] !== heart) {
    const a = route[route.length - 1];
    route.push(nodes[a].links.reduce((best, n) => (back[n] < back[best] ? n : best)));
  }
  let pace = Infinity;
  for (let t = 1; t < route.length - 1; t++) {
    const n = nodes[route[t + 1] ?? heart];
    if (n.id === heart) break;
    const room = n.x - frontShape(b, n.y) - b.front;
    pace = Math.min(pace, room / t);
  }
  // Short routes: never faster than a fifth of the map a turn.
  return Math.min(Number.isFinite(pace) ? pace : MAP_W / 5, MAP_W / 5);
}

// ---- turns ----------------------------------------------------------------

/** Nodes you can move to from where you stand. */
export function moves(run: RunState): number[] {
  if (run.status !== 'active') return [];
  return run.nodes[run.at].links.filter((n) => !run.swallowed.includes(n));
}

/** Moving onto a node you already took is a free march: no battle, but the Bloom still advances. */
export function needsBattle(run: RunState, id: number): boolean {
  return !run.visited.includes(id);
}

/** Every node the front would swallow at `front` (the heart never falls). */
function swallowedAt(run: RunState, front: number): number[] {
  return run.nodes.filter((n) => n.id !== run.heart && inBloom(run.bloom, n.x, n.y, front)).map((n) => n.id);
}

/**
 * Resolve a turn: move to `id` (winning, or marching through a taken node), or
 * stay put after a loss. Then the Bloom advances. Returns the nodes it newly
 * swallowed, for the map to animate.
 */
export function resolveTurn(run: RunState, id: number, won: boolean, now = Date.now()): number[] {
  const node = run.nodes[id];
  run.turn++;
  run.updated = now;
  if (needsBattle(run, id)) run.log.push({ turn: run.turn, node: id, won });
  if (won) {
    if (!run.visited.includes(id)) {
      run.visited.push(id);
      run.biomass += node.reward;
    }
    run.at = id;
    if (id === run.heart) {
      run.status = 'won';
      return [];
    }
  } else {
    run.lives--;
    if (run.lives <= 0) {
      run.status = 'lost';
      run.lostTo = 'battles';
      return [];
    }
  }

  run.bloom.front += run.bloom.step;
  const fresh = swallowedAt(run, run.bloom.front).filter((n) => !run.swallowed.includes(n));
  run.swallowed.push(...fresh);
  if (moves(run).length === 0) {
    run.status = 'lost';
    run.lostTo = 'bloom';
  }
  return fresh;
}

/** 0..1: how close the front is to a node (1 = it falls next turn). Drives battle events. */
export function pressure(run: RunState, id: number): number {
  const n = run.nodes[id];
  const gap = n.x - (run.bloom.front + frontShape(run.bloom, n.y));
  return Math.max(0, Math.min(1, 1 - gap / (run.bloom.step * 3)));
}
