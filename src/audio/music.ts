/**
 * Generative, adaptive score. Each match plays one theme (key, mode, tempo,
 * progressions: see themes.ts) in its style (meter, groove, voicing,
 * instrument settings, melody rhythms: see styles.ts). Battle blips use the
 * same theme's notes, so music and effects never clash.
 *
 * Layers fade in and out with an intensity value:
 *   pad (always) -> arpeggio (activity) -> bass (fighting) -> drums (heavy
 *   fighting / escalation); a sparse lead melody plays when things are calm.
 * The chord progression switches mood at chord boundaries: calm, tense
 * (your nests under attack) and drive (escalation).
 */

import { hits, notes, phrase, styleOf, type MelodyNote, type Style } from './styles';
import { CLASSIC, chord, leadNotes, voiced, type Mood, type Theme } from './themes';

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
  private phrase: MelodyNote[] = [];
  private theme: Theme = CLASSIC;
  private style: Style = styleOf(CLASSIC.style);
  /** applied on the next 16th; held notes of the old theme fade out */
  private pending: Theme | null = null;
  /** pad and bass notes still sounding, so a theme switch can cut them */
  private held: { g: GainNode; end: number }[] = [];
  /** one 16th note at the theme's tempo */
  private stepDur = 60 / CLASSIC.bpm / 4;
  private chord: number[] = chord(CLASSIC, CLASSIC.prog.calm.chords[0]);
  /** the chord as the pad voices it; the arpeggio walks these */
  private tones: number[] = this.chord;
  private echo: DelayNode;
  private echoFb: GainNode;
  /** the lead's last pitch, for styles that glide between notes */
  private lastLead = 0;

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

    // Arp gets an echo; its time and feedback come from the style.
    const echo = (this.echo = ctx.createDelay(2));
    echo.delayTime.value = this.stepDur * this.style.arp.echo;
    const fb = (this.echoFb = ctx.createGain());
    fb.gain.value = this.style.arp.feedback;
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

  /** Switch theme on the next 16th note. */
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
    this.padFilter.frequency.setTargetAtTime(this.style.pad.cutoff + m * this.style.pad.range, t, 1.5);

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
      // Swing pushes every odd 16th late.
      this.playStep(this.step, this.nextTime + (this.step % 2 ? this.style.swing * this.stepDur : 0));
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
    if (this.pending) {
      // New theme: fade out what the old one is holding and restart the bar
      // count so the new progression starts on its first chord.
      this.release(t);
      this.theme = this.pending;
      this.style = styleOf(this.theme.style);
      this.pending = null;
      this.stepDur = 60 / this.theme.bpm / 4;
      this.echo.delayTime.setTargetAtTime(this.stepDur * this.style.arp.echo, t, 0.05);
      this.echoFb.gain.setTargetAtTime(this.style.arp.feedback, t, 0.05);
      this.step = step = 0;
      this.chordIdx = -1;
      this.phrase = [];
    }
    const st = this.style;
    const inBar = step % st.steps;
    const bar = Math.floor(step / st.steps);
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
      const sym = p.chords[this.chordIdx];
      this.chord = chord(this.theme, sym);
      this.tones = voiced(this.theme, sym, st.pad.voicing);
      this.pad(this.tones, t, this.stepDur * st.steps * p.bars);
      if (!this.phrase.length || (this.chordIdx === 0 && Math.floor(bar / p.bars) % 8 === 0)) this.newPhrase();
    }
    const tones = this.tones;
    const root = this.theme.root;
    const STEP = this.stepDur;
    const bars = this.theme.prog[this.mood].bars;
    const m = this.intensity;
    const busy = m > 0.72;

    // Arpeggio: the style's rate, faster when intense.
    const rate = m > 0.55 || this.mood === 'drive' ? st.arp.fast : st.arp.rate;
    if (step % rate === 0) {
      const pattern = this.theme.arp ?? st.arp.pattern;
      const k = pattern[Math.floor(step / rate) % pattern.length];
      const semi = tones[k % tones.length] + 12 * Math.floor(k / tones.length);
      this.pluck(hz(root + semi + st.arp.octave), t, rate === st.arp.rate ? st.arp.decay : st.arp.decay * 0.55);
    }

    // Bass: the calm pattern (or a held root) at low intensity, the fight pattern when fighting.
    const bassRoot = st.bass.pedal ? 0 : this.chord[0];
    const fight = m > 0.45 || this.mood === 'drive';
    if (!fight && st.bass.calm === 'hold') {
      if (inBar === 0 && bar % bars === 0) this.bass(hz(root + bassRoot, 55), t, STEP * st.steps * bars * 0.9);
    } else {
      const pat = fight ? st.bass.fight : st.bass.calm;
      for (const [at, sym, len] of notes(pat)) {
        if (at !== inBar) continue;
        const off = sym === '5' ? 7 : sym === 'O' ? 12 : sym === '3' ? this.chord[1] - this.chord[0] : 0;
        this.bass(hz(root + bassRoot + off, 55), t, STEP * len * 1.25);
      }
    }

    // Drums (always scheduled; the layer gain decides if you hear them).
    const d = st.drums;
    const hit = (pat: string | undefined, busyPat: string | undefined, play: (v: number) => void) => {
      const p = busy && busyPat ? busyPat : pat;
      if (!p) return;
      for (const [at, v] of hits(p)) if (at === inBar) play(v);
    };
    hit(d.kick, d.busy.kick, (v) => this.kick(t, v));
    hit(d.snare, d.busy.snare, (v) => this.snare(t, v));
    hit(d.hat, d.busy.hat, (v) => this.hat(t, v));
    hit(d.tom, d.busy.tom, (v) => this.tom(t, hz(root - 24, 220), v));
    hit(d.tom2, d.busy.tom2, (v) => this.tom(t, hz(root - 17, 220), v));

    // Lead: a 4-bar motif phrase.
    const at = (bar % 4) * st.steps + inBar;
    const lead = leadNotes(this.theme);
    for (const n of this.phrase) {
      if (n.at !== at) continue;
      const semi = lead[n.idx % lead.length] + 12 * Math.floor(n.idx / lead.length);
      this.lead(hz(root + semi + 12), t, STEP * n.len * st.lead.length);
    }
  }

  private newPhrase(): void {
    this.phrase = phrase(this.style, leadNotes(this.theme).length, Math.random);
  }

  // ---- instruments ---------------------------------------------------------

  private hold(g: GainNode, end: number): void {
    this.held = this.held.filter((h) => h.end > this.ctx.currentTime);
    this.held.push({ g, end });
  }

  /** Fade every held note out quickly (pads hold for whole chords). */
  private release(t: number): void {
    for (const { g, end } of this.held) {
      if (end <= t) continue;
      const p = g.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
      else p.cancelScheduledValues(t);
      p.setTargetAtTime(0, t, 0.12);
    }
    this.held = [];
  }

  private env(g: GainNode, t: number, peak: number, attack: number, dur: number, release: number): void {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + release);
  }

  private pad(tones: number[], t: number, dur: number): void {
    const p = this.style.pad;
    // Same loudness however many notes the voicing has.
    const peak = (0.022 * 3) / tones.length;
    for (const semi of tones) {
      for (const det of [-p.detune, p.detune]) {
        const o = this.ctx.createOscillator();
        o.type = p.type;
        o.frequency.value = hz(this.theme.root + semi, 110);
        o.detune.value = det;
        const g = this.ctx.createGain();
        this.env(g, t, peak, p.attack, dur, 1.6);
        this.hold(g, t + dur + 1.6);
        o.connect(g).connect(this.padFilter);
        o.start(t);
        o.stop(t + dur + 1.8);
      }
    }
  }

  private pluck(freq: number, t: number, dur: number): void {
    const a = this.style.arp;
    const o = this.ctx.createOscillator();
    o.type = a.type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a.peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.layers.arp);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private bass(freq: number, t: number, dur: number): void {
    const b = this.style.bass;
    const o = this.ctx.createOscillator();
    o.type = b.type;
    o.frequency.value = freq;
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(b.cutoff[0], t);
    f.frequency.exponentialRampToValueAtTime(b.cutoff[1], t + Math.min(dur, 0.4));
    const g = this.ctx.createGain();
    this.env(g, t, 0.06, 0.01, dur, Math.min(0.15, dur * 0.3));
    this.hold(g, t + dur + 0.3);
    o.connect(f).connect(g).connect(this.layers.bass);
    sub.connect(g);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.3);
    sub.stop(t + dur + 0.3);
  }

  private kick(t: number, v: number): void {
    const k = this.style.drums.kit.kick;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(k.from, t);
    o.frequency.exponentialRampToValueAtTime(k.to, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.45, k.vol * v), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + k.decay);
    o.connect(g).connect(this.layers.drums);
    o.start(t);
    o.stop(t + k.decay + 0.05);
  }

  private snare(t: number, v: number): void {
    const kind = this.style.drums.kit.snare;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    // rim: a short, high click; brush: a soft, long swish; snare: noise plus a body tone
    const [freq, q, vol, decay] = kind === 'rim' ? [3200, 4, 0.09, 0.05] : kind === 'brush' ? [1300, 0.6, 0.07, 0.26] : [1900, 0.8, 0.1, 0.18];
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(this.layers.drums);
    src.start(t, Math.random() * 0.5, decay + 0.02);
    if (kind !== 'snare') return;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.08 * v, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(this.layers.drums);
    o.start(t);
    o.stop(t + 0.12);
  }

  private hat(t: number, v: number): void {
    const h = this.style.drums.kit.hat;
    // Accents ring longer in styles with an open hat.
    const dur = v > 1 && h.open ? h.open : h.decay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = h.cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(h.vol * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.layers.drums);
    src.start(t, Math.random() * 0.8, dur + 0.02);
  }

  /** A low tom pitched on the key. */
  private tom(t: number, freq: number, v: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.2, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.4, 0.22 * v), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g).connect(this.layers.drums);
    o.start(t);
    o.stop(t + 0.45);
  }

  private lead(freq: number, t: number, dur: number): void {
    const l = this.style.lead;
    const o = this.ctx.createOscillator();
    o.type = l.type;
    if (l.glide > 0 && this.lastLead > 0) {
      o.frequency.setValueAtTime(this.lastLead, t);
      o.frequency.exponentialRampToValueAtTime(freq, t + l.glide);
    } else o.frequency.value = freq;
    this.lastLead = freq;
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 5;
    const vibAmt = this.ctx.createGain();
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(freq * l.vibrato, t + dur * 0.6);
    vib.connect(vibAmt).connect(o.frequency);
    const g = this.ctx.createGain();
    this.env(g, t, 0.032, 0.08, dur, dur * 0.5);
    if (l.cutoff < 8000) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = l.cutoff;
      o.connect(f).connect(g).connect(this.layers.lead);
    } else o.connect(g).connect(this.layers.lead);
    o.start(t);
    vib.start(t);
    o.stop(t + dur * 1.6);
    vib.stop(t + dur * 1.6);
  }
}
