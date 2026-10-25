import { capsuleDist, rockGrid, sampleRock, type Capsule, type TerrainSpec } from '../sim/terrain';

/** World px per texel of the baked terrain texture. */
export const TEX_SCALE = 4;

// Distance encodings (px), shared with BG_FS.
const WALL_LO = -24, WALL_SPAN = 64;
const RIFT_LO = -16, RIFT_SPAN = 32;

/**
 * Bake terrain into an RGBA8 texture once per match. R = wall signed
 * distance, G = nebula density, B = rift signed distance. Unions of
 * overlapping capsules come out right because distances are min-combined.
 */
export function bakeTerrain(spec: TerrainSpec, width: number, height: number): { data: Uint8Array; tw: number; th: number } {
  const tw = Math.ceil(width / TEX_SCALE) + 1, th = Math.ceil(height / TEX_SCALE) + 1;
  const n = tw * th;
  const wall = new Float32Array(n).fill(WALL_LO + WALL_SPAN);
  const rift = new Float32Array(n).fill(RIFT_LO + RIFT_SPAN);
  const neb = new Float32Array(n);

  const each = (c: Capsule, pad: number, fn: (k: number, d: number) => void) => {
    const x0 = Math.max(0, Math.floor((Math.min(c.x1, c.x2) - c.r - pad) / TEX_SCALE));
    const x1 = Math.min(tw - 1, Math.ceil((Math.max(c.x1, c.x2) + c.r + pad) / TEX_SCALE));
    const y0 = Math.max(0, Math.floor((Math.min(c.y1, c.y2) - c.r - pad) / TEX_SCALE));
    const y1 = Math.min(th - 1, Math.ceil((Math.max(c.y1, c.y2) + c.r + pad) / TEX_SCALE));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) fn(y * tw + x, capsuleDist(c, x * TEX_SCALE, y * TEX_SCALE));
    }
  };
  for (const c of spec.walls) each(c, WALL_LO + WALL_SPAN, (k, d) => (wall[k] = Math.min(wall[k], d)));
  if (spec.cave) {
    // Cave rock uses the same channel, so it gets the same rock look.
    const g = rockGrid(spec.cave, width, height);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const k = y * tw + x;
        wall[k] = Math.min(wall[k], sampleRock(g, x * TEX_SCALE, y * TEX_SCALE));
      }
    }
  }
  for (const f of spec.fields) {
    if (f.kind === 'rift') each(f, RIFT_LO + RIFT_SPAN, (k, d) => (rift[k] = Math.min(rift[k], d)));
    else {
      each(f, 24, (k, d) => {
        // Soft cloud edge: full inside, fading out a little past the rim.
        const t = Math.min(1, Math.max(0, (18 - d) / 40));
        neb[k] = Math.max(neb[k], t * t * (3 - 2 * t));
      });
    }
  }

  const data = new Uint8Array(n * 4);
  const enc = (v: number, lo: number, span: number) => Math.round(Math.min(1, Math.max(0, (v - lo) / span)) * 255);
  for (let k = 0; k < n; k++) {
    data[k * 4] = enc(wall[k], WALL_LO, WALL_SPAN);
    data[k * 4 + 1] = Math.round(neb[k] * 255);
    data[k * 4 + 2] = enc(rift[k], RIFT_LO, RIFT_SPAN);
    data[k * 4 + 3] = 255;
  }
  return { data, tw, th };
}
