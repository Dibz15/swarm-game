/**
 * Styles give a theme its character: meter, groove, bass and arpeggio
 * patterns, chord voicing, instrument settings and melody rhythms. Themes set
 * the key; styles set how it's played. The instruments' roles, the layers and
 * the mood logic stay the same in every style.
 *
 * Patterns are strings with one character per 16th note, so a bar of 4/4 is
 * 16 characters and a bar of 6/8 or 3/4 is 12.
 *   drums:   X accent, x hit, o ghost, . rest
 *   bass:    R chord root, 5 its fifth, O its octave, 3 its third, - tie, . rest
 *   melody:  x note, - tie, . rest
 */

export type Voicing = 'triad' | 'open' | 'seventh' | 'add9';
export type SnareKind = 'snare' | 'rim' | 'brush';

export interface Style {
  id: string;
  /** 16ths per bar: 16 for 4/4, 12 for 6/8 and 3/4 */
  steps: number;
  /** delay of every odd 16th, as a fraction of a 16th */
  swing: number;
  drums: {
    kick: string;
    snare: string;
    hat: string;
    /** low toms pitched on the key: root and fifth */
    tom?: string;
    tom2?: string;
    /** patterns used when the fighting is heavy; missing ones keep the base */
    busy: Partial<Record<'kick' | 'snare' | 'hat' | 'tom' | 'tom2', string>>;
    kit: {
      kick: { from: number; to: number; decay: number; vol: number };
      snare: SnareKind;
      hat: { cutoff: number; decay: number; vol: number; open?: number };
    };
  };
  bass: {
    /** at low intensity: 'hold' sustains the root for the whole chord */
    calm: 'hold' | string;
    fight: string;
    /** play the key's tonic under every chord */
    pedal?: boolean;
    type: OscillatorType;
    cutoff: [number, number];
  };
  arp: {
    /** 16ths per note, normal and when intense */
    rate: number;
    fast: number;
    /** walk over the voiced chord tones (indices past the end go up an octave) */
    pattern: number[];
    type: OscillatorType;
    octave: number;
    decay: number;
    peak: number;
    /** echo time in 16ths and its feedback */
    echo: number;
    feedback: number;
  };
  pad: { voicing: Voicing; type: OscillatorType; detune: number; cutoff: number; range: number; attack: number };
  lead: {
    type: OscillatorType;
    /** lowpass on the lead (saw/square leads need it) */
    cutoff: number;
    /** portamento from the previous note, seconds */
    glide: number;
    vibrato: number;
    /** note length as a multiple of its written length */
    length: number;
    /** one-bar rhythm cells the motifs are built from */
    rhythms: string[];
    /** chance an onset after the first becomes a rest */
    rest: number;
    /**
     * Bars of silence after each 4-bar phrase, so it can land before it
     * starts again. A quick hook can loop straight back (0); slower ones need air.
     */
    breath: number;
    /**
     * motif: a 4-bar A A' B A phrase built from the rhythm cells.
     * walk: the original SWARM lead, a free random walk in quarter notes with
     * rests, looping without a breath (rhythms and rest are unused).
     */
    form: 'motif' | 'walk';
  };
}

