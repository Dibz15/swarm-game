/**
 * Generative, adaptive score. Each match plays one theme (key, mode, tempo,
 * progressions: see themes.ts); battle blips use the same theme's notes, so
 * music and effects never clash.
 *
 * Layers fade in and out with an intensity value:
 *   pad (always) -> arpeggio (activity) -> bass (fighting) -> drums (heavy
 *   fighting / escalation); a sparse lead melody plays when things are calm.
 * The chord progression switches mood at chord boundaries: calm, tense
 * (your nests under attack) and drive (escalation).
 */

import { CLASSIC, DEFAULT_ARP, chord, leadNotes, type Mood, type Theme } from './themes';

export type MusicMode = 'menu' | 'play' | 'paused' | 'ended';

export interface MusicState {
  mode: MusicMode;
  tension: number;
  danger: number;
  escalation: number;
  /** 1 while any team is dominating */
  domination: number;
}

/** Paused mid-match: music (and the ambience drone) go dull and quiet. */
export const PAUSE = { cutoff: 260, level: 0.45 };
const LOOKAHEAD = 0.15;

const hz = (semi: number, base = 220) => base * Math.pow(2, semi / 12);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Music {
  private out: GainNode;
  private filter: BiquadFilterNode;
  /** the lead's reverb send, muffled and dimmed with the dry signal */
  private leadFilter: BiquadFilterNode;
  private leadOut: GainNode;
  private layers: Record<'pad' | 'arp' | 'bass' | 'drums' | 'lead', GainNode>;
  private padFilter: BiquadFilterNode;
  private noise: AudioBuffer;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private mood: Mood = 'calm';
  private chordIdx = -1;
  private intensity = 0;
  private state: MusicState = { mode: 'menu', tension: 0, danger: 0, escalation: 0, domination: 0 };
  private phrase: number[] = [];
  private theme: Theme = CLASSIC;
  /** applied at the next bar so held pads don't clash */
  private pending: Theme | null = null;
  /** one 16th note at the theme's tempo */
  private stepDur = 60 / CLASSIC.bpm / 4;
  private chord: number[] = chord(CLASSIC, CLASSIC.prog.calm.chords[0]);
  private echo: DelayNode;

  constructor(private readonly ctx: AudioContext, bus: AudioNode, reverb: AudioNode) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 20000;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter.connect(this.out).connect(bus);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    this.out.connect(send).connect(reverb);

    const layer = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.filter);
      return g;
    };
    this.layers = { pad: layer(), arp: layer(), bass: layer(), drums: layer(), lead: layer() };

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.8;
    this.padFilter.connect(this.layers.pad);

    // Arp gets a dotted-8th echo.
    const echo = (this.echo = ctx.createDelay(1));
    echo.delayTime.value = this.stepDur * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 2500;
    this.layers.arp.connect(echo);
    echo.connect(echoTone).connect(fb).connect(echo);
    echoTone.connect(this.filter);

    // Lead sits mostly in the reverb. Its send is taken before the main
    // filter, so it gets its own copy of the pause muffle and level.
    const leadSend = ctx.createGain();
    leadSend.gain.value = 0.55;
    this.leadFilter = ctx.createBiquadFilter();
    this.leadFilter.type = 'lowpass';
    this.leadFilter.frequency.value = 20000;
    this.leadOut = ctx.createGain();
    this.leadOut.gain.value = 0;
    this.layers.lead.connect(leadSend).connect(this.leadFilter).connect(this.leadOut).connect(reverb);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  /** Switch theme at the next bar. */
  setTheme(theme: Theme): void {
    this.pending = theme === this.theme ? null : theme;
  }

  /** The theme that's sounding and its chord (semitones from the root). */
  get key(): { theme: Theme; chord: number[] } {
    return { theme: this.theme, chord: this.chord };
  }

  /** Called every frame with the game's state; adjusts layer levels. */
  update(dt: number, s: MusicState): void {
    this.state = s;
    const target =
      s.mode === 'menu' ? 0.12 : Math.max(s.tension * 0.9, s.danger * 0.75, s.escalation * 0.85 + s.tension * 0.2);
    // Slow follow so layers don't flicker with every skirmish.
    const rise = target > this.intensity ? 0.6 : 0.18;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt * rise));
    const m = this.intensity;
    const t = this.ctx.currentTime;
    const set = (g: GainNode, v: number, tc = 1.2) => g.gain.setTargetAtTime(v, t, tc);

    set(this.layers.pad, s.mode === 'menu' ? 1 : 0.85);
    set(this.layers.arp, smooth(0.04, 0.3, m) * 0.9 + (s.mode === 'menu' ? 0.35 : 0.15));
    set(this.layers.bass, smooth(0.25, 0.5, m));
    set(this.layers.drums, Math.max(smooth(0.45, 0.7, m), s.escalation > 0.4 ? 0.55 : 0));
    set(this.layers.lead, (1 - smooth(0.25, 0.55, m)) * 0.9);
    this.padFilter.frequency.setTargetAtTime(700 + m * 1600, t, 1.5);

    // Paused: muffled as if heard through a wall. The score sits mostly below
    // 1 kHz, so the cutoff has to reach well into it to be heard.
    const paused = s.mode === 'paused';
    const outLevel = s.mode === 'ended' ? 0 : paused ? PAUSE.level : 1;
    const muffle = paused ? PAUSE.cutoff : 20000;
    for (const g of [this.out, this.leadOut]) g.gain.setTargetAtTime(outLevel, t, s.mode === 'ended' ? 0.6 : 0.25);
    for (const f of [this.filter, this.leadFilter]) f.frequency.setTargetAtTime(muffle, t, paused ? 0.12 : 0.3);
  }

  // ---- sequencing ----------------------------------------------------------

  private schedule(): void {
    const now = this.ctx.currentTime;
    // If the context stalled (tab hidden), skip ahead instead of bursting.
    if (this.nextTime < now - 0.2) this.nextTime = now + 0.05;
    while (this.nextTime < now + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += this.stepDur;
    }
  }

  private pickMood(): Mood {
    const s = this.state;
    if (s.mode === 'play' && (s.escalation > 0.3 || s.domination > 0)) return 'drive';
    if (s.mode === 'play' && s.danger > 0.5) return 'tense';
    return 'calm';
  }

  private playStep(step: number, t: number): void {
    let inBar = step % 16;
    if (inBar === 0 && this.pending) {
      // New theme: restart the bar count so its progression starts fresh.
      this.theme = this.pending;
      this.pending = null;
      this.stepDur = 60 / this.theme.bpm / 4;
      this.echo.delayTime.setTargetAtTime(this.stepDur * 3, t, 0.05);
      this.step = step = 0;
      inBar = 0;
      this.chordIdx = -1;
      this.phrase = [];
    }
    const bar = Math.floor(step / 16);
    const prog = this.theme.prog[this.mood];

    // Chord changes (and mood switches) only on chord boundaries.
    if (inBar === 0 && bar % prog.bars === 0) {
      const next = this.pickMood();
      if (next !== this.mood || this.chordIdx < 0) {
        this.mood = next;
        this.chordIdx = 0;
      } else {
        this.chordIdx = (this.chordIdx + 1) % prog.chords.length;
      }
      const p = this.theme.prog[this.mood];
      this.chord = chord(this.theme, p.chords[this.chordIdx]);
      this.pad(this.chord, t, this.stepDur * 16 * p.bars);
      if (!this.phrase.length || (this.chordIdx === 0 && Math.floor(bar / p.bars) % 8 === 0)) this.newPhrase();
    }
    const ch = this.chord;
    const root = this.theme.root;
    const STEP = this.stepDur;
    const bars = this.theme.prog[this.mood].bars;
    const m = this.intensity;

    // Arpeggio: 8ths, 16ths when intense.
    const sixteenths = m > 0.55 || this.mood === 'drive';
    if (inBar % (sixteenths ? 1 : 2) === 0) {
      const pattern = this.theme.arp ?? DEFAULT_ARP;
      const k = pattern[(step / (sixteenths ? 1 : 2)) % pattern.length | 0];
      const semi = k === 3 ? ch[0] + 12 : ch[k];
      this.pluck(hz(root + semi + 12), t, sixteenths ? 0.12 : 0.22);
    }

    // Bass: held root when calm, driving 8ths when fighting.
    if (m > 0.45 || this.mood === 'drive') {
      if ([0, 3, 6, 8, 11, 14].includes(inBar)) this.bass(hz(root + ch[0], 55), t, STEP * 2.5);
    } else if (inBar === 0 && bar % bars === 0) {
      this.bass(hz(root + ch[0], 55), t, STEP * 16 * bars * 0.9);
    }

    // Drums (always scheduled; the layer gain decides if you hear them).
    if (inBar === 0 || inBar === 8 || (m > 0.75 && inBar === 10)) this.kick(t);
    if (inBar === 4 || inBar === 12) this.snare(t);
    if (inBar % 2 === 0) this.hat(t, inBar % 4 === 2 ? 0.05 : 0.03, 0.04);
    else if (m > 0.7) this.hat(t, 0.015, 0.03);

    // Lead: a 16-slot phrase of quarter notes spread over four bars.
    if (inBar % 4 === 0 && this.phrase.length) {
      const idx = (bar % 4) * 4 + inBar / 4;
      const n = this.phrase[idx];
      if (n !== undefined && !Number.isNaN(n)) this.lead(hz(root + n + 12), t, STEP * 6);
    }
  }

  /** A fresh 16-slot melody from the theme's lead notes (NaN = rest). */
  private newPhrase(): void {
    const notes = leadNotes(this.theme);
    const out: number[] = [];
    let i = 2;
    for (let k = 0; k < 16; k++) {
      if (Math.random() < 0.45 || k % 8 === 7) {
        out.push(NaN);
        continue;
      }
      i = Math.max(0, Math.min(notes.length * 2 - 1, i + Math.floor(Math.random() * 5) - 2));
      out.push(notes[i % notes.length] + 12 * Math.floor(i / notes.length));
    }
    this.phrase = out;
  }

  // ---- instruments ---------------------------------------------------------

  private env(g: GainNode, t: number, peak: number, attack: number, dur: number, release: number): void {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + release);
  }

  private pad(chord: number[], t: number, dur: number): void {
    for (const semi of chord) {
      for (const det of [-8, 8]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(this.theme.root + semi, 110);
        o.detune.value = det;
        const g = this.ctx.createGain();
        this.env(g, t, 0.022, 1.4, dur, 1.6);
        o.connect(g).connect(this.padFilter);
        o.start(t);
        o.stop(t + dur + 1.8);
      }
    }
  }

  private pluck(freq: number, t: number, dur: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.layers.arp);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private bass(freq: number, t: number, dur: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(220, t + Math.min(dur, 0.4));
    const g = this.ctx.createGain();
    this.env(g, t, 0.06, 0.01, dur, Math.min(0.15, dur * 0.3));
    o.connect(f).connect(g).connect(this.layers.bass);
    sub.connect(g);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.3);
    sub.stop(t + dur + 0.3);
  }

  private kick(t: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.layers.drums);
    o.start(t);
    o.stop(t + 0.4);
  }

  private snare(t: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(f).connect(g).connect(this.layers.drums);
    src.start(t, Math.random() * 0.5, 0.2);
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.08, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(this.layers.drums);
    o.start(t);
    o.stop(t + 0.12);
  }

  private hat(t: number, vol: number, dur: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.layers.drums);
    src.start(t, Math.random() * 0.8, dur + 0.02);
  }

  private lead(freq: number, t: number, dur: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 5;
    const vibAmt = this.ctx.createGain();
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(freq * 0.006, t + dur * 0.6);
    vib.connect(vibAmt).connect(o.frequency);
    const g = this.ctx.createGain();
    this.env(g, t, 0.032, 0.08, dur, dur * 0.5);
    o.connect(g).connect(this.layers.lead);
    o.start(t);
    vib.start(t);
    o.stop(t + dur * 1.6);
    vib.stop(t + dur * 1.6);
  }
}
