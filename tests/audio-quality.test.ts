import { describe, expect, it } from 'vitest';
import { admit, parseAudioOff, parseLatency, profileFor } from '../src/audio/quality';

describe('audio quality (#118)', () => {
  it('auto picks low on phones and high elsewhere', () => {
    expect(profileFor('auto', true).level).toBe('low');
    expect(profileFor('auto', false).level).toBe('high');
  });

  it('an explicit choice wins over the device', () => {
    expect(profileFor('high', true).level).toBe('high');
    expect(profileFor('low', false).level).toBe('low');
  });

  it('low is the steadier profile', () => {
    const hi = profileFor('high', false);
    const lo = profileFor('low', false);
    expect(lo.latencyHint).toBe('playback');
    expect(hi.latencyHint).toBe('interactive');
    expect(lo.lookahead).toBeGreaterThanOrEqual(0.4);
    expect(lo.reverb).toBeLessThan(hi.reverb);
    expect(lo.hardCap).toBeLessThan(hi.hardCap);
    for (const p of [hi, lo]) expect(p.softCap).toBeLessThan(p.hardCap);
  });

  it('a ?latency override replaces only the hint', () => {
    const p = profileFor('low', true, 0.2);
    expect(p.latencyHint).toBe(0.2);
    expect(p.lookahead).toBe(profileFor('low', true).lookahead);
    expect(parseLatency('playback')).toBe('playback');
    expect(parseLatency('0.1')).toBe(0.1);
    expect(parseLatency('nonsense')).toBeNull();
    expect(parseLatency(null)).toBeNull();
  });

  it('minor sounds give way at the soft cap, major ones only at the hard cap', () => {
    const caps = { softCap: 4, hardCap: 8 };
    expect(admit(3, 'minor', caps)).toBe(true);
    expect(admit(4, 'minor', caps)).toBe(false);
    expect(admit(4, 'major', caps)).toBe(true);
    expect(admit(7, 'major', caps)).toBe(true);
    expect(admit(8, 'major', caps)).toBe(false);
  });

  it('parses ?audiooff, ignoring unknown parts', () => {
    expect([...parseAudioOff('music, reverb,bogus')].sort()).toEqual(['music', 'reverb']);
    expect(parseAudioOff(null).size).toBe(0);
    expect([...parseAudioOff('pad,echo,automation')]).toEqual(['pad', 'echo', 'automation']);
  });
});
