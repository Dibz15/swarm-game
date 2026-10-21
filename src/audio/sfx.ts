/** Tiny procedural sound kit on WebAudio. No asset files. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private battleGain: GainNode | null = null;
  private battleFilter: BiquadFilterNode | null = null;
  private last = new Map<string, number>();
  muted = false;
  volume = 0.6;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(ctx.destination);

      // Looping filtered noise whose gain follows battle intensity.
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.08 ? 1 : 0.25);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.battleFilter = ctx.createBiquadFilter();
      this.battleFilter.type = 'bandpass';
      this.battleFilter.frequency.value = 2400;
      this.battleFilter.Q.value = 0.7;
      this.battleGain = ctx.createGain();
      this.battleGain.gain.value = 0;
      src.connect(this.battleFilter).connect(this.battleGain).connect(this.master);
      src.start();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.last.get(key) ?? 0) + ms > now) return false;
    this.last.set(key, now);
    return true;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(60, t + dur);
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  click(): void {
    if (this.throttle('click', 40)) this.tone(880, 0.06, 'triangle', 0.08, 0.7);
  }
  order(): void {
    if (this.throttle('order', 60)) {
      this.tone(520, 0.08, 'square', 0.035, 1.4);
      this.tone(780, 0.07, 'triangle', 0.05, 1.2, 0.03);
    }
  }
  capture(): void {
    [523, 659, 784].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.09, 1, i * 0.06));
  }
  lost(): void {
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.25, 'sawtooth', 0.05, 0.98, i * 0.07));
  }
  enemyCapture(): void {
    if (this.throttle('ecap', 400)) this.tone(300, 0.15, 'triangle', 0.03, 0.8);
  }
  levelUp(): void {
    [440, 554, 659, 880].forEach((f, i) => this.tone(f, 0.18, 'square', 0.04, 1, i * 0.05));
  }
  fail(): void {
    this.tone(160, 0.18, 'square', 0.05, 0.8);
  }
  surge(): void {
    this.tone(220, 0.35, 'sawtooth', 0.06, 3.5);
    this.noise(0.3, 0.12, 5000);
  }
  nova(): void {
    this.tone(90, 0.7, 'sine', 0.35, 0.3);
    this.noise(0.8, 0.5, 3000);
  }
  eliminated(): void {
    this.tone(660, 0.5, 'sine', 0.06, 0.25);
  }
  victory(): void {
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.09, 1, i * 0.12));
  }
  defeat(): void {
    [392, 349, 311, 262].forEach((f, i) => this.tone(f, 0.45, 'sine', 0.09, 0.97, i * 0.2));
  }

  /** 0..1 battle intensity; drives the crackle bed. */
  battle(intensity: number): void {
    if (!this.ctx || !this.battleGain || !this.battleFilter) return;
    const t = this.ctx.currentTime;
    this.battleGain.gain.setTargetAtTime(Math.min(1, intensity) * 0.16, t, 0.25);
    this.battleFilter.frequency.setTargetAtTime(1800 + intensity * 1800, t, 0.3);
  }
}
