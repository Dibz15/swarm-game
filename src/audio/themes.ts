/**
 * Musical themes for the generative score. A theme is a key, a mode, a tempo
 * and a set of progressions written as scale degrees, so the same engine plays
 * any of them. The instruments, layers and mood logic stay shared, which is
 * what keeps every theme sounding like SWARM.
 *
 * Mood rule (checked by tests): calm moves every 2 bars, drive every bar, and
 * tense brings in a colour chord calm never uses, so a mood switch still tells
 * the player something.
 */

import type { Voicing } from './styles';

export type Mood = 'calm' | 'tense' | 'drive';

export interface Theme {
  id: string;
  name: string;
  /** semitones from A (220 Hz), kept within -5..+6 so registers stay put */
  root: number;
  /** the mode: 7 semitone steps from the root */
  scale: number[];
  /** indices into `scale` that melodies and battle blips draw from */
  lead: number[];
  bpm: number;
  /**
   * Chords as scale degrees (1-7). Suffixes: M forces a major triad, m minor,
   * s sus4. Without one, the triad is stacked in thirds inside the mode.
   */
  prog: Record<Mood, { chords: string[]; bars: number }>;
  /** arpeggio walk over chord tones (3 = root an octave up); overrides the style's */
  arp?: number[];
  /** how it's played (styles.ts); default 'pulse' */
  style?: string;
}

const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
};

export const THEMES: Theme[] = [
  {
    id: 'classic',
    name: 'Classic (A minor)',
    root: 0,
    scale: MODES.aeolian,
    lead: [0, 2, 3, 4, 6],
    bpm: 88,
    prog: {
      calm: { chords: ['1', '6', '3', '7'], bars: 2 },
      tense: { chords: ['1', '6', '4', '5M'], bars: 2 },
      drive: { chords: ['1', '7', '6', '5M'], bars: 1 },
    },
  },
  {
    id: 'c-dorian',
    name: 'Tidewater (C dorian)',
    root: 3,
    scale: MODES.dorian,
    lead: [0, 2, 3, 4, 5],
    bpm: 92,
    prog: {
      calm: { chords: ['1', '4', '3', '7'], bars: 2 },
      tense: { chords: ['1', '7', '2', '5M'], bars: 2 },
      drive: { chords: ['1', '4', '7', '5M'], bars: 1 },
    },
    arp: [0, 2, 1, 3, 0, 2, 1, 2],
  },
  {
    id: 'e-phrygian',
    name: 'Obsidian (E phrygian)',
    root: -5,
    scale: MODES.phrygian,
    lead: [0, 1, 2, 4, 5],
    bpm: 84,
    style: 'ritual',
    prog: {
      calm: { chords: ['1', '2', '1', '7'], bars: 2 },
      tense: { chords: ['1', '4', '2', '5M'], bars: 2 },
      drive: { chords: ['1', '2', '7', '2'], bars: 1 },
    },
  },
  {
    id: 'b-harmonic',
    name: 'Venom (B harmonic minor)',
    root: 2,
    scale: MODES.harmonic,
    lead: [0, 2, 3, 4, 5],
    bpm: 88,
    style: 'waltz',
    prog: {
      calm: { chords: ['1', '6', '4', '5m'], bars: 2 },
      tense: { chords: ['1', '4', '6', '5'], bars: 2 },
      drive: { chords: ['1', '4', '6', '5'], bars: 1 },
    },
  },
  {
    id: 'd-major',
    name: 'Daybreak (D major)',
    root: 5,
    scale: MODES.ionian,
    lead: [0, 1, 2, 4, 5],
    bpm: 96,
    prog: {
      calm: { chords: ['1', '5', '6', '4'], bars: 2 },
      tense: { chords: ['6', '4', '2', '3M'], bars: 2 },
      drive: { chords: ['6', '4', '5', '3M'], bars: 1 },
    },
  },
  {
    id: 'f-lydian',
    name: 'Drift (F lydian)',
    root: -4,
    scale: MODES.lydian,
    lead: [0, 1, 2, 3, 4, 5],
    bpm: 86,
    style: 'glide',
    prog: {
      calm: { chords: ['1', '2', '3', '2'], bars: 2 },
      tense: { chords: ['6', '2', '4', '3M'], bars: 2 },
      drive: { chords: ['1', '2', '6', '3M'], bars: 1 },
    },
  },
  {
    id: 'd-mixolydian',
    name: 'Vanguard (D mixolydian)',
    root: 5,
    scale: MODES.mixolydian,
    lead: [0, 1, 2, 4, 6],
    bpm: 100,
    style: 'motorik',
    prog: {
      calm: { chords: ['1', '7', '4', '1'], bars: 2 },
      tense: { chords: ['1', '5', '7', '5M'], bars: 2 },
      drive: { chords: ['1', '7', '4', '7'], bars: 1 },
    },
  },
  {
    id: 'fs-aeolian',
    name: 'Hollow (F# minor, open)',
    root: -3,
    scale: MODES.aeolian,
    lead: [0, 2, 3, 4, 6],
    bpm: 80,
    prog: {
      calm: { chords: ['1s', '6', '3', '7s'], bars: 2 },
      tense: { chords: ['1', '6', '4s', '5M'], bars: 2 },
      drive: { chords: ['1', '7', '6', '5M'], bars: 1 },
    },
    arp: [0, 2, 3, 2, 0, 2, 3, 1],
  },
  {
    id: 'bb-lydian',
    name: 'Expanse (B♭ lydian)',
    root: 1,
    scale: MODES.lydian,
    lead: [0, 1, 2, 3, 4],
    bpm: 84,
    prog: {
      calm: { chords: ['1', '2', '1', '5'], bars: 2 },
      tense: { chords: ['6', '3', '4', '2'], bars: 2 },
      drive: { chords: ['6', '2', '4', '3M'], bars: 1 },
    },
  },
  {
    id: 'e-dorian',
    name: 'Riptide (E dorian)',
    root: -5,
    scale: MODES.dorian,
    lead: [0, 2, 3, 4, 5],
    bpm: 94,
    prog: {
      calm: { chords: ['1', '4', '1', '7'], bars: 2 },
      tense: { chords: ['1', '3', '4', '5M'], bars: 2 },
      drive: { chords: ['1', '7', '4', '5M'], bars: 1 },
    },
    arp: [0, 1, 2, 3, 0, 1, 2, 1],
  },
];