export const STYLES: Record<string, Style> = {
  /** The original SWARM groove: driving 8th arpeggio, kick-snare backbeat. */
  pulse: {
    id: 'pulse',
    steps: 16,
    swing: 0,
    drums: {
      kick: 'x.......x.......',
      snare: '....x.......x...',
      hat: 'x.X.x.X.x.X.x.X.',
      busy: { kick: 'x.......x.x.....', hat: 'xoXoxoXoxoXoxoXo' },
      kit: { kick: { from: 110, to: 42, decay: 0.35, vol: 0.32 }, snare: 'snare', hat: { cutoff: 7500, decay: 0.04, vol: 0.03 } },
    },
    bass: { calm: 'hold', fight: 'R-.R-.R-R-.R-.R-', type: 'sawtooth', cutoff: [900, 220] },
    arp: { rate: 2, fast: 1, pattern: [0, 1, 2, 3, 2, 1, 0, 2], type: 'triangle', octave: 12, decay: 0.22, peak: 0.085, echo: 3, feedback: 0.35 },
    pad: { voicing: 'triad', type: 'sawtooth', detune: 8, cutoff: 700, range: 1600, attack: 1.4 },
    lead: { type: 'sine', cutoff: 8000, glide: 0, vibrato: 0.006, length: 1.5, rhythms: [], rest: 0.45, breath: 0, form: 'walk' },
  },

  /** 6/8 and tribal: pitched toms, a drone under open fifths, a sliding chant. */
  ritual: {
    id: 'ritual',
    steps: 12,
    swing: 0,
    drums: {
      kick: 'X.....x.....',
      snare: '............',
      hat: 'x.o.o.x.o.o.',
      tom: '..x.......x.',
      tom2: '....x...x...',
      busy: { tom: '..x.x...x.xx', tom2: '....x.x.x...', hat: 'xoooooxooooo', snare: '.........x..' },
      kit: { kick: { from: 90, to: 36, decay: 0.55, vol: 0.34 }, snare: 'rim', hat: { cutoff: 5200, decay: 0.07, vol: 0.035 } },
    },
    bass: { calm: 'hold', fight: 'R-.R.5R-.R5.', pedal: true, type: 'sawtooth', cutoff: [600, 160] },
    arp: { rate: 2, fast: 1, pattern: [0, 2, 1, 2, 0, 3], type: 'square', octave: 0, decay: 0.16, peak: 0.045, echo: 6, feedback: 0.3 },
    pad: { voicing: 'open', type: 'sawtooth', detune: 14, cutoff: 450, range: 1100, attack: 2.0 },
    lead: { type: 'triangle', cutoff: 8000, glide: 0.12, vibrato: 0.01, length: 1.1, rhythms: ['x---x---x---', 'x-------x---', 'x---x-------'], rest: 0.2, breath: 4, form: 'motif' },
  },

  /** Half-time and floating: bell arpeggio in dotted 8ths, long echoes, lush sevenths. */
  glide: {
    id: 'glide',
    steps: 16,
    swing: 0.15,
    drums: {
      kick: 'x.........x.....',
      snare: '........x.......',
      hat: 'o.o.x.o.o.o.x.o.',
      busy: { kick: 'x.....x...x.....', hat: 'oooxoooxoooxooox' },
      kit: { kick: { from: 80, to: 40, decay: 0.45, vol: 0.3 }, snare: 'rim', hat: { cutoff: 6000, decay: 0.06, vol: 0.03 } },
    },
    bass: { calm: 'hold', fight: 'R-------..5-O---', type: 'triangle', cutoff: [500, 300] },
    arp: { rate: 3, fast: 2, pattern: [0, 1, 2, 3, 4, 3, 2, 1], type: 'sine', octave: 24, decay: 0.5, peak: 0.055, echo: 4, feedback: 0.5 },
    pad: { voicing: 'seventh', type: 'sawtooth', detune: 5, cutoff: 900, range: 1400, attack: 2.2 },
    lead: { type: 'sine', cutoff: 8000, glide: 0.18, vibrato: 0.004, length: 1.1, rhythms: ['x-------x-------', 'x-----x-x-------', 'x---------x-----'], rest: 0.25, breath: 2, form: 'motif' },
  },

  /** Motorik: four on the floor, octave-pumping bass, gated square arpeggio, staccato saw hook. */
  motorik: {
    id: 'motorik',
    steps: 16,
    swing: 0,
    drums: {
      kick: 'x...x...x...x...',
      snare: '....x.......x...',
      hat: '..X...X...X...X.',
      busy: { kick: 'x...x...x..xx...', hat: 'oxXxoxXxoxXxoxXx' },
      kit: { kick: { from: 120, to: 45, decay: 0.28, vol: 0.32 }, snare: 'snare', hat: { cutoff: 7000, decay: 0.035, vol: 0.03, open: 0.12 } },
    },
    bass: { calm: 'R---R---R---R---', fight: 'R.O.R.O.R.O.R.5.', type: 'sawtooth', cutoff: [1300, 300] },
    arp: { rate: 2, fast: 1, pattern: [0, 1, 2, 1, 0, 2, 1, 2], type: 'square', octave: 12, decay: 0.09, peak: 0.05, echo: 3, feedback: 0.25 },
    pad: { voicing: 'open', type: 'sawtooth', detune: 10, cutoff: 800, range: 1800, attack: 0.6 },
    lead: { type: 'sawtooth', cutoff: 1800, glide: 0.03, vibrato: 0, length: 0.7, rhythms: ['x.x...x.x.x.....', 'x..x..x...x.x...', 'x.x.x...x..x....'], rest: 0.15, breath: 0, form: 'motif' },
  },

  /** 3/4 waltz: oom on the downbeat, swaying arpeggio, brushed backbeats. */
  waltz: {
    id: 'waltz',
    steps: 12,
    swing: 0,
    drums: {
      kick: 'x...........',
      snare: '....o...o...',
      hat: 'x.o.x.o.x.o.',
      busy: { kick: 'x.......x...', snare: '....x...x.x.' },
      kit: { kick: { from: 100, to: 42, decay: 0.4, vol: 0.3 }, snare: 'brush', hat: { cutoff: 7000, decay: 0.05, vol: 0.025 } },
    },
    bass: { calm: 'hold', fight: 'R-------5---', type: 'sawtooth', cutoff: [800, 240] },
    arp: { rate: 2, fast: 1, pattern: [0, 1, 2, 3, 2, 1], type: 'triangle', octave: 12, decay: 0.3, peak: 0.08, echo: 4, feedback: 0.3 },
    pad: { voicing: 'triad', type: 'sawtooth', detune: 6, cutoff: 650, range: 1500, attack: 1.0 },
    lead: { type: 'triangle', cutoff: 8000, glide: 0.05, vibrato: 0.008, length: 1.2, rhythms: ['x---x---x---', 'x-------x---', 'x---x-------'], rest: 0.2, breath: 4, form: 'motif' },
  },
};

