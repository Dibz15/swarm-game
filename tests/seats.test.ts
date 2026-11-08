import { describe, expect, it } from 'vitest';
import type { BotConfig } from '../src/sim/ai/bot';
import { localSeat } from '../src/game/gameView';
import { Proxy } from '../src/proxy/proxy';
import { NEUTRAL, TICK_HZ } from '../src/sim/constants';
import { resolveDamage } from '../src/sim/combat';
import { worldHash } from '../src/sim/hash';
import { seatHasBot, seatToBot, seatToHuman } from '../src/sim/seats';
import { createWorld, mapParamsOf, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import type { World } from '../src/sim/world';

const EASY: BotConfig = { difficulty: 0, personality: 'expander' };

/** Humans at 0 and 2, Normal bots at 1 and 3, free-for-all. */
function twoSeats(seed = 1, extra: Partial<MatchSetup> = {}): MatchSetup {
  return {
    seed,
    size: 'small',
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'expander' } },
      { faction: 2, team: 2, human: true },
      { faction: 3, team: 3, human: false, bot: { difficulty: 1, personality: 'rusher' } },
    ],
    ...extra,
  };
}

const tidy = (w: World) => {
  w.fx = [];
  w.deaths = [];
};

/** Both seats driven by proxies for `secs`. */
function play(secs: number, seed = 1): World {
  const w = createWorld(twoSeats(seed));
  const a = new Proxy(0, { skill: 1 });
  const b = new Proxy(2, { skill: 0.5 });
  while (w.tick < secs * TICK_HZ && !w.over) {
    step(w, [...a.think(w), ...b.think(w)]);
    tidy(w);
  }
  return w;
}

/** Faction f's units (by uid) and their order points. */
function orders(w: World, f: number): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === f) m.set(w.uid[i], [w.ox[i], w.oy[i]]);
  return m;
}

/** How many of `before`'s units still alive have a new order point. */
function reordered(w: World, f: number, before: Map<number, [number, number]>): number {
  let n = 0;
  for (const [uid, [x, y]] of orders(w, f)) {
    const b = before.get(uid);
    if (b && (b[0] !== x || b[1] !== y)) n++;
  }
  return n;
}

describe('several human seats (#156)', () => {
  it('a match with two proxy-driven seats and two bots is deterministic', () => {
    const w = play(60);
    // Both seats play: each has grown past its capital.
    for (const f of [0, 2]) {
      expect(w.factions[f].human).toBe(true);
      expect(w.nests.filter((n) => n.owner === f).length).toBeGreaterThanOrEqual(2);
    }
    expect(w.bots.map((b) => b.faction)).toEqual([1, 3]);
    expect(worldHash(w)).toBe(worldHash(play(60)));
  });

  it('a siege takes one human seat only', () => {
    const s = twoSeats(1, { siege: { seconds: 200, first: 20, every: 30, size: 20, grow: 1.12, depth: 1 } });
    expect(() => createWorld(s)).toThrow(/siege/);
    expect(() => mapParamsOf(s)).toThrow(/siege/);
  });

  it('the local seat defaults to the first human, and must be a human seat', () => {
    expect(localSeat(twoSeats())).toBe(0);
    expect(localSeat(twoSeats(), 2)).toBe(2);
    expect(() => localSeat(twoSeats(), 1)).toThrow();
    expect(localSeat({ ...twoSeats(), players: twoSeats().players.filter((p) => !p.human) })).toBe(-1);
  });
});

