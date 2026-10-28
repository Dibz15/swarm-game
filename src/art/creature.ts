/**
 * Procedural creature portraits (#72): a seeded creature from a seed, a
 * faction colour and traits. The same inputs always give the same creature,
 * so a rival, a brood or (later) a loadout can be saved as just its seed.
 *
 * Two layers: `creature()` is pure and builds a small rig (a body outline plus
 * named parts, each with an anchor, an angle and a length), and
 * `drawCreature()` draws a rig in the game's neon-on-dark look with plain
 * canvas paths. Drawing takes a `Pose` (per-part offsets on top of the rig),
 * and `poseAt()` is the one place animation goes (#81), so procedural motion
 * can be added without touching the generator.
 *
 * Traits → look:
 * - temper (a bot personality):
 *   - rusher: rows of spikes and big mandibles;
 *   - turtler: carapace plates and shoulder guards, small eyes;
 *   - expander: many legs or tendrils;
 *   - opportunist: many eyes, placed asymmetrically, and asymmetric spots.
 * - focus (a unit kind) picks the silhouette:
 *   - Swarmer: a cluster of lobes;
 *   - Shield: a wide dome;
 *   - Spear: a tall, pointed body with a nose horn;
 *   - Raider: a sleek arrow with swept fins.
 *   With no focus, the seed picks the silhouette.
 * - tier (0..3, a difficulty) scales the menace: horns from tier 1, a crest
 *   from tier 2, a slightly bigger body and a stronger glow.
 * - plating (0..1) adds plate rows and shoulder guards (warlord Ironhide, veterans).
 * - wounded dims the creature and adds a stitched scar.
 * - marks (strain or mutation ids) run entries of the `MARKS` registry, which
 *   add or change parts (#82).
 * The seed picks variants inside each of those: proportions, counts within a
 * range, the outline's wobble, the pattern and the name.
 */

import { FACTION_HEX, FACTION_RGB } from '../content/factions';
import type { Personality } from '../sim/ai/bot';
import { Kind } from '../sim/constants';
import { Rng, hashString } from '../sim/rng';

export interface CreatureTraits {
  temper?: Personality;
  /** unit focus (a `Kind`): sets the silhouette */
  focus?: number;
  /** 0..3, usually a difficulty */
  tier?: number;
  /** 0..1 extra armour */
  plating?: number;
  wounded?: boolean;
  /** strain or mutation ids, looked up in `MARKS` */
  marks?: string[];
}

export type BodyShape = 'cluster' | 'dome' | 'lance' | 'sleek';
export type PartKind =
  | 'limb'
  | 'tendril'
  | 'fin'
  | 'spike'
  | 'horn'
  | 'mandible'
  | 'crest'
  | 'plate'
  | 'spot'
  | 'sac'
  | 'scar'
  | 'pauldron'
  | 'eye';
export type Pattern = 'none' | 'stripes' | 'rings' | 'spots';

/**
 * One rig part, in body units: the creature fits in [-1, 1] before `fit`, with
 * its head up (−y). `a` is the direction it points (canvas radians), `len` its
 * reach and `w` its width (a radius for eyes, spots and sacs; the ray count for
 * a crest). `side` is +1 / −1 for a mirrored pair, 0 for a centre part.
 */
export interface Part {
  kind: PartKind;
  x: number;
  y: number;
  a: number;
  len: number;
  w: number;
  side: -1 | 0 | 1;
}

export interface Body {
  shape: BodyShape;
  rx: number;
  ry: number;
  /** closed outline, clockwise from the top */
  pts: [number, number][];
  /** extra round lobes (the cluster body) */
  lobes: { x: number; y: number; r: number }[];
}

export interface Creature {
  seed: number;
  color: number;
  name: string;
  traits: CreatureTraits;
  tier: number;
  body: Body;
  parts: Part[];
  pattern: Pattern;
  /** scale that keeps every part inside the portrait */
  fit: number;
}

/** Per-part motion on top of the rig; missing fields are zero (ds is a scale, 1 by default). */
export interface PartPose {
  dx?: number;
  dy?: number;
  da?: number;
  ds?: number;
}

