import { describe, expect, it } from 'vitest';
import { BEACON_PULSE, BEACON_SECS, Beacon } from '../src/game/beacon';

describe('Beacon (#235)', () => {
  it('is off until armed', () => {
    const b = new Beacon();
    b.update(0, true);
    expect(b.level(0)).toBe(0);
    expect(b.pulse(0)).toBe(false);
  });

  it('waits for the match to run, then shows for BEACON_SECS', () => {
    const b = new Beacon();
    b.arm();
    // held by a briefing: not started, time doesn't count
    b.update(10, false);
    b.update(30, false);
    expect(b.level(30)).toBe(0);
    b.update(40, true);
    expect(b.level(40)).toBe(1);
    b.update(40 + BEACON_SECS - 0.5, true);
    expect(b.level(40 + BEACON_SECS - 0.5)).toBeCloseTo(0.5);
    b.update(40 + BEACON_SECS, true);
    expect(b.level(40 + BEACON_SECS)).toBe(0);
  });

  it('pulses once per period while on', () => {
    const b = new Beacon();
    b.arm();
    b.update(0, true);
    expect(b.pulse(0)).toBe(true);
    expect(b.pulse(BEACON_PULSE / 2)).toBe(false);
    expect(b.pulse(BEACON_PULSE)).toBe(true);
  });

  it('clears early', () => {
    const b = new Beacon();
    b.arm();
    b.update(0, true);
    b.clear();
    expect(b.level(1)).toBe(0);
  });
});
