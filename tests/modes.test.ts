import { describe, expect, it, vi } from 'vitest';
import { applyMode, buildSetup, prefsProblem, DOMINATION_SHARE, loadPrefs, modeProblem, quickSetup, skirmishSiege, STRONGHOLD_SHARE, type SetupPrefs } from '../src/game/matchSetup';
import { buildNetSetup, type LobbyState } from '../src/net/lobby';
import { MAX_SEATS } from '../src/net/protocol';
import { TICK_HZ } from '../src/sim/constants';
import { resolveDamage } from '../src/sim/combat';
import { worldHash } from '../src/sim/hash';
import { createWorld, type MatchSetup } from '../src/sim/setup';
import { step } from '../src/sim/step';
import { Proxy } from '../src/proxy/proxy';
import { siegeAt } from '../src/sim/siege';

/** A skirmish: you (0) against three Normal bots, in a mode. */
const prefs = (over: Partial<SetupPrefs> = {}): SetupPrefs => ({
  ...loadPrefs(),
  color: 0,
  size: 'medium',
  terrain: 'standard',
  caves: 'belt',
  layout: 'random',
  events: 'normal',
  teams: false,
  bots: [1, 2, 3].map((faction, i) => ({ faction, difficulty: 1, personality: 'expander' as const, team: i + 1 })),
  holder: 0,
  waves: 1,
  mode: 'conquest',
  ...over,
});

/** Play a setup with the proxy as the human, for `secs` or to the end. */
function play(s: MatchSetup, secs: number) {
  const w = createWorld(s);
  const human = s.players.find((p) => p.human)!.faction;
  const proxy = new Proxy(human, { skill: 1 });
  while (!w.over && w.tick < secs * TICK_HZ) {
    step(w, proxy.think(w));
    w.fx = [];
    w.deaths = [];
  }
  return w;
}