export interface Pose {
  /** −1..1: the body swells a little at 1 */
  breath: number;
  /** 0 open .. 1 shut */
  blink: number;
  /** indexed like `Creature.parts` */
  parts?: (PartPose | undefined)[];
}

export const REST: Pose = { breath: 0, blink: 0 };

// ---- generation --------------------------------------------------------------

const SHAPES: readonly BodyShape[] = ['cluster', 'dome', 'lance', 'sleek'];
const FOCUS_SHAPE: Record<number, BodyShape> = { [Kind.Dot]: 'cluster', [Kind.Tank]: 'dome', [Kind.Lancer]: 'lance', [Kind.Swift]: 'sleek' };
const DIMS: Record<BodyShape, [number, number]> = { cluster: [0.36, 0.38], dome: [0.56, 0.42], lance: [0.32, 0.6], sleek: [0.4, 0.56] };

type Range = [number, number];
interface TemperLook {
  /** pairs */
  spikes: Range;
  /** rows */
  plates: Range;
  /** pairs */
  limbs: Range;
  /** pairs, or single eyes when asymmetric */
  eyes: Range;
  /** chance of mandibles */
  mandibles: number;
  /** chance a limb is a tendril */
  tendril: number;
  /** eyes and spots placed off-mirror */
  asym?: boolean;
}

export const TEMPER_LOOK: Record<Personality | 'none', TemperLook> = {
  rusher: { spikes: [3, 4], plates: [0, 1], limbs: [1, 2], eyes: [1, 1], mandibles: 1, tendril: 0 },
  turtler: { spikes: [0, 0], plates: [3, 4], limbs: [1, 2], eyes: [1, 1], mandibles: 0.3, tendril: 0 },
  expander: { spikes: [0, 1], plates: [0, 1], limbs: [3, 4], eyes: [1, 2], mandibles: 0.3, tendril: 0.7 },
  opportunist: { spikes: [1, 2], plates: [0, 1], limbs: [2, 3], eyes: [3, 5], mandibles: 0.5, tendril: 0.3, asym: true },
  none: { spikes: [0, 2], plates: [0, 2], limbs: [1, 3], eyes: [1, 2], mandibles: 0.5, tendril: 0.4 },
};

/**
 * Strain and mutation marks (#82): each adds or changes parts on a fresh rig.
 * The rng is seeded by the creature and the mark id.
 */
export const MARKS: Record<string, (c: Creature, rng: Rng) => void> = {
  /** example: a glowing sac on the belly */
  sac: (c, rng) => {
    c.parts.push({ kind: 'sac', x: 0, y: c.body.ry * rng.range(0.35, 0.5), a: 0, len: 0, w: rng.range(0.1, 0.14), side: 0 });
  },
};

const NAME_HEAD = ['Vex', 'Skar', 'Thra', 'Ny', 'Kor', 'Zel', 'Mor', 'Ush', 'Gri', 'Qua', 'Xi', 'Dra', 'Sel', 'Vor', 'Ith', 'Kra', 'Ozz', 'Hesh'];
const NAME_MID = ['', '', 'a', 'i', 'o', 'u', 'ae', 'y'];
const NAME_TAIL = ['maw', 'th', 'rix', 'kesh', 'gul', 'zar', 'nax', 'vis', 'dra', 'mor', 'ix', 'sk', 'lith', 'grim', 'ra', 'quil'];

function nameFor(rng: Rng): string {
  const head = rng.pick(NAME_HEAD);
  const mid = rng.pick(NAME_MID);
  // No vowel pile-ups such as "Quaae".
  return head + (/[aeiouy]$/.test(head) ? '' : mid) + rng.pick(NAME_TAIL);
}

const between = (rng: Rng, [a, b]: Range) => a + rng.int(b - a + 1);

