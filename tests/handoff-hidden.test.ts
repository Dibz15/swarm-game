import { describe, expect, it } from 'vitest';
import { BEAT_MS, type NetMatch } from '../src/net/match';
import { ScreenAwake, type WakeLockApi } from '../src/ui/wakeLock';
import { FRAME, play } from './rig';

/**
 * A page that runs the match and goes hidden (#193): a phone freezes there,
 * so it hands the sequencer on at once; any page the browser starves hands
 * it on once its ticks come late. Either way the others' match goes on with
 * no stall: a hand-off, not an election after a silence.
 */

type Play = ReturnType<typeof play>;

const runnerOf = (p: Play) => [...p.matches].filter(([, m]) => m.runner).map(([id]) => id);

/**
 * Run `ms`, frame by frame (`frozen` skip theirs), and the longest any of
 * `watch` went without its world stepping, ms
 */
function longestStall(p: Play, watch: string[], ms: number, frozen: string[] = []): number {
  const last = new Map(watch.map((id) => [id, { tick: p.matches.get(id)!.session.world.tick, at: p.clock.now }]));
  let worst = 0;
  for (const end = p.clock.now + ms; p.clock.now < end; ) {
    p.run(FRAME, frozen);
    for (const id of watch) {
      const l = last.get(id)!;
      const tick = p.matches.get(id)!.session.world.tick;
      if (tick !== l.tick) last.set(id, { tick, at: p.clock.now });
      else worst = Math.max(worst, p.clock.now - l.at);
    }
  }
  return worst;
}

describe('a hidden page hands the match on (#193)', () => {
  it('a phone that runs the match hands it on as it hides; the others never stall, and it stays a player', () => {
    const p = play({ botSecs: 30, mobile: ['H'], runner: 'H' });
    p.run(4000);
    expect(runnerOf(p)).toEqual(['H']);
    const h = p.matches.get('H')!;
    h.handOffWhenHidden = true;
    h.setHidden(true);
    expect(h.runner).toBe(false);
    // frozen, as a hidden phone is: no frames, and nothing heard either way (without the hand-off, the others
    // elect a new runner after the silence, a stall of about two seconds)
    for (const o of ['A', 'B']) p.silence('H', o);
    expect(longestStall(p, ['A', 'B'], 3000, ['H'])).toBeLessThan(300);
    const [now] = runnerOf(p);
    expect(['A', 'B']).toContain(now);
    // back: a player again, and the match stays where it is
    for (const o of ['A', 'B']) p.heal('H', o);
    h.setHidden(false);
    p.run(12_000);
    expect(runnerOf(p)).toEqual([now]);
    expect(h.session.hidden).toBe(false);
    expect(h.session.seatBot).toBe(false);
  });

  it('a desktop page that runs the match stays on it while hidden, as long as it keeps ticking', () => {
    const p = play({ botSecs: 30 });
    p.run(4000);
    expect(runnerOf(p)).toEqual(['H']);
    p.matches.get('H')!.setHidden(true);
    expect(longestStall(p, ['A', 'B'], 4000)).toBeLessThan(300);
    expect(runnerOf(p)).toEqual(['H']);
  });

  it('a hidden page the browser starves hands the match on once its ticks come late', () => {
    const p = play({ botSecs: 30 });
    p.run(4000);
    const h = p.matches.get('H')!;
    h.setHidden(true);
    // ticks once a second, as a throttled tab's would
    for (let i = 0; i < 3 && h.runner; i++) {
      p.run(1000 - FRAME, ['H']);
      p.run(FRAME);
    }
    expect(h.runner).toBe(false);
    const [now] = runnerOf(p);
    expect(['A', 'B']).toContain(now);
    // from here, no stall
    expect(longestStall(p, ['A', 'B'], 2000, ['H'])).toBeLessThan(300);
  });

  it('with nobody to take it, the phone keeps running the match, and hands it on once someone can', () => {
    const p = play({ botSecs: 30, guests: ['A'], mobile: ['H'], runner: 'H' });
    p.run(4000);
    const h = p.matches.get('H')!;
    const a = p.matches.get('A')!;
    a.setHidden(true);
    p.run(BEAT_MS * 2);
    h.handOffWhenHidden = true;
    h.setHidden(true);
    p.run(1000);
    expect(h.runner).toBe(true);
    a.setHidden(false);
    p.run(BEAT_MS * 3);
    expect(h.runner).toBe(false);
    expect(a.runner).toBe(true);
  });

  it('about to be frozen (Page Lifecycle `freeze`): any page hands the match on', () => {
    const p = play({ botSecs: 30 });
    p.run(4000);
    const h: NetMatch = p.matches.get('H')!;
    expect(h.handOffNow()).toBe(true);
    expect(longestStall(p, ['A', 'B'], 2000, ['H'])).toBeLessThan(300);
    expect(['A', 'B']).toContain(runnerOf(p)[0]);
    // not running it, nothing to hand on
    expect(h.handOffNow()).toBe(false);
  });
});

describe('a phone keeps its screen on through a match (#193)', () => {
  const fake = () => {
    const log: string[] = [];
    const api: WakeLockApi = {
      request: () => {
        log.push('request');
        return Promise.resolve({ release: () => (log.push('release'), Promise.resolve()) });
      },
    };
    return { api, log };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('holds the lock while wanted, asks again when shown, and lets go after', async () => {
    const { api, log } = fake();
    const w = new ScreenAwake(api);
    w.set(true);
    await settle();
    expect(w.held).toBe(true);
    // hidden: the browser let go; shown: ask again
    w.shown();
    await settle();
    expect(log).toEqual(['request', 'request']);
    w.set(false);
    expect(w.held).toBe(false);
    expect(log).toEqual(['request', 'request', 'release']);
    w.shown();
    await settle();
    expect(log.length).toBe(3);
  });

  it('let go before the lock came: it goes straight back', async () => {
    const { api, log } = fake();
    const w = new ScreenAwake(api);
    w.set(true);
    w.set(false);
    await settle();
    expect(w.held).toBe(false);
    expect(log).toEqual(['request', 'release']);
  });

  it('no Wake Lock, or a refusal: nothing breaks', async () => {
    const none = new ScreenAwake(null);
    none.set(true);
    expect(none.held).toBe(false);
    const refusing = new ScreenAwake({ request: () => Promise.reject(new Error('NotAllowedError')) });
    refusing.set(true);
    await settle();
    expect(refusing.held).toBe(false);
  });
});