describe('match types (#222)', () => {
  it('Conquest is the setup as it was', () => {
    const s = buildSetup(prefs(), 'seed');
    expect(s.keys).toBeUndefined();
    expect(s.stronghold).toBeUndefined();
    expect(s.siege).toBeUndefined();
    expect(s.domShare).toBeUndefined();
  });

  it('Domination: key nests, two against two rivals, three against three', () => {
    const three = buildSetup(prefs({ mode: 'domination' }), 'seed');
    expect(three.keys).toBe(3);
    expect(three.domShare).toBe(DOMINATION_SHARE);
    const two = buildSetup(prefs({ mode: 'domination', bots: prefs().bots.slice(0, 2) }), 'seed');
    expect(two.keys).toBe(2);
    // Teams count as sides: 2v2 is one rival side.
    const teams = buildSetup(prefs({ mode: 'domination', teams: true, bots: prefs().bots.map((b, i) => ({ ...b, team: i === 0 ? 0 : 1 })) }), 'seed');
    expect(teams.keys).toBe(2);
    const w = createWorld(three);
    expect(w.keys).toHaveLength(3);
  });

  it('Stronghold: the chosen bot holds a walled citadel and turtles in it', () => {
    const s = buildSetup(prefs({ mode: 'stronghold', holder: 1 }), 'seed');
    expect(s.stronghold).toMatchObject({ player: 2 });
    expect(s.caves).toBe('off');
    expect(s.domShare).toBe(STRONGHOLD_SHARE);
    expect(s.players[2].bot).toMatchObject({ personality: 'turtler', citadel: true });
    expect(s.players[1].bot!.citadel).toBeUndefined();
    // Three sides attack: its garrisons are bigger than against one.
    const duel = buildSetup(prefs({ mode: 'stronghold', bots: prefs().bots.slice(0, 1) }), 'seed');
    expect(s.stronghold!.scale!).toBeGreaterThan(duel.stronghold!.scale!);
    expect(duel.stronghold!.scale).toBe(1);
    const w = createWorld(s);
    expect(w.citadel).toBeGreaterThanOrEqual(0);
    expect(w.nests[w.citadel].owner).toBe(2);
  });

  it('Stronghold: a bot ally taking the citadel wins for your side', () => {
    const s = buildSetup(prefs({ mode: 'stronghold', teams: true, holder: 2, bots: prefs().bots.map((b, i) => ({ ...b, team: i === 2 ? 1 : 0 })) }), 'seed');
    const w = createWorld(s);
    // Its guards gone, the citadel changes hands to your ally.
    const holder = w.nests[w.citadel].owner;
    for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === holder) w.dmg[i] = 1e9;
    resolveDamage(w);
    w.nests[w.citadel].owner = 1;
    w.nests[w.citadel].control = 1;
    for (let t = 0; t < TICK_HZ && !w.over; t++) step(w, []);
    expect(w.winReason).toBe('citadel');
    expect(w.winnerTeam).toBe(w.teamOf[0]);
  });

  it("Stronghold: the holder's side is bots only", () => {
    const allied = buildSetup(prefs({ teams: true, bots: prefs().bots.map((b) => ({ ...b, team: 0 })) }), 'seed');
    expect(modeProblem(allied, 'stronghold', 1)).toMatch(/bots only/);
    // ...so it stays Conquest, and the sim refuses it outright.
    expect(applyMode(allied, 'stronghold', { holder: 1 }).stronghold).toBeUndefined();
    expect(() => createWorld({ ...allied, stronghold: { player: 1 } })).toThrow();
    expect(modeProblem(buildSetup(prefs(), 'seed'), 'stronghold', 0)).toMatch(/bot/);
  });

  it("the skirmish screen's check is Start's: teams settled first (#222)", () => {
    // every bot on your team: Start moves the last one to team B, and that's the setup checked
    const allies = prefs({ mode: 'stronghold', teams: true, holder: 0, bots: prefs().bots.map((b) => ({ ...b, team: 0 })) });
    expect(prefsProblem(allies)).toMatch(/bots only/);
    expect(prefsProblem({ ...allies, holder: 2 })).toBeNull();
    expect(prefsProblem(prefs({ mode: 'stronghold' }))).toBeNull();
    expect(prefsProblem(prefs({ mode: 'hold' }))).toBeNull();
  });

  it("the skirmish's waves are the campaign's curve", () => {
    expect(skirmishSiege(0)).toEqual(siegeAt(0));
    expect(skirmishSiege(1)).toEqual(siegeAt(0.5));
    expect(skirmishSiege(2)).toEqual(siegeAt(1));
  });

  it('Hold the line: you alone against the waves; events stay on', () => {
    const s = buildSetup(prefs({ mode: 'hold', events: 'off', waves: 2 }), 'seed');
    expect(s.players).toHaveLength(1);
    expect(s.siege).toEqual(skirmishSiege(2));
    expect(s.events).toBe('calm');
    expect(s.caves).toBe('off');
    expect(skirmishSiege(0).size).toBeLessThan(skirmishSiege(2).size);
    expect(skirmishSiege(0).seconds).toBeLessThan(skirmishSiege(2).seconds);
    const w = createWorld(s);
    expect(w.siege).not.toBeNull();
    expect(w.siege!.waves.length).toBeGreaterThan(3);
  });

  it('quick matches stay Conquest whatever the skirmish screen last chose', () => {
    const saved = JSON.stringify({ ...prefs(), mode: 'hold' });
    vi.stubGlobal('localStorage', { getItem: () => saved, setItem: () => undefined });
    try {
      const q = quickSetup('ffa');
      expect(q.siege).toBeUndefined();
      expect(q.players.length).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('every mode plays a while and replays identically', () => {
    for (const mode of ['domination', 'stronghold', 'hold'] as const) {
      const s = buildSetup(prefs({ mode, size: 'small', bots: prefs().bots.slice(0, 2) }), `mode-${mode}`);
      const a = play(s, 60), b = play(s, 60);
      expect(worldHash(a)).toBe(worldHash(b));
    }
  }, 120_000);
});

describe('match types in a room (#222)', () => {
  const room = (over: Partial<LobbyState> = {}): LobbyState => ({
    host: 'A',
    phase: 'lobby',
    locked: false,
    map: { size: 'small', terrain: 'standard', caves: 'belt', layout: 'random', events: 'normal' },
    randomMap: false,
    teams: false,
    seed: 'room',
    rows: [
      { k: 'human', team: 0, peer: 'A', char: 1, mobile: false },
      { k: 'human', team: 1, peer: 'B', char: 2, mobile: false },
      { k: 'bot', team: 2, difficulty: 1, personality: 'random' },
      ...Array.from({ length: MAX_SEATS - 3 }, (_, i) => ({ k: 'open' as const, team: 3 + i })),
    ],
    botSecs: 60,
    mode: 'conquest',
    ...over,
  });

  it('Domination and Stronghold carry into the match', () => {
    expect(buildNetSetup(room({ mode: 'domination' })).keys).toBe(2);
    const s = buildNetSetup(room({ mode: 'stronghold', holder: 2 }));
    expect(s.stronghold).toMatchObject({ player: 2 });
    expect(s.players[2].bot!.citadel).toBe(true);
    createWorld(s);
  });

  it("a stronghold is held by a bot's seat: the first bot's if the chosen seat isn't one; without a bot the room plays Conquest", () => {
    expect(buildNetSetup(room({ mode: 'stronghold', holder: 1 })).stronghold).toMatchObject({ player: 2 });
    const noBots = room({ mode: 'stronghold' });
    noBots.rows[2] = { k: 'open', team: 2 };
    expect(buildNetSetup(noBots).stronghold).toBeUndefined();
  });
});