/** A creature from a seed, a faction colour and traits. Pure: no DOM, no Math.random. */
export function creature(seed: number, color: number, traits: CreatureTraits = {}): Creature {
  const rng = new Rng(seed ^ 0x5eed1e);
  const look = TEMPER_LOOK[traits.temper ?? 'none'];
  const tier = Math.max(0, Math.min(3, Math.round(traits.tier ?? 1)));
  const plating = Math.max(0, Math.min(1, traits.plating ?? 0));
  const name = nameFor(rng);
  const shape = (traits.focus !== undefined ? FOCUS_SHAPE[traits.focus] : undefined) ?? rng.pick(SHAPES);

  // Body: half an outline from the top (θ = 0) to the bottom (θ = π), mirrored.
  const grow = 1 + tier * 0.04;
  const rx = DIMS[shape][0] * rng.range(0.9, 1.1) * grow;
  const ry = DIMS[shape][1] * rng.range(0.9, 1.1) * grow;
  const wobK = 2 + rng.int(3), wobA = rng.range(0, 0.07), wobP = rng.range(0, Math.PI * 2);
  const N = 24;
  const half: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const th = (Math.PI * i) / N;
    const up = (1 - Math.cos(th)) / 2; // 0 at the top, 1 at the bottom
    let x = rx * Math.sin(th);
    let y = -ry * Math.cos(th);
    if (shape === 'lance') x *= Math.pow(up, 0.55) * 1.15;
    else if (shape === 'sleek') x *= Math.pow(up, 0.3) * (1 - 0.25 * up * up);
    else if (shape === 'dome' && y > 0) y *= 0.6;
    x *= 1 + wobA * Math.sin(wobK * th + wobP) * Math.sin(th);
    half.push([x, y]);
  }
  const pts: [number, number][] = [...half, ...half.slice(1, -1).reverse().map(([x, y]): [number, number] => [-x, y])];
  const lobes: Body['lobes'] = [];
  if (shape === 'cluster') {
    const pairs = 2 + rng.int(2);
    for (let i = 0; i < pairs; i++) {
      const t = (i + 0.5) / pairs;
      // Satellite bodies with a gap, so the cluster reads as a swarm.
      const r = rng.range(0.09, 0.14);
      const x = rx * rng.range(1.15, 1.35) + r * 0.5, y = ry * (t * 1.6 - 0.65);
      lobes.push({ x, y, r }, { x: -x, y, r });
    }
    lobes.push({ x: 0, y: ry * 1.25 + 0.06, r: rng.range(0.09, 0.13) });
  }
  const body: Body = { shape, rx, ry, pts, lobes };

  // Edge helpers on the right half: a point at u (0 top .. 1 bottom) and its outward normal.
  const edge = (u: number): { x: number; y: number; a: number } => {
    const f = Math.max(0, Math.min(1, u)) * N;
    const i = Math.min(N - 1, Math.floor(f)), t = f - i;
    const [x0, y0] = half[i], [x1, y1] = half[i + 1];
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, a: Math.atan2(-(x1 - x0), y1 - y0) };
  };
  const halfWidth = (y: number) => {
    let best = half[0];
    for (const p of half) if (Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p;
    return best[0];
  };

  const parts: Part[] = [];
  const pair = (p: Omit<Part, 'side'>) => parts.push({ ...p, side: 1 }, { ...p, x: -p.x, a: Math.PI - p.a, side: -1 });
  const centre = (p: Omit<Part, 'side'>) => parts.push({ ...p, side: 0 });

  // Legs and tendrils, swept back a little.
  const limbs = between(rng, look.limbs) + (shape === 'cluster' ? -1 : 0);
  for (let i = 0; i < limbs; i++) {
    const e = edge(0.42 + (0.45 * (i + 0.5)) / Math.max(1, limbs) + rng.range(-0.03, 0.03));
    const kind = rng.next() < look.tendril ? 'tendril' : 'limb';
    pair({ kind, x: e.x * 0.9, y: e.y, a: e.a + rng.range(0, 0.45), len: rng.range(0.3, 0.42), w: 0 });
  }
  if (shape === 'sleek') {
    const fins = 1 + rng.int(2);
    for (let i = 0; i < fins; i++) {
      const e = edge(0.55 + 0.18 * i);
      pair({ kind: 'fin', x: e.x * 0.85, y: e.y, a: e.a + 0.75, len: rng.range(0.3, 0.4) - 0.08 * i, w: 0.45 });
    }
  }
  const spikes = between(rng, look.spikes);
  for (let i = 0; i < spikes; i++) {
    const e = edge(0.2 + (0.5 * (i + 0.5)) / spikes + rng.range(-0.03, 0.03));
    pair({ kind: 'spike', x: e.x * 0.92, y: e.y, a: e.a - 0.25, len: rng.range(0.14, 0.22) + (traits.temper === 'rusher' ? 0.05 : 0), w: 0.08 });
  }
  const horns = Math.min(tier, 2);
  for (let i = 0; i < horns; i++) {
    const e = edge(0.08 + 0.1 * i);
    pair({ kind: 'horn', x: e.x * 0.9, y: e.y, a: e.a - 0.55 + 0.25 * i, len: 0.2 + 0.06 * tier - 0.05 * i, w: 0.06 });
  }
  if (shape === 'lance') centre({ kind: 'horn', x: 0, y: -ry * 0.98, a: -Math.PI / 2, len: 0.22 + 0.03 * tier, w: 0.07 });
  if (rng.next() < look.mandibles) {
    const e = edge(0.07);
    pair({ kind: 'mandible', x: Math.max(0.06, e.x), y: e.y + 0.02, a: -Math.PI / 2 + 0.35, len: rng.range(0.16, 0.24) + (traits.temper === 'rusher' ? 0.06 : 0), w: 0.05 });
  }
  if (tier >= 2) centre({ kind: 'crest', x: 0, y: -ry * 0.85, a: -Math.PI / 2, len: 0.12 + 0.05 * tier, w: 3 + tier });

  const plates = between(rng, look.plates) + Math.round(plating * 3);
  for (let i = 0; i < plates; i++) {
    const y = ry * (-0.05 + (0.65 * (i + 0.5)) / plates);
    centre({ kind: 'plate', x: 0, y, a: 0, len: halfWidth(y) * 0.85, w: 0.1 });
  }
  if (traits.temper === 'turtler' || plating > 0.3) {
    const e = edge(0.3);
    pair({ kind: 'pauldron', x: e.x * 0.95, y: e.y, a: e.a, len: 0, w: 0.12 + 0.05 * plating });
  }

  const pattern: Pattern = rng.pick(['none', 'stripes', 'rings', 'spots'] as const);
  if (pattern === 'spots') {
    const n = 2 + rng.int(3);
    for (let i = 0; i < n; i++) {
      const y = ry * rng.range(0, 0.6);
      const x = halfWidth(y) * rng.range(0.2, 0.6);
      const r = rng.range(0.03, 0.06);
      if (look.asym) centre({ kind: 'spot', x: rng.next() < 0.5 ? x : -x, y, a: 0, len: 0, w: r });
      else pair({ kind: 'spot', x, y, a: 0, len: 0, w: r });
    }
  }

  // Eyes last, so they draw on top.
  const eyeR = traits.temper === 'turtler' ? 0.045 : rng.range(0.055, 0.08);
  const eyes = between(rng, look.eyes);
  if (look.asym) {
    for (let i = 0; i < eyes; i++) {
      const y = -ry * rng.range(0.15, 0.6);
      const x = halfWidth(y) * rng.range(-0.6, 0.6);
      centre({ kind: 'eye', x, y, a: 0, len: 0, w: eyeR * rng.range(0.6, 1.15) });
    }
  } else {
    for (let i = 0; i < eyes; i++) {
      const y = -ry * (0.42 - 0.2 * i);
      pair({ kind: 'eye', x: Math.max(eyeR * 1.2, halfWidth(y) * rng.range(0.35, 0.55)), y, a: 0, len: 0, w: eyeR * (1 - 0.2 * i) });
    }
  }

  if (traits.wounded) centre({ kind: 'scar', x: rng.range(-0.08, 0.08), y: ry * rng.range(-0.1, 0.25), a: rng.range(0.4, 1.0), len: Math.min(rx, 0.4), w: 0 });

  const c: Creature = { seed, color, name, traits, tier, body, parts, pattern, fit: 1 };
  for (const id of traits.marks ?? []) MARKS[id]?.(c, new Rng(seed ^ hashString(id)));
  c.fit = Math.min(1.15, 0.9 / extent(c));
  return c;
}