export function styleOf(id: string | undefined): Style {
  return STYLES[id ?? 'pulse'] ?? STYLES.pulse;
}

/** Hits in a pattern string: [step, velocity]. */
export function hits(pattern: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pattern.length; i++) {
    const v = pattern[i] === 'X' ? 1.6 : pattern[i] === 'x' ? 1 : pattern[i] === 'o' ? 0.5 : 0;
    if (v) out.push([i, v]);
  }
  return out;
}

/** Notes in a bass or melody pattern: [step, symbol, length in 16ths]. */
export function notes(pattern: string): [number, string, number][] {
  const out: [number, string, number][] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '.' || c === '-') continue;
    let len = 1;
    while (pattern[i + len] === '-') len++;
    out.push([i, c, len]);
  }
  return out;
}

/** a half note, in 16ths */
const HALF = 8;

export interface MelodyNote {
  /** step within the phrase (bar * steps + step) */
  at: number;
  /** index into the theme's lead notes, past the end = higher octaves */
  idx: number;
  len: number;
  /** the closing note: it fades out exactly at the end of the phrase */
  final?: boolean;
}

/**
 * A 4-bar phrase built from a motif: A, A answered (its ending moved), B (a
 * contrasting bar), then A again landing on the tonic. Repetition is what
 * makes a melody recognisable. The player leaves `breath` bars of rest after it.
 */
export function phrase(style: Style, leadCount: number, rand: () => number): MelodyNote[] {
  const span = leadCount * 2 - 1;
  if (style.lead.form === 'walk') return walkPhrase(style, span, rand);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const walk = (start: number, n: number) => {
    const out: number[] = [];
    let i = start;
    for (let k = 0; k < n; k++) {
      out.push(i);
      i = Math.max(0, Math.min(span, i + Math.floor(rand() * 5) - 2));
    }
    return out;
  };
  const bar = (cell: string, idx: number[], keep: boolean[]) =>
    notes(cell)
      .map(([at, , len], k) => ({ at, idx: idx[k], len }))
      .filter((_, k) => keep[k]);

  const cellA = pick(style.lead.rhythms);
  const cellB = pick(style.lead.rhythms);
  const nA = notes(cellA).length;
  const nB = notes(cellB).length;
  const keepA = Array.from({ length: nA }, (_, k) => k === 0 || rand() >= style.lead.rest);
  const keepB = Array.from({ length: nB }, (_, k) => k === 0 || rand() >= style.lead.rest);
  const a = walk(2 + Math.floor(rand() * 2), nA);
  // The answer: same opening, the ending stepped away.
  const a2 = a.map((i, k) => (k < nA - 1 ? i : Math.max(0, Math.min(span, i + (rand() < 0.5 ? -2 : 2)))));
  const b = walk(Math.min(span, a[0] + 2), nB);
  // Last bar: A again, resolving to the tonic (index 0 or the octave above).
  const a3 = a.map((i, k) => (k < nA - 1 ? i : i >= leadCount ? leadCount : 0));

  const out: MelodyNote[] = [];
  const bars = [bar(cellA, a, keepA), bar(cellA, a2, keepA), bar(cellB, b, keepB), bar(cellA, a3, keepA)];
  bars.forEach((ns, k) => ns.forEach((n) => out.push({ ...n, at: n.at + k * style.steps })));
  if (style.lead.breath === 0) return out;
  // Before a breath the phrase has to land on the bar line, or the closing
  // note rings into the rest and the gap sounds short. The last note starts
  // where at least a half note still fits, holds to the end of the bar on
  // the tonic, and anything after it is dropped.
  const end = 4 * style.steps;
  const landed = out.filter((n) => n.at <= end - HALF);
  const last = landed[landed.length - 1];
  last.len = end - last.at;
  last.idx = last.idx >= leadCount ? leadCount : 0;
  last.final = true;
  return landed;
}

/**
 * The original lead: one quarter-note slot per beat over 4 bars, each a rest
 * (about half the time, and always the last beat of every second bar) or a
 * step of up to two lead notes from the previous one.
 */
function walkPhrase(style: Style, span: number, rand: () => number): MelodyNote[] {
  const out: MelodyNote[] = [];
  const slots = style.steps; // 4 bars of quarter notes = steps-per-bar slots
  let i = 2;
  for (let k = 0; k < slots; k++) {
    if (rand() < style.lead.rest || k % 8 === 7) continue;
    i = Math.max(0, Math.min(span, i + Math.floor(rand() * 5) - 2));
    out.push({ at: k * 4, idx: i, len: 4 });
  }
  return out;
}
