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
}

/**
 * Slow generative drone underneath everything. Tension opens the filter and
 * brings in a shimmer; danger darkens it with a minor second; escalation adds
 * a heartbeat pulse.
 */
export class Ambience {
  private filter: BiquadFilterNode;
  private droneGain: GainNode;
  private shimmerGain: GainNode;
  private dissonance: GainNode;
  private nextBeat = 0;
  private time = 0;
  private level = 0;

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode, private readonly reverb: AudioNode) {
    const t = ctx.currentTime;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 380;
    this.filter.Q.value = 2.5;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.filter.connect(this.droneGain).connect(out);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    this.droneGain.connect(send).connect(reverb);

    // Root (A1), detuned pair + fifth + octave.
    const voice = (freq: number, type: OscillatorType, vol: number, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = vol;
      o.connect(g).connect(this.filter);
      o.start(t);
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
    lfoAmt.gain.value = 90;
    lfo.connect(lfoAmt).connect(this.filter.frequency);
    lfo.start(t);

    // Danger: a minor second against the root.
    this.dissonance = ctx.createGain();
    this.dissonance.gain.value = 0;
    const d = ctx.createOscillator();
    d.type = 'sawtooth';
    d.frequency.value = 58.27;
    d.connect(this.dissonance).connect(this.filter);
    d.start(t);

    // Shimmer: high sines with tremolo, sent mostly to reverb.
    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = 0;
    const trem = ctx.createGain();
    trem.gain.value = 0.5;
    const tlfo = ctx.createOscillator();
    tlfo.frequency.value = 5.5;
    const tAmt = ctx.createGain();
    tAmt.gain.value = 0.5;
    tlfo.connect(tAmt).connect(trem.gain);
    tlfo.start(t);
    for (const f of [880, 1318.5, 1760 * 1.003]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(trem);
      o.start(t);
    }
    trem.connect(this.shimmerGain);
    this.shimmerGain.connect(reverb);
    const dry = ctx.createGain();
    dry.gain.value = 0.25;
    this.shimmerGain.connect(dry).connect(out);
  }

  update(dt: number, s: AmbienceState): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.time += dt;
    // Fade in after unlock rather than slamming on.
    this.level = Math.min(1, this.level + dt * 0.25);

    const base = s.inGame ? 0.05 : 0.035;
    const duck = 1 - 0.45 * s.music;
    this.droneGain.gain.setTargetAtTime(base * this.level * duck * (1 + s.tension * 0.6), t, 0.8);
    this.filter.frequency.setTargetAtTime(320 + s.tension * 1300 + s.escalation * 300, t, 0.9);
    this.dissonance.gain.setTargetAtTime(s.danger * 0.22, t, 0.6);
    this.shimmerGain.gain.setTargetAtTime(this.level * (0.004 + s.tension * 0.014), t, 1.2);

    // Heartbeat once escalation starts; faster with tension.
    if (s.inGame && s.escalation > 0) {
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
