import { NEUTRAL, escalation } from '../sim/constants';
import type { World } from '../sim/world';
import { Ambience } from './ambience';
import { Music, type MusicMode } from './music';

/** What the audio needs to know about the camera. */
export interface Listener {
  toScreen(wx: number, wy: number): [number, number];
  viewW: number;
  viewH: number;
  zoom: number;
  fitZoom: number;
}

export interface Placement {
  pan: number;
  gain: number;
  cutoff: number;
  /** reverb send: distant sounds are wetter */
  wet: number;
  /** 0 in view, grows with distance off-screen (in half-viewports) */
  outside: number;
}

export type VolumeKind = 'master' | 'sfx' | 'ambience' | 'music';
export type Volumes = Record<VolumeKind, number>;

const DEFAULT_VOLUMES: Volumes = { master: 0.8, sfx: 0.8, ambience: 0.7, music: 0.6 };

/** A minor pentatonic, in semitones from A. Every color plays the same scale, so fights sound consonant. */
const SCALE = [0, 3, 5, 7, 10, 12, 15];
/** Per-faction register and timbre, so colors are distinguishable by ear. */
const VOICE: { octave: number; type: OscillatorType }[] = [
  { octave: 2, type: 'sine' },
  { octave: 2, type: 'triangle' },
  { octave: 3, type: 'sine' },
  { octave: 1, type: 'triangle' },
  { octave: 3, type: 'triangle' },
  { octave: 1, type: 'sine' },
  { octave: 0, type: 'sine' },
];
const A = 220;
const note = (semi: number) => A * Math.pow(2, semi / 12);

