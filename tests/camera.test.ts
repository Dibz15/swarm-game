import { describe, expect, it } from 'vitest';
import { Camera } from '../src/render/camera';

/** A camera on a `mw`×`mh` map with home at (hx, hy), on a `vw`×`vh` view. */
function cam(mw: number, mh: number, vw: number, vh: number, home: [number, number] | null): Camera {
  const c = new Camera();
  c.setView(vw, vh);
  c.setMap(mw, mh, home);
  c.fit();
  return c;
}

describe('camera turns (#98)', () => {
  it('maps screen to world and back on every turn', () => {
    const c = cam(1800, 1000, 900, 1600, [200, 500]);
    for (const t of [0, 1, 2, 3]) {
      c.turn = t;
      c.focus(700, 400, c.fitZoom * 2);
      for (const [x, y] of [[0, 0], [900, 1600], [123, 456]]) {
        const [wx, wy] = c.toWorld(x, y);
        const [sx, sy] = c.toScreen(wx, wy);
        expect(sx).toBeCloseTo(x, 6);
        expect(sy).toBeCloseTo(y, 6);
      }
    }
  });

  it('lays a wide map along an upright screen and puts home at the bottom', () => {
    // Home on the map's left: it should end up at the bottom of the screen.
    const c = cam(1800, 1000, 900, 1600, [200, 500]);
    expect(c.turn % 2).toBe(1);
    const [, sy] = c.toScreen(200, 500);
    const [, my] = c.toScreen(900, 500);
    expect(sy).toBeGreaterThan(my);
  });

  it('keeps a wide map unturned on a wide screen, home on the left', () => {
    const c = cam(1800, 1000, 1600, 900, [200, 500]);
    expect(c.turn).toBe(0);
    // Home on the right turns the map round instead.
    expect(cam(1800, 1000, 1600, 900, [1600, 500]).turn).toBe(2);
  });

  it('fits the turned map in view', () => {
    const c = cam(2000, 1000, 900, 1600, [200, 500]);
    const corners = [[0, 0], [2000, 0], [0, 1000], [2000, 1000]].map(([x, y]) => c.toScreen(x, y));
    for (const [sx, sy] of corners) {
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(900);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(1600);
    }
    // ...and fills most of the screen's height with the map's long side.
    expect(c.fitZoom * 2000).toBeGreaterThan(1600 * 0.8);
  });

  it('pans with the finger on a turned view', () => {
    const c = cam(1800, 1000, 900, 1600, [200, 500]);
    c.focus(900, 500, c.fitZoom * 3);
    const [wx, wy] = c.toWorld(450, 800);
    c.pan(50, -30);
    // The world point that was under the finger moved with it.
    const [sx, sy] = c.toScreen(wx, wy);
    expect(sx).toBeCloseTo(500, 4);
    expect(sy).toBeCloseTo(770, 4);
  });
});

describe('camera side insets (#113)', () => {
  /** A landscape phone (812×375 CSS at dpr 1) with side rails. */
  const L = 130, R = 160, VW = 812, VH = 375;

  it('fits the map between the rails', () => {
    const c = cam(1800, 1000, VW, VH, [200, 500]);
    c.setInsets(0, 0, L, R);
    expect(c.fitZoom).toBeCloseTo(Math.min((VW - L - R) / 1800, VH / 1000) * 0.94, 6);
    c.fit();
    const corners = [[0, 0], [1800, 0], [0, 1000], [1800, 1000]].map(([x, y]) => c.toScreen(x, y));
    for (const [sx] of corners) {
      expect(sx).toBeGreaterThanOrEqual(L - 1e-6);
      expect(sx).toBeLessThanOrEqual(VW - R + 1e-6);
    }
    // Centred between the rails.
    const [mx] = c.toScreen(900, 500);
    expect(mx).toBeCloseTo(L + (VW - L - R) / 2, 4);
  });

  it('refits a held view when the rails appear', () => {
    const c = cam(1800, 1000, VW, VH, [200, 500]);
    const before = c.fitZoom;
    expect(c.setInsets(0, 0, L, R)).toBe(true);
    expect(c.fitZoom).toBeLessThan(before);
    const [mx] = c.toScreen(900, 500);
    expect(mx).toBeCloseTo(L + (VW - L - R) / 2, 4);
  });

  it('opens on home in the middle of the visible area, on any turn', () => {
    for (const [vw, vh, ins] of [
      [VW, VH, [0, 0, L, R]],
      [375, 812, [60, 200, 0, 0]],
    ] as const) {
      const c = cam(4000, 2400, vw, vh, [1200, 1200]);
      c.setInsets(ins[0], ins[1], ins[2], ins[3]);
      c.open(1200, 1200, 1, 0.75, 4, 4);
      const [sx, sy] = c.toScreen(1200, 1200);
      const [t, b, l, r] = ins;
      expect(sx).toBeCloseTo(l + (vw - l - r) / 2, 4);
      expect(sy).toBeCloseTo(t + (vh - t - b) / 2, 4);
    }
  });

  it('pans every edge clear of the rails', () => {
    const c = cam(1800, 1000, VW, VH, [200, 500]);
    c.setInsets(0, 0, L, R);
    c.focus(900, 500, c.fitZoom * 3);
    // Drag far right: the map's left edge stops past the left rail, not under it.
    c.pan(100000, 0);
    const [lx] = c.toScreen(0, 500);
    expect(lx).toBeGreaterThan(L);
    c.pan(-200000, 0);
    const [rx] = c.toScreen(1800, 500);
    expect(rx).toBeLessThan(VW - R);
  });
});
