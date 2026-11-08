import { describe, expect, it } from 'vitest';
import { rejectText } from '../src/game/gameView';
import { PendingOrders } from '../src/game/pending';
import { LocalSession, type OrderFail } from '../src/game/session';
import { NetSession } from '../src/net/netSession';
import { hostSequencer, LoopbackHub } from '../src/net/transport';
import { applyCommand, type Command } from '../src/sim/commands';
import { DT, POWER } from '../src/sim/constants';
import { limitsOf } from '../src/sim/sanitize';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { fullHash } from '../src/sim/snapshot';
import type { World } from '../src/sim/world';

const setup: MatchSetup = {
  seed: 9,
  size: 'small',
  players: [
    { faction: 0, team: 0, human: true },
    { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'expander' } },
  ],
};

const mine = (w: World, f = 0) => {
  const u: number[] = [];
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === f) u.push(w.uid[i]);
  return u;
};

/** a move that runs, a move of units that don't exist, a Fortify without a Forge, a Nova we can't pay for */
function orders(w: World): Command[] {
  return [
    { t: 'move', p: 0, units: mine(w), x: 300, y: 300, nest: -1 },
    { t: 'move', p: 0, units: [999_999], x: 300, y: 300, nest: -1 },
    { t: 'fortify', p: 0, units: mine(w) },
    { t: 'nova', p: 0, units: mine(w).slice(0, 2) },
  ];
}
const EXPECTED: (OrderFail | 'ran')[] = ['ran', 'units', 'power', 'cost'];

describe('orders and what became of them (#161)', () => {
  it('applyCommand says why it did nothing', () => {
    const w = createWorld(setup);
    w.factions[0].energy = 0;
    expect(orders(w).map((c) => applyCommand(w, c) ?? 'ran')).toEqual(EXPECTED);
    expect(applyCommand(w, null as unknown as Command)).toBe('invalid');
  });

  it('a refused order leaves no trace in the world: cmdFail is render output, never hashed', () => {
    const a = createWorld(setup);
    const b = createWorld(setup);
    a.factions[0].energy = b.factions[0].energy = 0;
    const bad = orders(a).slice(1);
    step(a, bad);
    step(b, []);
    expect(a.fx.filter((e) => e.type === 'cmdFail').map((e) => e.r)).toEqual([0, 1, 2]);
    expect(fullHash(a)).toBe(fullHash(b));
  });

  it('LocalSession: ids from issue, then onEffect or onReject for each', () => {
    const s = new LocalSession(setup);
    s.world.factions[0].energy = 0;
    const seen = new Map<number, OrderFail | 'ran'>();
    s.onEffect = (id) => seen.set(id, 'ran');
    s.onReject = (id, why) => seen.set(id, why);
    const ids = orders(s.world).map((c) => s.issue(c));
    expect(ids).toEqual([1, 2, 3, 4]);
    s.update(DT);
    expect(ids.map((id) => seen.get(id))).toEqual(EXPECTED);
  });

  it('NetSession: the same, by seq, after the turn runs', () => {
    const clock = { now: 0 };
    const hub = new LoopbackHub();
    const seq = hostSequencer(hub.link('host'), { limits: limitsOf(createWorld(setup)), seats: [{ seat: 0, team: 0, peer: 'me' }], clock: () => clock.now, opts: { dMin: 0 } });
    const s = new NetSession({ setup, seat: 0, transport: hub.link('me'), host: 'host', clock: () => clock.now, opts: { minBuffer: 0 } });
    s.world.factions[0].energy = 0;
    const seen = new Map<number, OrderFail | 'ran'>();
    s.onEffect = (id) => seen.set(id, 'ran');
    s.onReject = (id, why) => seen.set(id, why);
    const ids = orders(s.world).map((c) => s.issue(c));
    for (let f = 0; f < 10; f++) {
      clock.now += DT * 1000;
      seq.update();
      s.update(DT);
    }
    expect(ids.map((id) => seen.get(id))).toEqual(EXPECTED);
    expect(s.expectedDelayMs()).toBeGreaterThan(0);
  });

  it('pending orders: what each kind is waiting on, the energy they will spend, and lost ones expire', () => {
    const p = new PendingOrders();
    p.add({ id: 1, cmd: { t: 'nova', p: 0, units: [1] }, at: 0, cost: POWER.novaCost });
    p.add({ id: 2, cmd: { t: 'move', p: 0, units: [1], x: 0, y: 0, nest: -1 }, at: 5, cost: 0 });
    expect(p.has('nova')).toBe(true);
    expect(p.has('surge')).toBe(false);
    expect(p.cost()).toBe(POWER.novaCost);
    expect(p.take(1)?.cmd.t).toBe('nova');
    expect(p.take(1)).toBeUndefined();
    expect(p.has('nova')).toBe(false);
    p.expire(12);
    expect(p.size).toBe(1);
    p.expire(14);
    expect(p.size).toBe(0);
  });

  it('tells the player what went wrong, in words', () => {
    const nova: Command = { t: 'nova', p: 0, units: [1] };
    const barrage: Command = { t: 'barrage', p: 0, x: 0, y: 0 };
    expect(rejectText(nova, 'cost', false)).toMatch(/energy for Nova/);
    expect(rejectText(nova, 'cost', true)).toMatch(/dots/);
    expect(rejectText(barrage, 'target', false)).toMatch(/out of range/);
    expect(rejectText(nova, 'lost', false)).toMatch(/didn’t reach the host/);
    // the upgrade has its own toast already; needless and invalid aren't news
    expect(rejectText({ t: 'upgrade', p: 0, nest: 1 }, 'upgrade', false)).toBeNull();
    expect(rejectText(nova, 'invalid', false)).toBeNull();
  });
});