/** How far the creature reaches from its centre, in body units. */
export function extent(c: Creature): number {
  let e = 0;
  for (const [x, y] of c.body.pts) e = Math.max(e, Math.abs(x), Math.abs(y));
  for (const l of c.body.lobes) e = Math.max(e, Math.abs(l.x) + l.r, Math.abs(l.y) + l.r);
  for (const p of c.parts) {
    // Bent limbs and fins never reach past their length from the anchor (plus a claw).
    const r = p.len + (p.kind === 'crest' || p.kind === 'fin' ? 0 : p.w) + (p.kind === 'limb' ? 0.06 : 0);
    e = Math.max(e, Math.abs(p.x) + r, Math.abs(p.y) + r);
  }
  return e;
}

// ---- animation ------------------------------------------------------------------

/** The pose at time t (seconds). The single place for animation (#81); for now, only a slow breath. */
export function poseAt(c: Creature, t: number): Pose {
  return { breath: Math.sin((t * Math.PI * 2) / (3.2 + (c.seed % 7) * 0.15)), blink: 0 };
}

// ---- drawing ----------------------------------------------------------------------

const rgba = (color: number, a: number) => {
  const [r, g, b] = FACTION_RGB[color] ?? FACTION_RGB[0];
  return `rgba(${r},${g},${b},${a})`;
};

