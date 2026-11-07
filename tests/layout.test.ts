import { describe, expect, it } from 'vitest';
import { isShortWide } from '../src/ui/mobile';

describe('landscape layout detection (#113)', () => {
  it.each([
    [812, 375, true], // iPhone X-class sideways
    [667, 375, true], // iPhone 8 sideways
    [915, 412, true], // Android sideways
    [375, 812, false], // upright
    [1024, 600, false], // small tablet sideways: tall enough for the normal layout
    [1180, 820, false], // tablet
    [1440, 900, false], // desktop
    [600, 500, false], // short but not wide (a foldable's inner screen)
  ])('%i×%i → %s', (w, h, want) => {
    expect(isShortWide(w, h)).toBe(want);
  });
});
