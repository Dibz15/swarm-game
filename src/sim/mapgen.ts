import { NestType } from './constants';
import { PI, TAU, dcos, dsin } from './mathx';
import { Rng } from './rng';

export type MapSize = 'small' | 'medium' | 'large';

export const MAP_SIZES: Record<MapSize, { w: number; h: number; perSector: number }> = {
  small: { w: 1300, h: 820, perSector: 3 },
  medium: { w: 1650, h: 1040, perSector: 4 },
  large: { w: 2100, h: 1320, perSector: 5 },
};

export interface NestSpec {
  x: number;
  y: number;
  type: number;
  level: number;
  /** player index (into MatchSetup.players), or -1 for neutral */
  player: number;
  garrison: number;
}

export interface MapSpec {
  width: number;
  height: number;
  nests: NestSpec[];
}

const TYPE_WEIGHTS: [number, number][] = [
  [NestType.Hive, 34],
  [NestType.Forge, 17],
  [NestType.Spire, 17],
  [NestType.Swift, 17],
  [NestType.Bastion, 15],
];

function pickType(rng: Rng): number {
  let total = 0;
  for (const [, wt] of TYPE_WEIGHTS) total += wt;
  let r = rng.next() * total;
  for (const [t, wt] of TYPE_WEIGHTS) {
    r -= wt;
    if (r < 0) return t;
  }
  return NestType.Hive;
}

/**
 * Rotationally symmetric map: nests are generated in player 0's sector and
 * copied into every other sector, so each start has the same options.
 */
export function generateMap(seed: number, size: MapSize, players: number, portrait = false): MapSpec {
  const rng = new Rng(seed ^ 0xa5a5a5);
  const dims = MAP_SIZES[size];
  const perSector = dims.perSector;
  // Tall screens get a tall map with the player starting at the bottom.
  const w = portrait ? dims.h : dims.w;
  const h = portrait ? dims.w : dims.h;
  const P = Math.max(2, players);
  const cx = w / 2, cy = h / 2;
  const ax = w * 0.5 * 0.88, ay = h * 0.5 * 0.84;
  const sector = TAU / P;
  const base = portrait ? PI / 2 : PI; // player 0 starts bottom / left
  const pos = (r: number, a: number): [number, number] => [cx + dcos(a) * r * ax, cy + dsin(a) * r * ay];

  const nests: NestSpec[] = [];
  for (let k = 0; k < P; k++) {
    const [x, y] = pos(0.86, base + k * sector);
    nests.push({ x, y, type: NestType.Hive, level: 1, player: k < players ? k : -1, garrison: k < players ? 0 : 8 });
  }
  nests.push({ x: cx, y: cy, type: NestType.Hive, level: 2, player: -1, garrison: 14 + P * 2 });

  const minDist = size === 'small' ? 100 : 110;
  const fits = (r: number, da: number) => {
    for (let k = 0; k < P; k++) {
      const [x, y] = pos(r, base + da + k * sector);
      if (x < 60 || x > w - 60 || y < 60 || y > h - 60) return false;
      for (const n of nests) {
        if ((n.x - x) ** 2 + (n.y - y) ** 2 < minDist * minDist) return false;
      }
    }
    return true;
  };
  const place = (r: number, da: number, type: number, level: number, garrison: number) => {
    for (let k = 0; k < P; k++) {
      const [x, y] = pos(r, base + da + k * sector);
      nests.push({ x, y, type, level, player: -1, garrison });
    }
  };

  // A cheap "natural expansion" right next to each start.
  for (let tries = 0; tries < 40; tries++) {
    const da = (rng.next() < 0.5 ? -1 : 1) * rng.range(0.12, 0.28) * sector;
    const r = rng.range(0.55, 0.68);
    if (fits(r, da)) {
      place(r, da, NestType.Hive, 1, 4);
      break;
    }
  }

  let placed = 1;
  for (let tries = 0; tries < 400 && placed < perSector; tries++) {
    const r = rng.range(0.28, 1.0);
    const da = rng.range(-0.46, 0.46) * sector;
    if (!fits(r, da)) continue;
    const type = pickType(rng);
    const level = rng.next() < 0.15 ? 2 : 1;
    let g = Math.round(4 + (1 - r) * 9 + rng.int(4) + (level - 1) * 6);
    if (type === NestType.Bastion) g = Math.round(g * 0.6);
    if (type === NestType.Forge) g += 2;
    place(r, da, type, level, g);
    placed++;
  }

  return { width: w, height: h, nests };
}
