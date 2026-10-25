import { describe, expect, it } from 'vitest';
import { Recorder, STAT_FIELDS, type Recording } from '../src/game/recording';
import { replay } from '../src/game/replay';
import { LocalSession } from '../src/game/session';
import { DT, TICK_HZ } from '../src/sim/constants';
import type { MatchSetup } from '../src/sim/setup';

const SETUP: MatchSetup = {
  seed: 4242,
  size: 'small',
  terrain: 'standard',
  events: 'normal',
  players: [
    { faction: 0, team: 0, human: true },
    { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'expander' } },
  ],
};

/** Play a short match where the "human" keeps sending everything at the nearest nest it doesn't own. */
function record(seconds: number): Recording {
  const s = new LocalSession(SETUP);
  const rec = new Recorder(SETUP, 0, { mobile: false, touch: false, w: 1280, h: 800 });
  s.onIssue = (c) => rec.order(s.world, c);
  const w = s.world;
  while (w.tick < seconds * TICK_HZ && !w.over) {
    if (w.tick % (4 * TICK_HZ) === 0) {
      const units: number[] = [];
      let cx = 0, cy = 0;
      for (let i = 0; i < w.n; i++) {
        if (!w.alive[i] || w.owner[i] !== 0) continue;
        units.push(w.uid[i]);
        cx += w.x[i];
        cy += w.y[i];
      }
      cx /= units.length || 1;
      cy /= units.length || 1;
      const target = w.nests
        .filter((n) => n.owner !== 0)
        .sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2))[0];
      if (target && units.length) s.issue({ t: 'move', p: 0, units, x: target.x, y: target.y, nest: target.id });
    }
    s.update(DT);
    w.fx = [];
    w.deaths = [];
    rec.frame(w, { cx: 500, cy: 400, viewW: 1280, viewH: 800, zoom: 1 });
  }
  return rec.finish(w, s.log, 'quit');
}

describe('recording', () => {
  it('a recorded match replays to the same hash, through JSON', () => {
    const r: Recording = JSON.parse(JSON.stringify(record(90)));
    expect(r.log.length).toBeGreaterThan(5);
    expect(r.trace.orders.length).toBe(r.log.length);
    const out = replay(r);
    expect(out.world.tick).toBe(r.end.tick);
    expect(out.ok).toBe(true);
  });

  it('a tampered log no longer matches', () => {
    const r = record(60);
    r.log.splice(1, 1);
    expect(replay(r).ok).toBe(false);
  });

  it('samples camera every half second and stats every five', () => {
    const r = record(30);
    expect(r.trace.cam.length).toBeGreaterThanOrEqual(59);
    expect(r.trace.stats.length).toBe(6);
    expect((r.trace.stats[0].length - 1) % STAT_FIELDS).toBe(0);
    // faction 0 starts with one nest
    expect(r.trace.stats[0][1]).toBe(1);
  });
});
