import { describe, expect, it } from 'vitest';
import { STYLES, hits, notes, phrase, styleOf } from '../src/audio/styles';
import { THEMES, leadNotes, themeById, voiced } from '../src/audio/themes';

const seeded = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe('music styles', () => {
  it.each(Object.values(STYLES).map((s) => [s.id, s] as const))('%s patterns fit its meter', (_id, s) => {
    expect([12, 16]).toContain(s.steps);
    const d = s.drums;
    for (const p of [d.kick, d.snare, d.hat, d.tom, d.tom2, ...Object.values(d.busy)]) if (p) expect(p).toHaveLength(s.steps);
    if (s.bass.calm !== 'hold') expect(s.bass.calm).toHaveLength(s.steps);
    expect(s.bass.fight).toHaveLength(s.steps);
    if (s.lead.form === 'motif') expect(s.lead.rhythms.length).toBeGreaterThan(0);
    for (const r of s.lead.rhythms) {
      expect(r).toHaveLength(s.steps);
      expect(r[0]).toBe('x');
    }
    expect(s.arp.rate).toBeLessThanOrEqual(4); // may cross the bar line: glide plays dotted 8ths over 4/4
    expect(s.steps % s.arp.fast).toBe(0);
    expect(s.swing).toBeGreaterThanOrEqual(0);
    expect(s.swing).toBeLessThan(0.5);
  });

  it('every theme names a style, with echoes that fit the delay line', () => {
    for (const t of THEMES) {
      expect(STYLES[t.style ?? 'pulse']).toBeDefined();
      const s = styleOf(t.style);
      expect((60 / t.bpm / 4) * s.arp.echo).toBeLessThan(2);
    }
  });

  it('has at least four styles beyond pulse, and a triple meter', () => {
    const used = new Set(THEMES.map((t) => t.style ?? 'pulse'));
    expect(used.size).toBeGreaterThanOrEqual(5);
    expect(Object.values(STYLES).some((s) => s.steps === 12)).toBe(true);
  });

  it('reads pattern strings', () => {
    expect(hits('X.x.o...')).toEqual([[0, 1.6], [2, 1], [4, 0.5]]);
    expect(notes('R-.5O---')).toEqual([[0, 'R', 2], [3, '5', 1], [4, 'O', 4]]);
  });

  it('voices chords: open fifths, lydian major seventh, add9', () => {
    const lyd = themeById('f-lydian')!;
    expect(voiced(lyd, '1', 'seventh')).toEqual([0, 4, 7, 11]);
    expect(voiced(lyd, '1', 'open')).toEqual([0, 7, 12]);
    expect(voiced(lyd, '1', 'add9')).toEqual([0, 4, 7, 14]);
    expect(voiced(lyd, '1', 'triad')).toEqual([0, 4, 7]);
  });

  it('pulse keeps the original random-walk lead: quarter notes, rests, no breath', () => {
    const s = STYLES.pulse;
    expect(s.lead.form).toBe('walk');
    expect(s.lead.breath).toBe(0);
    for (let seed = 1; seed < 40; seed++) {
      const p = phrase(s, 5, seeded(seed));
      for (const n of p) {
        expect(n.at % 4).toBe(0);
        expect(n.len).toBe(4);
        expect(Math.floor(n.at / 4) % 8).not.toBe(7); // the last beat of every second bar rests
        expect(n.idx).toBeGreaterThanOrEqual(0);
        expect(n.idx).toBeLessThan(10);
      }
      for (let k = 1; k < p.length; k++) expect(Math.abs(p[k].idx - p[k - 1].idx)).toBeLessThanOrEqual(2);
    }
  });

  it.each(Object.values(STYLES).filter((s) => s.lead.form === 'motif').map((s) => [s.id, s] as const))('%s phrases repeat a motif and resolve home', (_id, s) => {
    for (let seed = 1; seed < 40; seed++) {
      const lead = 5;
      const p = phrase(s, lead, seeded(seed));
      const inBar = (k: number) => p.filter((n) => Math.floor(n.at / s.steps) === k);
      // Bar 4 restates the motif (cut short for the closing note when the style breathes).
      const first = inBar(0).map((n) => n.at);
      const fourth = inBar(3).map((n) => n.at - 3 * s.steps);
      if (s.lead.breath > 0) expect(first.slice(0, fourth.length)).toEqual(fourth);
      else expect(fourth).toEqual(first);
      expect(inBar(0)[0].at).toBe(0);
      // A style that breathes lets its last note ring to the end of the phrase.
      if (s.lead.breath > 0) {
        // The phrase lands on the bar line: a closing tonic of at least a half
        // note, ending exactly where the rest begins.
        const last = p[p.length - 1];
        expect(last.final).toBe(true);
        expect(last.at + last.len).toBe(4 * s.steps);
        expect(last.len).toBeGreaterThanOrEqual(8);
        expect(last.idx % lead).toBe(0);
        expect(p.filter((n) => n.final)).toHaveLength(1);
      }
      // Ritual and waltz sing in quarter notes: onsets on the beat, quarters or longer.
      if (s.id === 'ritual' || s.id === 'waltz') for (const n of p) expect([n.at % 4, n.len >= 4]).toEqual([0, true]);
      for (const n of p) {
        expect(n.idx).toBeGreaterThanOrEqual(0);
        expect(n.idx).toBeLessThan(lead * 2);
        expect(n.at + n.len).toBeLessThanOrEqual(4 * s.steps);
      }
    }
  });

  it('lead notes stay inside each theme scale', () => {
    for (const t of THEMES) for (const n of leadNotes(t)) expect(t.scale).toContain(n);
  });
});