const BACK: ReadonlySet<PartKind> = new Set(['limb', 'tendril', 'fin', 'spike', 'horn', 'mandible', 'crest']);

/**
 * Draw a creature centred at (cx, cy), `size` pixels across. Plain paths in
 * absolute coordinates (no canvas transforms), so it composes with any caller.
 */
export function drawCreature(g: CanvasRenderingContext2D, c: Creature, cx: number, cy: number, size: number, pose: Pose = REST): void {
  const hex: string = FACTION_HEX[c.color] ?? FACTION_HEX[0];
  const k = (size / 2) * c.fit * (1 + 0.025 * pose.breath);
  const X = (x: number) => cx + x * k;
  const Y = (y: number) => cy + y * k;
  const lw = Math.max(1, size * 0.022);
  const glow = size * (0.035 + 0.015 * c.tier);

  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (c.traits.wounded) g.globalAlpha = 0.62;
  const stroke = (width = lw, color = hex) => {
    g.lineWidth = width;
    g.strokeStyle = color;
    g.shadowColor = hex;
    g.shadowBlur = glow;
    g.stroke();
    g.shadowBlur = 0;
  };
  const fill = (color: string) => {
    g.fillStyle = color;
    g.fill();
  };

  const posed = (p: Part, i: number) => {
    const pp = pose.parts?.[i];
    return { x: p.x + (pp?.dx ?? 0), y: p.y + (pp?.dy ?? 0), a: p.a + (pp?.da ?? 0), len: p.len * (pp?.ds ?? 1) };
  };
  const drawPart = (p: Part, i: number) => {
    const { x, y, a, len } = posed(p, i);
    const s = p.side || 1;
    const dx = Math.cos(a), dy = Math.sin(a);
    g.beginPath();
    switch (p.kind) {
      case 'limb': {
        const kx = x + dx * len * 0.55, ky = y + dy * len * 0.55;
        const b = a + 0.9 * s;
        const fx = kx + Math.cos(b) * len * 0.45, fy = ky + Math.sin(b) * len * 0.45;
        g.moveTo(X(x), Y(y));
        g.lineTo(X(kx), Y(ky));
        g.lineTo(X(fx), Y(fy));
        g.lineTo(X(fx + Math.cos(b - 0.9 * s) * 0.06), Y(fy + Math.sin(b - 0.9 * s) * 0.06));
        stroke();
        return;
      }
      case 'tendril': {
        const p1 = a + 0.6 * s, p2 = a - 0.6 * s;
        const ex = x + dx * len, ey = y + dy * len;
        g.moveTo(X(x), Y(y));
        g.bezierCurveTo(X(x + Math.cos(p1) * len * 0.45), Y(y + Math.sin(p1) * len * 0.45), X(x + Math.cos(p2) * len * 0.75), Y(y + Math.sin(p2) * len * 0.75), X(ex), Y(ey));
        stroke();
        g.beginPath();
        g.arc(X(ex), Y(ey), lw * 0.9, 0, Math.PI * 2);
        fill(hex);
        return;
      }
      case 'fin': {
        const b = a - p.w * s;
        g.moveTo(X(x), Y(y));
        g.lineTo(X(x + dx * len), Y(y + dy * len));
        g.lineTo(X(x + Math.cos(b) * len * 0.5), Y(y + Math.sin(b) * len * 0.5));
        g.closePath();
        fill(rgba(c.color, 0.22));
        stroke();
        return;
      }
      case 'spike':
      case 'horn': {
        const nx = -dy * p.w * 0.5, ny = dx * p.w * 0.5;
        const tx = x + dx * len, ty = y + dy * len;
        // Horns curl toward the head's centre line.
        const bend = p.kind === 'horn' ? -0.35 * s : 0;
        const mx = x + Math.cos(a + bend) * len * 0.6, my = y + Math.sin(a + bend) * len * 0.6;
        g.moveTo(X(x - nx), Y(y - ny));
        g.quadraticCurveTo(X(mx - nx * 0.5), Y(my - ny * 0.5), X(tx), Y(ty));
        g.quadraticCurveTo(X(mx + nx * 0.5), Y(my + ny * 0.5), X(x + nx), Y(y + ny));
        g.closePath();
        fill(rgba(c.color, 0.45));
        stroke();
        return;
      }
      case 'mandible': {
        const tx = x + dx * len, ty = y + dy * len;
        g.moveTo(X(x), Y(y));
        g.quadraticCurveTo(X(x + dx * len * 0.5 + 0.08 * s), Y(y + dy * len * 0.5), X(tx - 0.07 * s), Y(ty));
        stroke(lw * 1.6);
        return;
      }
      case 'crest': {
        for (let r = 0; r < p.w; r++) {
          const b = a + ((r / (p.w - 1)) - 0.5) * 1.3;
          g.moveTo(X(x), Y(y));
          g.lineTo(X(x + Math.cos(b) * len), Y(y + Math.sin(b) * len));
        }
        stroke();
        return;
      }
      case 'plate': {
        g.moveTo(X(x - len), Y(y + 0.03));
        g.quadraticCurveTo(X(x), Y(y - 0.1), X(x + len), Y(y + 0.03));
        stroke(lw * 0.9, rgba(c.color, 0.75));
        return;
      }
      case 'pauldron': {
        g.arc(X(x), Y(y), p.w * k, a - Math.PI / 2, a + Math.PI / 2);
        g.closePath();
        fill(rgba(c.color, 0.3));
        stroke();
        return;
      }
      case 'spot':
        g.arc(X(x), Y(y), p.w * k, 0, Math.PI * 2);
        fill(rgba(c.color, 0.4));
        return;
      case 'sac':
        g.arc(X(x), Y(y), p.w * k, 0, Math.PI * 2);
        fill(rgba(c.color, 0.5));
        stroke(lw, '#fff');
        return;
      case 'scar': {
        const hx = (dx * len) / 2, hy = (dy * len) / 2;
        g.moveTo(X(x - hx), Y(y - hy));
        g.lineTo(X(x + hx), Y(y + hy));
        for (let j = -1; j <= 1; j++) {
          const sx = x + hx * j * 0.6, sy = y + hy * j * 0.6;
          g.moveTo(X(sx + dy * 0.05), Y(sy - dx * 0.05));
          g.lineTo(X(sx - dy * 0.05), Y(sy + dx * 0.05));
        }
        stroke(lw, '#e6eaff');
        return;
      }
      case 'eye': {
        const ry = Math.max(0.08, 1 - pose.blink);
        g.ellipse(X(x), Y(y), p.w * k, p.w * k * ry, 0, 0, Math.PI * 2);
        fill(hex);
        g.shadowBlur = 0;
        g.beginPath();
        g.ellipse(X(x), Y(y), p.w * k * 0.45, p.w * k * 0.45 * ry, 0, 0, Math.PI * 2);
        fill('#fff');
        return;
      }
    }
  };

  const bodyPath = () => {
    const pts = c.body.pts;
    g.beginPath();
    const mid = (i: number) => {
      const [x0, y0] = pts[i % pts.length], [x1, y1] = pts[(i + 1) % pts.length];
      return [(x0 + x1) / 2, (y0 + y1) / 2];
    };
    const [sx, sy] = mid(0);
    g.moveTo(X(sx), Y(sy));
    for (let i = 1; i <= pts.length; i++) {
      const [px, py] = pts[i % pts.length];
      const [mx, my] = mid(i);
      g.quadraticCurveTo(X(px), Y(py), X(mx), Y(my));
    }
    g.closePath();
  };

  c.parts.forEach((p, i) => BACK.has(p.kind) && drawPart(p, i));
  for (const l of c.body.lobes) {
    g.beginPath();
    g.arc(X(l.x), Y(l.y), l.r * k, 0, Math.PI * 2);
    fill('#0a0c18');
    fill(rgba(c.color, 0.18));
    stroke();
  }
  bodyPath();
  fill('#0a0c18');
  fill(rgba(c.color, 0.16));
  stroke(lw * 1.3);

  if (c.pattern === 'stripes' || c.pattern === 'rings') {
    g.save();
    bodyPath();
    g.clip();
    g.beginPath();
    const { rx, ry } = c.body;
    if (c.pattern === 'stripes') {
      for (let y = -ry * 0.2; y < ry; y += ry * 0.28) {
        g.moveTo(X(-rx), Y(y + 0.05));
        g.quadraticCurveTo(X(0), Y(y - 0.06), X(rx), Y(y + 0.05));
      }
    } else {
      for (const r of [0.62, 0.32]) g.ellipse(X(0), Y(ry * 0.1), rx * r * k, ry * r * k, 0, 0, Math.PI * 2);
    }
    g.lineWidth = lw * 0.8;
    g.strokeStyle = rgba(c.color, 0.3);
    g.stroke();
    g.restore();
  }
  c.parts.forEach((p, i) => !BACK.has(p.kind) && drawPart(p, i));
  g.restore();
}

