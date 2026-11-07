/**
 * Audio quality (#118): phones can stutter or crackle when the audio thread
 * falls behind. Low trades a little latency and richness for stability: a
 * bigger output buffer, a longer music lookahead, a shorter reverb and fewer
 * sounds at once. Chosen in Settings; Auto picks Low on phones.
 */

import { isMobile } from '../ui/mobile';

export type AudioQuality = 'auto' | 'high' | 'low';
export const AUDIO_QUALITIES: AudioQuality[] = ['auto', 'high', 'low'];
export type AudioLevel = 'high' | 'low';

export interface AudioProfile {
  level: AudioLevel;
  /** for the AudioContext; only read when the context is made */
  latencyHint: AudioContextLatencyCategory | number;
  /** how far ahead the music schedules notes, in seconds */
  lookahead: number;
  /** reverb impulse length, in seconds */
  reverb: number;
  /** minor sounds (deaths, spawns) stop at this many voices */
  softCap: number;
  /** nothing new starts at this many voices */
  hardCap: number;
  /** death pops: rate per second and burst */
  deaths: [number, number];
}

const PROFILES: Record<AudioLevel, AudioProfile> = {
  high: { level: 'high', latencyHint: 'interactive', lookahead: 0.15, reverb: 2.8, softCap: 48, hardCap: 96, deaths: [16, 6] },
  low: { level: 'low', latencyHint: 'playback', lookahead: 0.5, reverb: 1.0, softCap: 20, hardCap: 40, deaths: [8, 4] },
};

const KEY = 'swarm.audioQuality';

function load(): AudioQuality {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'high' || v === 'low' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let current: AudioQuality | null = null;

export function audioQuality(): AudioQuality {
  return (current ??= load());
}

export function setAudioQuality(q: AudioQuality): void {
  current = q;
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* storage unavailable: this session only */
  }
}

/** `?latency=interactive|balanced|playback|<seconds>` overrides the hint, to A/B on a phone. */
export function parseLatency(v: string | null): AudioContextLatencyCategory | number | null {
  if (!v) return null;
  if (v === 'interactive' || v === 'balanced' || v === 'playback') return v;
  const n = Number(v);
  return n > 0 && n < 2 ? n : null;
}

/** The numbers a setting means on this device. */
export function profileFor(q: AudioQuality, mobile: boolean, latency: AudioContextLatencyCategory | number | null = null): AudioProfile {
  const level: AudioLevel = q === 'auto' ? (mobile ? 'low' : 'high') : q;
  const p = PROFILES[level];
  return latency === null ? p : { ...p, latencyHint: latency };
}

const URL_LATENCY = typeof location === 'undefined' ? null : parseLatency(new URLSearchParams(location.search).get('latency'));

export function audioProfile(): AudioProfile {
  return profileFor(audioQuality(), isMobile(), URL_LATENCY);
}

export type Priority = 'minor' | 'major';

/** May a new sound start with this many voices already playing? */
export function admit(voices: number, priority: Priority, p: Pick<AudioProfile, 'softCap' | 'hardCap'>): boolean {
  return voices < (priority === 'minor' ? p.softCap : p.hardCap);
}

/**
 * `?audiooff=...`: switch parts of the audio off, to find what a device
 * struggles with. Whole buses: music, ambience, reverb, sfx. Inside the
 * music: pad, arp, echo (the arp's feedback delay), bass, drums, lead,
 * vibrato (the lead's), automation (the per-frame level and filter moves,
 * applied twice a second instead).
 */
export const AUDIO_PARTS = ['music', 'ambience', 'reverb', 'sfx', 'pad', 'arp', 'echo', 'bass', 'drums', 'lead', 'vibrato', 'automation'] as const;
export type AudioPart = (typeof AUDIO_PARTS)[number];
export function parseAudioOff(v: string | null): Set<AudioPart> {
  return new Set((v ?? '').split(',').map((s) => s.trim()).filter((s): s is AudioPart => (AUDIO_PARTS as readonly string[]).includes(s)));
}
