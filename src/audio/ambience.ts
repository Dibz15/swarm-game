import { PAUSE } from './music';

export interface AmbienceState {
  /** 0..1 how much fighting is near the camera */
  tension: number;
  /** 1 while one of the player's nests is under attack */
  danger: number;
  /** 0..1 late-game escalation */
  escalation: number;
  inGame: boolean;
  /** 0..1 how much music is playing; the drone steps back under it */
  music: number;
  /** paused mid-match: muffled along with the music */
  paused: boolean;
}

/** Lowpass ceiling: the LFO adds up to ±60 Hz on top. */
const MAX_CUTOFF = 640;

/**
 * Slow generative drone underneath everything. Tension swells it and opens the
 * filter a little; danger darkens it with a minor second; escalation adds a
 * heartbeat pulse. Everything stays below ~700 Hz so it never gets shrill.
 */
export class Ambience {
  private filter: BiquadFilterNode;
  private droneGain: GainNode;
  private dissonance: GainNode;
  private nextBeat = 0;
  private time = 0;
  private level = 0;
  private voices: { o: OscillatorNode; freq: number }[] = [];
  private root = 0;

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode, private readonly reverb: AudioNode) {
    const t = ctx.currentTime;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 380;
    this.filter.Q.value = 1.5;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.filter.connect(this.droneGain).connect(out);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    this.droneGain.connect(send).connect(reverb);

    // Root (A1, moved by setRoot), detuned pair + fifth + octave.
    const voice = (freq: number, type: OscillatorType, vol: number, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = vol;
      o.connect(g).connect(this.filter);
      o.start(t);
      this.voices.push({ o, freq });
      return o;
    };
    voice(55, 'sawtooth', 0.32, -6);
    voice(55, 'sawtooth', 0.32, 7);
    voice(82.41, 'triangle', 0.22);
    voice(110, 'sine', 0.25);

    // Slow filter wobble so the pad breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 60;
    lfo.connect(lfoAmt).connect(this.filter.frequency);
    lfo.start(t);

    // Danger: a minor second against the root, triangle so it darkens without fizz.
    this.dissonance = ctx.createGain();
    this.dissonance.gain.value = 0;
    const d = ctx.createOscillator();
    d.type = 'triangle';
    d.frequency.value = 58.27;
    this.voices.push({ o: d, freq: 58.27 });
    d.connect(this.dissonance).connect(this.filter);
    d.start(t);
  }

  /** Follow the score's key: glide the drone to a new root (semitones from A). */
  setRoot(root: number): void {
    if (root === this.root) return;
    this.root = root;
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.o.frequency.setTargetAtTime(v.freq * Math.pow(2, root / 12), t, 1.5);
  }

  update(dt: number, s: AmbienceState): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.time += dt;
    // Fade in after unlock rather than slamming on.
    this.level = Math.min(1, this.level + dt * 0.25);

    const base = s.inGame ? 0.05 : 0.035;
    const duck = 1 - 0.45 * s.music;
    const hush = s.paused ? PAUSE.level : 1;
    this.droneGain.gain.setTargetAtTime(base * this.level * duck * hush * (1 + s.tension * 0.8), t, s.paused ? 0.25 : 0.8);
    const cutoff = Math.min(MAX_CUTOFF, 320 + s.tension * 300 + s.escalation * 80);
    this.filter.frequency.setTargetAtTime(s.paused ? Math.min(cutoff, PAUSE.cutoff * 0.6) : cutoff, t, s.paused ? 0.12 : 0.9);
    this.dissonance.gain.setTargetAtTime(s.danger * 0.34, t, 0.6);

    // Heartbeat once escalation starts; faster with tension.
    if (s.inGame && s.escalation > 0 && !s.paused) {
      const bpm = 64 + 34 * s.escalation + 20 * s.tension;
      if (this.time >= this.nextBeat) {
        const vol = 0.14 + 0.18 * s.escalation;
        this.kick(t + 0.01, vol);
        this.kick(t + 0.2, vol * 0.6);
        this.nextBeat = this.time + 60 / bpm;
      }
    }
  }

  private kick(t: number, vol: number): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.32);
  }
}
