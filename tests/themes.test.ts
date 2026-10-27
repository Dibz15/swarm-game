import { describe, expect, it } from 'vitest';
import { CLASSIC, THEMES, chord, leadNotes, mapSemi, themeById, themeForSeed } from '../src/audio/themes';

describe('music themes', () => {
  it('has at least 8 themes with unique ids, including major-side modes', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    const major = (s: number[]) => s[2] === 4;
    expect(THEMES.filter((t) => major(t.scale)).length).toBeGreaterThanOrEqual(3);
    expect(THEMES.some((t) => t.scale[3] === 6 || (major(t.scale) && t.scale[6] === 10))).toBe(true); // lydian or mixolydian
  });

  it.each(THEMES.map((t) => [t.id, t] as const))('%s keeps the shared rules', (_id, t) => {
    expect(t.root).toBeGreaterThanOrEqual(-5);
    expect(t.root).toBeLessThanOrEqual(6);
    expect(t.bpm).toBeGreaterThanOrEqual(80);
    expect(t.bpm).toBeLessThanOrEqual(100);
    expect(t.scale).toHaveLength(7);
    // Mood rule: calm moves every 2 bars, drive every bar, tense adds a colour chord.
    expect(t.prog.calm.bars).toBe(2);
    expect(t.prog.drive.bars).toBe(1);
    expect(t.prog.tense.chords.some((c) => !t.prog.calm.chords.includes(c))).toBe(true);
    for (const mood of ['calm', 'tense', 'drive'] as const) {
      expect(t.prog[mood].chords.length).toBeGreaterThan(0);
      for (const c of t.prog[mood].chords) {
        const tones = chord(t, c);
        expect(tones).toHaveLength(3);
        // Every chord sits in one register.
        expect(tones[0]).toBeGreaterThanOrEqual(-5);
        expect(tones[0]).toBeLessThanOrEqual(7);
      }
    }
    for (const n of leadNotes(t)) expect(t.scale).toContain(n);
    for (const k of t.arp ?? []) expect(k).toBeLessThanOrEqual(3);
  });

  it('builds chords from scale degrees', () => {
    expect(chord(CLASSIC, '1')).toEqual([0, 3, 7]);
    expect(chord(CLASSIC, '5M')).toEqual([7, 11, 14]);
    expect(chord(CLASSIC, '1s')).toEqual([0, 5, 7]);
    const lydian = themeById('f-lydian')!;
    expect(chord(lydian, '2')).toEqual([2, 6, 9]); // the major II is lydian's colour
    expect(() => chord(CLASSIC, '8')).toThrow();
  });

  it('classic plays the original A-minor score', () => {
    const p = CLASSIC.prog;
    const am = { Am: [0, 3, 7], F: [-4, 0, 3], C: [3, 7, 10], G: [-2, 2, 5], Dm: [5, 8, 12], E: [7, 11, 14] };
    expect(p.calm.chords.map((c) => chord(CLASSIC, c))).toEqual([am.Am, am.F, am.C, am.G]);
    expect(p.tense.chords.map((c) => chord(CLASSIC, c))).toEqual([am.Am, am.F, am.Dm, am.E]);
    expect(p.drive.chords.map((c) => chord(CLASSIC, c))).toEqual([am.Am, am.G, am.F, am.E]);
    expect(leadNotes(CLASSIC)).toEqual([0, 3, 5, 7, 10]);
    expect(CLASSIC.bpm).toBe(88);
  });

  it('picks the same theme for the same seed and reaches them all', () => {
    expect(themeForSeed(12345)).toBe(themeForSeed(12345));
    const seen = new Set<string>();
    for (let s = 0; s < 1000; s++) seen.add(themeForSeed((s * 2654435761) >>> 0).id);
    expect(seen.size).toBe(THEMES.length);
  });

  it('moves A-minor effect pitches into each theme without leaving its scale', () => {
    for (const t of THEMES) {
      for (const s of [0, 2, 3, 5, 7, 8, 10, 12, 15, 19, -4, -12, -17, -24, -29]) {
        const pc = (((mapSemi(t, s) - t.root) % 12) + 12) % 12;
        expect(t.scale).toContain(pc);
      }
      // Chromatic notes keep their distance from the root.
      expect(mapSemi(t, 4)).toBe(t.root + 4);
    }
    for (let s = -24; s <= 24; s++) expect(mapSemi(CLASSIC, s)).toBe(s);
  });
});

describe('theme variety', () => {
  it('spreads themes over many different note sets, not just modes of one key', () => {
    const sets = new Set(THEMES.map((t) => t.scale.map((s) => (((s + t.root) % 12) + 12) % 12).sort((a, b) => a - b).join(',')));
    expect(sets.size).toBeGreaterThanOrEqual(7);
  });
});