// ---- DOM helpers -------------------------------------------------------------------

const live = new Map<HTMLCanvasElement, { c: Creature; born: number; seen: boolean }>();
let looping = false;

function paint(cv: HTMLCanvasElement, c: Creature, pose: Pose): void {
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, cv.width, cv.height);
  drawCreature(g, c, cv.width / 2, cv.height / 2, cv.width, pose);
}

/** A portrait canvas `px` CSS pixels across. `animate` puts it on the shared idle loop. */
export function creatureCanvas(c: Creature, px: number, animate = false): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = document.createElement('canvas');
  cv.className = 'creature';
  cv.width = cv.height = Math.round(px * dpr);
  cv.style.width = cv.style.height = `${px}px`;
  paint(cv, c, REST);
  if (animate) animatePortraits(cv, c);
  return cv;
}

/** Fill every `[data-creature=i]` slot under `root` with a portrait of `list[i]`. */
export function mountCreatures(root: ParentNode, list: Creature[], px: number, animate = false): void {
  for (const slot of root.querySelectorAll<HTMLElement>('[data-creature]')) {
    const c = list[Number(slot.dataset.creature)];
    if (c) slot.replaceChildren(creatureCanvas(c, px, animate));
  }
}

/**
 * Keep a portrait moving through `poseAt` on one shared rAF loop. A canvas
 * drops off once it leaves the DOM (or never joins it within a few seconds).
 */
export function animatePortraits(cv: HTMLCanvasElement, c: Creature): void {
  live.set(cv, { c, born: performance.now(), seen: false });
  if (looping) return;
  looping = true;
  const frame = (now: number) => {
    for (const [cv, s] of live) {
      if (cv.isConnected) s.seen = true;
      else if (s.seen || now - s.born > 3000) {
        live.delete(cv);
        continue;
      }
      if (s.seen) paint(cv, s.c, poseAt(s.c, now / 1000));
    }
    if (live.size) requestAnimationFrame(frame);
    else looping = false;
  };
  requestAnimationFrame(frame);
}
