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