describe('seat to bot and back (#156)', () => {
  const T = 20 * TICK_HZ;

  /** Proxies drive both seats until T; then seat 2 drops and an Easy bot takes it. */
  function dropAt(t: number, secs: number, switchToBot = true): { w: World; before: Map<number, [number, number]> } {
    const w = createWorld(twoSeats());
    const a = new Proxy(0, { skill: 1 });
    const b = new Proxy(2, { skill: 1 });
    let before = new Map<number, [number, number]>();
    while (w.tick < secs * TICK_HZ && !w.over) {
      // At the tick boundary: after step t, before step t + 1.
      if (w.tick === t) {
        if (switchToBot) seatToBot(w, 2, EASY);
        before = orders(w, 2);
      }
      step(w, w.tick < t ? [...a.think(w), ...b.think(w)] : a.think(w));
      tidy(w);
    }
    return { w, before };
  }

  it('keeps bots in faction order and leaves production alone', () => {
    const w = createWorld(twoSeats());
    const prod = w.factions[2].prodMult;
    const bot = seatToBot(w, 2, EASY);
    expect(bot.faction).toBe(2);
    expect(w.bots.map((b) => b.faction)).toEqual([1, 2, 3]);
    expect(w.factions[2].prodMult).toBe(prod);
    expect(w.factions[2].human).toBe(true);
    seatToBot(w, 0, EASY);
    expect(w.bots.map((b) => b.faction)).toEqual([0, 1, 2, 3]);
    // Switching again replaces the seat's bot rather than adding one.
    seatToBot(w, 2, EASY);
    expect(w.bots.map((b) => b.faction)).toEqual([0, 1, 2, 3]);
  });

  it('only a human seat switches', () => {
    const w = createWorld(twoSeats());
    expect(() => seatToBot(w, 1, EASY)).toThrow();
    expect(() => seatToHuman(w, 3)).toThrow();
    expect(w.bots.map((b) => b.faction)).toEqual([1, 3]);
  });

  it('the same switch tick gives the same hash', () => {
    const one = dropAt(T, 50).w, two = dropAt(T, 50).w;
    expect(one.tick).toBe(two.tick);
    expect(worldHash(one)).toBe(worldHash(two));
  });

  it("the seat's bot gives orders: units move that would have idled", () => {
    const { w, before } = dropAt(T, 50);
    const idle = dropAt(T, 50, false);
    expect(seatHasBot(w, 2)).toBe(true);
    expect(seatHasBot(idle.w, 2)).toBe(false);
    expect(reordered(w, 2, before)).toBeGreaterThan(reordered(idle.w, 2, idle.before));
  });

  it('seatToHuman removes the bot: the seat idles again', () => {
    const w = createWorld(twoSeats());
    seatToBot(w, 2, EASY);
    seatToHuman(w, 2);
    expect(w.bots.map((b) => b.faction)).toEqual([1, 3]);
    expect(seatHasBot(w, 2)).toBe(false);
    // Removing a bot that isn't there is harmless.
    seatToHuman(w, 2);
    expect(w.bots.map((b) => b.faction)).toEqual([1, 3]);
  });
});

describe('win rules with two human seats (#156)', () => {
  /** Humans 0 and 2, the warlord (1) holding the citadel. */
  const hold = (): MatchSetup => ({
    seed: 3,
    size: 'medium',
    terrain: 'standard',
    stronghold: { player: 1 },
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'turtler', citadel: true } },
      { faction: 2, team: 2, human: true },
    ],
  });

  const takeCitadel = (w: World, by: number) => {
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === 1) w.dmg[i] = 1e9;
    resolveDamage(w);
    w.nests[w.citadel].owner = by;
    w.nests[w.citadel].control = 1;
    for (let t = 0; t < TICK_HZ && !w.over; t++) step(w, []);
  };

  it('a stronghold: the second human taking the citadel wins', () => {
    const w = createWorld(hold());
    takeCitadel(w, 2);
    expect(w.over).toBe(true);
    expect(w.winReason).toBe('citadel');
    expect(w.winnerTeam).toBe(w.teamOf[2]);
  });

  it("a stronghold: a dropped seat's bot taking it still wins for that seat", () => {
    const w = createWorld(hold());
    seatToBot(w, 2, EASY);
    takeCitadel(w, 2);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(w.teamOf[2]);
  });

  /** Humans 0 and 2 against a bot (1), the Bloom's heart in the middle. */
  const heart = (): MatchSetup => ({
    seed: 5,
    size: 'small',
    events: 'calm',
    heart: { strength: 0, rule: 'heart' },
    players: [
      { faction: 0, team: 0, human: true },
      { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'turtler' } },
      { faction: 2, team: 2, human: true },
    ],
  });

  /** Faction f loses every unit and nest. */
  const wipe = (w: World, f: number) => {
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === f) w.dmg[i] = 1e9;
    resolveDamage(w);
    for (const n of w.nests) if (n.owner === f) {
      n.owner = -1;
      n.controller = NEUTRAL;
      n.control = 0;
    }
    for (let t = 0; t < 15 && !w.over; t++) step(w, []);
  };

  it('the heart: the match goes on while either human stands, and ends when both fall', () => {
    const w = createWorld(heart());
    expect(w.heart).toBeTruthy();
    wipe(w, 0);
    expect(w.factions[0].eliminated).toBe(true);
    expect(w.over).toBe(false);
    wipe(w, 2);
    expect(w.factions[2].eliminated).toBe(true);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(-1);
  });

  // Were a bot-driven seat no longer `human`, losing the other human would end the match here.
  it("the heart: a dropped seat's bot still counts as a player's faction", () => {
    const w = createWorld(heart());
    seatToBot(w, 2, EASY);
    wipe(w, 0);
    for (let t = 0; t < 10 * TICK_HZ && !w.over; t++) step(w, []);
    expect(w.factions[2].eliminated).toBe(false);
    expect(w.over).toBe(false);
    wipe(w, 2);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(-1);
  });
});