/** Token bucket so dense fights stay a texture, not a wall of noise. */
class RateLimit {
  private tokens: number;
  constructor(private readonly perSec: number, private readonly burst: number) {
    this.tokens = burst;
  }
  refill(dt: number): void {
    this.tokens = Math.min(this.burst, this.tokens + dt * this.perSec);
  }
  take(): boolean {
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

/**
 * Procedural, camera-aware audio. Sounds are panned by screen position and
 * get quieter, darker and more reverberant the further they are off-screen.
 * Buses: sfx, ambience, music -> compressor -> master.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<'sfx' | 'ambience' | 'music', GainNode>;
  private reverbIn!: GainNode;
  private noiseBuf!: AudioBuffer;
  private nearBed!: { gain: GainNode; filter: BiquadFilterNode };
  private farBed!: { gain: GainNode; filter: BiquadFilterNode };
  private ambience: Ambience | null = null;
  private music: Music | null = null;
  private listener: Listener | null = null;
  private last = new Map<string, number>();
  private deathLimit = new RateLimit(16, 6);
  private spawnLimit = new RateLimit(3, 2);
  private nearLevel = 0;
  private farLevel = 0;
  private tension = 0;

  muted = false;
  volumes: Volumes = { ...DEFAULT_VOLUMES };

  constructor() {
    try {
      const raw = localStorage.getItem('swarm.audio');
      if (raw) {
        const saved = JSON.parse(raw);
        this.volumes = { ...DEFAULT_VOLUMES, ...saved.volumes };
        this.muted = !!saved.muted;
      }
    } catch {
      /* storage unavailable */
    }
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.build(new AudioContext());
    } catch {
      this.ctx = null;
    }
  }

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    comp.connect(this.master).connect(ctx.destination);

    const bus = () => {
      const g = ctx.createGain();
      g.connect(comp);
      return g;
    };
    this.buses = { sfx: bus(), ambience: bus(), music: bus() };

    // Generated impulse response: stereo decaying noise, ~2.8s tail.
    const len = Math.floor(ctx.sampleRate * 2.8);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.reverbIn = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverbIn.connect(conv).connect(wet).connect(comp);

    // Shared noise for beds and transients.
    const nlen = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    // Battle beds: crackle for fights in view, muffled rumble for fights elsewhere.
    this.nearBed = this.bed('bandpass', 1000, 0.8, 0.25);
    this.farBed = this.bed('lowpass', 260, 0.7, 0.5);

    this.ambience = new Ambience(ctx, this.buses.ambience, this.reverbIn);
    this.music = new Music(ctx, this.buses.music, this.reverbIn);
    this.music.start();
    this.applyVolumes();
  }

  private bed(type: BiquadFilterType, freq: number, q: number, send: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.buses.sfx);
    const s = ctx.createGain();
    s.gain.value = send;
    gain.connect(s).connect(this.reverbIn);
    src.start();
    return { gain, filter };
  }

  // ---- settings ------------------------------------------------------------

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes();
    this.save();
  }

  setVolume(kind: VolumeKind, v: number): void {
    this.volumes[kind] = Math.max(0, Math.min(1, v));
    this.applyVolumes();
    this.save();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Perceptual-ish curve so sliders feel even.
    const curve = (v: number) => v * v;
    this.master.gain.setTargetAtTime(this.muted ? 0 : curve(this.volumes.master), t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(curve(this.volumes.sfx), t, 0.05);
    this.buses.ambience.gain.setTargetAtTime(curve(this.volumes.ambience), t, 0.05);
    this.buses.music.gain.setTargetAtTime(curve(this.volumes.music), t, 0.05);
  }

  private save(): void {
    try {
      localStorage.setItem('swarm.audio', JSON.stringify({ volumes: this.volumes, muted: this.muted }));
    } catch {
      /* ignore */
    }
  }

  // ---- spatial ---------------------------------------------------------------

  setListener(l: Listener | null): void {
    this.listener = l;
  }

  /**
   * How far the camera is "above" the map: 0 when zoomed in close (about 3x
   * the fit zoom or more), 1 at the full-map view, a bit more past it.
   */
  height(): number {
    const l = this.listener;
    if (!l) return 0.5;
    return Math.max(0, Math.min(1.3, (l.fitZoom / l.zoom - 0.33) / 0.67));
  }

  /** Overall loudness from camera height: ~0.5 at full-map zoom, 1 up close. */
  heightGain(): number {
    return 1 / (2 + this.height());
  }

  place(x: number, y: number): Placement {
    const l = this.listener;
    if (!l) return { pan: 0, gain: 1, cutoff: 18000, wet: 0.15, outside: 0 };
    const [sx, sy] = l.toScreen(x, y);
    const nx = (sx / l.viewW) * 2 - 1;
    const ny = (sy / l.viewH) * 2 - 1;
    const outside = Math.max(0, Math.max(Math.abs(nx), Math.abs(ny)) - 1);
    // Higher camera: quieter, a little duller and more distant.
    const h = this.height();
    return {
      pan: Math.max(-1, Math.min(1, nx)) * 0.8,
      gain: this.heightGain() / Math.pow(1 + outside * 2.2, 2),
      cutoff: Math.max(500, 18000 / (1 + outside * 7) / (1 + h * 0.8)),
      wet: 0.12 + h * 0.12 + Math.min(0.6, outside * 0.45),
      outside,
    };
  }

  /** Route a source through a placement: filter -> pan -> gain -> sfx (+ reverb send). */
  private spatial(p: Placement, vol: number, t: number, dur: number): AudioNode {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    const pan = ctx.createStereoPanner();
    pan.pan.value = p.pan;
    const g = ctx.createGain();
    g.gain.value = vol * p.gain;
    filter.connect(pan).connect(g).connect(this.buses.sfx);
    const send = ctx.createGain();
    send.gain.value = p.wet;
    g.connect(send).connect(this.reverbIn);
    // Let the graph be collected after the sound ends.
    setTimeout(() => g.disconnect(), (dur + 3.5) * 1000 + (t - ctx.currentTime) * 1000);
    return filter;
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.last.get(key) ?? -1e9) + ms > now) return false;
    this.last.set(key, now);
    return true;
  }

  // ---- primitives ------------------------------------------------------------

  private tone(
    out: AudioNode,
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    opts: { slide?: number; delay?: number; attack?: number } = {},
  ): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + (opts.attack ?? 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(out: AudioNode, dur: number, vol: number, type: BiquadFilterType, from: number, to: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** Non-positional UI output (center, dry). */
  private get ui(): AudioNode {
    return this.buses.sfx;
  }

  private at(x: number, y: number, vol: number, dur: number, minGain = 0.02): AudioNode | null {
    if (!this.ctx) return null;
    const p = this.place(x, y);
    if (p.gain < minGain) return null;
    return this.spatial(p, vol, this.ctx.currentTime, dur);
  }

  // ---- UI sounds -------------------------------------------------------------

  click(): void {
    if (!this.ctx || !this.throttle('click', 45)) return;
    this.tone(this.ui, 1320, 0.05, 'sine', 0.05, { slide: 0.75 });
  }

  order(): void {
    if (!this.ctx || !this.throttle('order', 70)) return;
    this.tone(this.ui, 660, 0.09, 'triangle', 0.06, { slide: 1.5 });
    this.tone(this.ui, 990, 0.08, 'sine', 0.04, { slide: 1.25, delay: 0.035 });
  }

  fail(): void {
    if (!this.ctx || !this.throttle('fail', 150)) return;
    this.tone(this.ui, 180, 0.16, 'square', 0.035, { slide: 0.8 });
  }

  // ---- world events ----------------------------------------------------------

  death(x: number, y: number, faction: number): void {
    if (!this.ctx) return;
    // Zoomed out, let fewer individual pops through so it stays a texture.
    if (Math.random() > this.heightGain() * 1.4 - 0.2 || !this.deathLimit.take()) return;
    const out = this.at(x, y, 1, 0.3, 0.12);
    if (!out) return;
    const v = VOICE[faction] ?? VOICE[NEUTRAL];
    const semi = SCALE[Math.floor(Math.random() * SCALE.length)] + 12 * (v.octave - 1);
    this.tone(out, note(semi), 0.16, v.type, 0.045, { slide: 0.92 });
    this.noise(out, 0.04, 0.03, 'highpass', 5000, 3000);
  }

  spawn(x: number, y: number): void {
    if (!this.ctx || !this.spawnLimit.take()) return;
    const out = this.at(x, y, 1, 0.2, 0.3);
    if (!out) return;
    this.tone(out, 2640, 0.07, 'sine', 0.012, { slide: 1.1 });
  }

  capture(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1.2 : 0.6, 1.2, 0.03);
    if (!out) return;
    const notes = mine ? [0, 7, 12, 19] : [0, 7, 12];
    notes.forEach((s, i) => this.tone(out, note(s + 12), 0.5, 'triangle', 0.06, { delay: i * 0.07 }));
    this.noise(out, 0.6, 0.05, 'bandpass', 6000, 1500);
  }

  /** Crystal taken: a glassy two-note shimmer. */
  crystal(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 0.9 : 0.4, 1.2, 0.04);
    if (!out) return;
    [19, 26, 31].forEach((s, i) => this.tone(out, note(s + 12), 0.9, 'sine', 0.03, { delay: i * 0.06 }));
  }

  lost(x: number, y: number): void {
    if (!this.ctx) return;
    const out = this.at(x, y, 1.2, 1.2, 0.0);
    if (!out) return;
    [12, 10, 7, 3].forEach((s, i) => this.tone(out, note(s), 0.4, 'sawtooth', 0.035, { delay: i * 0.08, slide: 0.98 }));
    this.tone(out, 55, 0.8, 'sine', 0.18, { slide: 0.7 });
  }

  levelUp(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1 : 0.5, 1, 0.05);
    if (!out) return;
    [0, 3, 7, 12, 15].forEach((s, i) => this.tone(out, note(s + 12), 0.25, 'square', 0.025, { delay: i * 0.05 }));
  }

  surge(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1 : 0.6, 0.8, 0.05);
    if (!out) return;
    this.tone(out, 140, 0.5, 'sawtooth', 0.05, { slide: 4 });
    this.noise(out, 0.45, 0.12, 'bandpass', 800, 7000);
  }

  nova(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1.3 : 1, 2.5, 0.0);
    if (!out) return;
    // Low, round boom: soft-attack sines dropping in pitch, a dark air
    // swell, and a quiet A-minor bloom so it sits with the score.
    this.tone(out, 110, 1.4, 'sine', 0.4, { slide: 0.4, attack: 0.015 });
    this.tone(out, 55, 2.0, 'sine', 0.35, { slide: 0.75, attack: 0.03 });
    this.noise(out, 1.6, 0.16, 'lowpass', 800, 60);
    [0, 7, 12].forEach((s) => this.tone(out, note(s - 12), 2.2, 'sine', 0.07, { attack: 0.08 }));
  }

  fortify(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1 : 0.6, 1, 0.05);
    if (!out) return;
    // Low, solid "shields up": two soft square tones a fifth apart.
    this.tone(out, note(-12), 0.5, 'square', 0.03, { attack: 0.01 });
    this.tone(out, note(-5), 0.45, 'triangle', 0.05, { attack: 0.02, delay: 0.04 });
    this.noise(out, 0.25, 0.05, 'bandpass', 900, 500);
  }

  barrageCast(x: number, y: number): void {
    if (!this.ctx) return;
    const out = this.at(x, y, 0.8, 1.5, 0.05);
    if (!out) return;
    // Falling whistle across the telegraph time.
    this.tone(out, note(19), 1.3, 'sine', 0.20, { slide: 0.35, attack: 0.05 });
  }

  barrageHit(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1.1 : 0.9, 2, 0.0);
    if (!out) return;
    this.tone(out, note(-4), 0.8, 'sine', 0.35, { slide: 0.45, attack: 0.014 });
    this.noise(out, 0.7, 0.17, 'lowpass', 1400, 80);
  }

  blink(x0: number, y0: number, x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const a = this.at(x0, y0, mine ? 0.9 : 0.5, 0.5, 0.05);
    const b = this.at(x, y, mine ? 1 : 0.6, 0.6, 0.05);
    if (a) this.tone(a, note(7), 0.18, 'sine', 0.05, { slide: 2.5 });
    if (b) this.tone(b, note(19), 0.3, 'sine', 0.05, { slide: 0.6, delay: 0.08 });
  }

  lockdown(x: number, y: number, involved: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, involved ? 1 : 0.6, 1, 0.05);
    if (!out) return;
    // Descending stepped tones: something powering down.
    [12, 7, 3, 0].forEach((s, i) => this.tone(out, note(s), 0.16, 'triangle', 0.05, { delay: i * 0.07 }));
    this.tone(out, 55, 0.9, 'sine', 0.12, { slide: 0.8, delay: 0.25 });
  }

  // ---- living-map events -----------------------------------------------------

  /** Wild swarm arrives: a low, rough two-note horn. */
  swarmHorn(): void {
    if (!this.ctx) return;
    this.tone(this.ui, note(-24), 1.6, 'sawtooth', 0.05, { attack: 0.25, slide: 0.94 });
    this.tone(this.ui, note(-17), 1.4, 'sawtooth', 0.035, { attack: 0.25, delay: 0.5, slide: 0.94 });
    this.noise(this.reverbIn, 1.4, 0.08, 'lowpass', 900, 200);
  }

  /** Supply drop incoming: a bright falling chime. */
  dropIncoming(): void {
    if (!this.ctx) return;
    [24, 19, 16, 12].forEach((s, i) => this.tone(this.ui, note(s), 0.5, 'sine', 0.035, { delay: i * 0.09 }));
  }

  dropTaken(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, mine ? 1.2 : 0.6, 1.2, 0.03);
    if (!out) return;
    [12, 16, 19, 24].forEach((s, i) => this.tone(out, note(s + 12), 0.6, 'triangle', 0.05, { delay: i * 0.06 }));
  }

  /** The Colossus: a distant, heavy drum roll. */
  colossus(): void {
    if (!this.ctx) return;
    [0, 0.45, 0.9].forEach((d) => this.tone(this.reverbIn, 41.2, 0.9, 'sine', 0.22, { delay: d, slide: 0.7 }));
    this.tone(this.ui, note(-21), 2.4, 'sawtooth', 0.04, { attack: 0.8 });
  }

  stomp(x: number, y: number): void {
    if (!this.ctx) return;
    const out = this.at(x, y, 0.9, 0.6, 0.05);
    if (!out) return;
    this.tone(out, 55, 0.5, 'sine', 0.2, { slide: 0.6 });
    this.noise(out, 0.3, 0.08, 'lowpass', 600, 80);
  }

  colossusDown(x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const out = this.at(x, y, 1.3, 2.5, 0.0);
    if (!out) return;
    this.tone(out, 82.4, 2.2, 'sawtooth', 0.12, { slide: 0.5 });
    this.noise(out, 1.8, 0.2, 'lowpass', 1800, 60);
    if (mine) [0, 7, 12, 19, 24].forEach((s, i) => this.tone(this.ui, note(s + 12), 0.7, 'triangle', 0.05, { delay: 0.4 + i * 0.08 }));
  }

  // ---- domination -------------------------------------------------------------

  /** Someone starts dominating: a rising fanfare if it's you, an alarm if not. */
  domStart(mine: boolean): void {
    if (!this.ctx) return;
    if (mine) {
      [0, 4, 7, 12].forEach((s, i) => this.tone(this.ui, note(s + 12), 0.7, 'triangle', 0.06, { delay: i * 0.1 }));
    } else {
      for (let k = 0; k < 3; k++) {
        this.tone(this.ui, note(7), 0.22, 'square', 0.045, { delay: k * 0.32 });
        this.tone(this.ui, note(6), 0.22, 'square', 0.045, { delay: k * 0.32 + 0.16 });
      }
    }
    this.tone(this.reverbIn, 55, 1.6, 'sawtooth', 0.07, { attack: 0.2 });
  }

  /** Domination broken: a falling sweep, relief for the rest. */
  domBreak(mine: boolean): void {
    if (!this.ctx) return;
    const notes = mine ? [12, 10, 7, 3] : [0, 7, 12];
    notes.forEach((s, i) => this.tone(this.ui, note(s), 0.5, mine ? 'sawtooth' : 'triangle', 0.045, { delay: i * 0.09 }));
  }

  /** Countdown tick in the last seconds; urgency 0..1 raises the pitch. */
  domTick(urgency: number, mine: boolean): void {
    if (!this.ctx) return;
    this.tone(this.ui, note((mine ? 19 : 12) + Math.round(urgency * 7)), 0.09, 'square', 0.035 + 0.025 * urgency);
  }

  eliminated(): void {
    if (!this.ctx) return;
    this.tone(this.ui, note(12), 1.4, 'sine', 0.05, { slide: 0.5 });
    this.tone(this.ui, note(15), 1.4, 'sine', 0.035, { slide: 0.5, delay: 0.1 });
  }

  escalation(): void {
    if (!this.ctx) return;
    this.tone(this.ui, 55, 2.5, 'sawtooth', 0.08, { attack: 0.6 });
    this.tone(this.ui, 58.27, 2.5, 'sawtooth', 0.06, { attack: 0.6 });
    this.noise(this.reverbIn, 2.2, 0.2, 'bandpass', 300, 2400);
  }

  victory(): void {
    if (!this.ctx) return;
    [0, 7, 12, 15, 19, 24].forEach((s, i) => this.tone(this.ui, note(s), 0.9, 'triangle', 0.07, { delay: i * 0.13 }));
    this.tone(this.reverbIn, note(-12), 3, 'sine', 0.2, { attack: 0.3 });
  }

  defeat(): void {
    if (!this.ctx) return;
    [12, 10, 7, 3, 0].forEach((s, i) => this.tone(this.ui, note(s), 0.9, 'sine', 0.07, { delay: i * 0.22, slide: 0.97 }));
    this.tone(this.reverbIn, 41.2, 3.5, 'sawtooth', 0.08, { attack: 0.4 });
  }

  // ---- per frame -------------------------------------------------------------

  /**
   * Drive the battle beds, ambience and music from the world as the camera sees it.
   * `human` is -1 on the menu.
   */
  update(dt: number, w: World | null, human: number, mode: MusicMode): void {
    const active = mode === 'menu' || mode === 'play';
    if (!this.ctx) return;
    this.deathLimit.refill(dt);
    this.spawnLimit.refill(dt);

    let near = 0, far = 0, danger = 0, escal = 0, dom = 0;
    if (w && active && this.listener) {
      // Sample beams: weight by placement. Cap work for huge fights.
      const step = Math.max(1, Math.floor(w.beamCount / 400));
      for (let k = 0; k < w.beamCount; k += step) {
        const t = w.beams[k * 2 + 1];
        const p = this.place(w.x[t], w.y[t]);
        if (p.outside === 0) near += step;
        else far += step * p.gain * 4;
      }
      if (human >= 0) {
        for (const n of w.nests) if (n.owner === human && n.contested) danger = 1;
      }
      escal = escalation(w.tick);
      for (let t = 0; t < w.domTicks.length; t++) if (w.domTicks[t] > 0) dom = 1;
    }
    const k = 1 - Math.exp(-dt * 3);
    this.nearLevel += (Math.min(1, near / 220) - this.nearLevel) * k;
    this.farLevel += (Math.min(1, far / 900) - this.farLevel) * k;
    const t = this.ctx.currentTime;
    this.nearBed.gain.gain.setTargetAtTime(this.nearLevel * 0.12 * this.heightGain(), t, 0.1);
    this.nearBed.filter.frequency.setTargetAtTime(800 + this.nearLevel * 900, t, 0.2);
    this.farBed.gain.gain.setTargetAtTime(this.farLevel * 0.35, t, 0.2);

    this.tension += (Math.min(1, this.nearLevel * 0.8 + this.farLevel * 0.35 + danger * 0.35) - this.tension) * (1 - Math.exp(-dt * 0.8));
    const musicOn = mode === 'ended' || this.muted ? 0 : Math.min(1, this.volumes.music * 1.5);
    this.ambience?.update(dt, { tension: this.tension, danger, escalation: escal, inGame: human >= 0, music: musicOn });
    this.music?.update(dt, { mode, tension: this.tension, danger, escalation: escal, domination: dom });
  }
}