export const CLASSIC = THEMES[0];

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** Same seed, same theme. Kept apart from the sim's rng. */
export function themeForSeed(seed: number): Theme {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return THEMES[h % THEMES.length];
}

/** Semitone of scale step `i` (0-based, any octave) from the root. */
export function step(theme: Theme, i: number): number {
  const n = theme.scale.length;
  const oct = Math.floor(i / n);
  return theme.scale[i - oct * n] + 12 * oct;
}

/**
 * A chord symbol as semitones from the root. Chords on high degrees drop an
 * octave so every chord sits in the same register (VI, VII under I).
 */
export function chord(theme: Theme, sym: string): number[] {
  const m = /^([1-7])([Mms]?)$/.exec(sym);
  if (!m) throw new Error(`bad chord ${sym}`);
  const d = Number(m[1]) - 1;
  const r = step(theme, d);
  let tones: number[];
  if (m[2] === 'M') tones = [r, r + 4, r + 7];
  else if (m[2] === 'm') tones = [r, r + 3, r + 7];
  else if (m[2] === 's') tones = [r, r + 5, r + 7];
  else tones = [r, step(theme, d + 2), step(theme, d + 4)];
  return r > 7 ? tones.map((s) => s - 12) : tones;
}

/**
 * A chord voiced for the pad (and walked by the arpeggio): open drops the
 * third for a bare fifth and octave; seventh and add9 stack one more note.
 */
export function voiced(theme: Theme, sym: string, voicing: Voicing): number[] {
  const tones = chord(theme, sym);
  const r = tones[0];
  if (voicing === 'open') return [r, r + 7, r + 12];
  if (voicing === 'add9') return [...tones, r + 14];
  if (voicing === 'seventh') {
    // Plain degrees take the mode's own seventh; forced chords a minor seventh.
    const d = Number(sym[0]) - 1;
    const seventh = sym.length === 1 ? step(theme, d + 6) - step(theme, d) : 10;
    return [...tones, r + seventh];
  }
  return tones;
}

/** Lead notes as semitones from the root, one octave. */
export function leadNotes(theme: Theme): number[] {
  return theme.lead.map((i) => theme.scale[i]);
}

const AEOLIAN = MODES.aeolian;

/**
 * Effects were written in A minor. Map one of those semitones into a theme:
 * a scale note moves to the same degree of the theme's mode, a chromatic note
 * keeps its distance from the root. Classic maps to itself.
 */
export function mapSemi(theme: Theme, s: number): number {
  const oct = Math.floor(s / 12);
  const pc = s - oct * 12;
  const i = AEOLIAN.indexOf(pc);
  return theme.root + 12 * oct + (i >= 0 ? theme.scale[i] : pc);
}
