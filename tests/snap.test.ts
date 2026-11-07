import { describe, expect, it } from 'vitest';
import { snapNest } from '../src/input/snap';

describe('tap snapping (#115)', () => {
  const a = { x: 0, y: 0, r: 20 }, b = { x: 200, y: 0, r: 20 };
  it('snaps a tap just past a nest’s rim, not one further out', () => {
    // Rim at 25 (r x 1.25); pad 24.
    expect(snapNest([a], 45, 0, 24)).toBe(a);
    expect(snapNest([a], 65, 0, 24)).toBeNull();
  });
  it('picks the nearer of two nests', () => {
    expect(snapNest([a, b], 140, 0, 60)).toBe(b);
    expect(snapNest([a, b], 60, 0, 60)).toBe(a);
  });
});
