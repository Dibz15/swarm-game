import { creature, type Creature } from '../art/creature';
import { DIFFICULTY, PERSONALITIES, type Personality } from '../sim/ai/bot';
import type { PlayerSetup } from '../sim/setup';
import type { SiegeSetup } from '../sim/siege';
import { defaultMods } from '../sim/mods';
import type { EventParams } from '../sim/mapgen';
import { Rng, hashString } from '../sim/rng';
import type { MatchSetup } from '../sim/setup';
import { TICK_HZ } from '../sim/constants';
import type { World } from '../sim/world';
import { MILITIA, fighters, veteran, type BattleReport } from './broods';
import { modsFor } from './rewards';
import { RUN_DIFFICULTY, bloomStrength, difficultyOf, erosion, finaleWarlords, maxFielded, pressure, warlordFighting, type RunState } from './run';
import { EROSION, EROSION_FLOOR, TRAITS, type TraitId, type Warlord } from './warlords';

/**
 * Conquest is won by wiping out every rival, or by holding this share of the
 * nests for the usual 30 s: without it, two rivals can turtle and stall the
 * battle (the run probe saw 11-15% of Normal × 2 battles hit its 15-minute cap).
 */
export const CONQUEST_SHARE = 0.8;
/** The army size (#100) a stronghold's starting garrisons are tuned for; bigger armies meet bigger garrisons. */
export const STRONGHOLD_ARMY = 32;
const armySize = (run: RunState, fielded: number[]) => armyFor(run, fielded).reduce((a, b) => a + b.count, 0);
/** A warlord's production in its own stronghold (#100): it starts with three nests, not one. */
export const STRONGHOLD_PROD = 0.7;
/** Domination nodes: hold half the nests (the usual share is 0.6-0.7). */
const DOMINATION_SHARE = 0.5;

/** The fielded broods (fit ones only, at most three) as a starting army; the militia if none. Lone wolf doubles it. */
export function armyFor(run: RunState, fielded: number[]): { kind: number; count: number; vet?: boolean }[] {
  const out = fighters(run.broods, fielded, maxFielded(run));
  const scale = run.perks.includes('lone-wolf') ? 2 : 1;
  return out.length ? out.map((b) => ({ kind: b.kind, count: b.size * scale, vet: veteran(b) })) : [MILITIA];
}

/** The match for a run node. Same node, same battle (its seed is fixed). */
export function nodeSetup(run: RunState, id: number, portrait: boolean, fielded: number[] = []): MatchSetup {
  const n = run.nodes[id];
  const rng = new Rng(n.seed);
  const others = [0, 1, 2, 3, 4, 5].filter((c) => c !== run.color);
  // Shuffle rival colors per node so battles don't all look alike.
  for (let i = others.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [others[i], others[j]] = [others[j], others[i]];
  }
  const finale = n.kind === 'finale';
  // Warlords take the first rival slots: the domain's own, or those bordering the heart.
  const lords = (finale ? finaleWarlords(run) : [warlordFighting(run, id)]).filter((w): w is Warlord => !!w).slice(0, n.rivals);
  const factions = [...lords.map((w) => w.faction), ...others.filter((c) => !lords.some((w) => w.faction === c))];
  // A standing warlord's stronghold (#100): its capital is a walled citadel to take.
  const hold = !finale && lords[0] && lords[0].stronghold === id && !lords[0].broken;
  const events = bloomEvents(finale ? 1 : pressure(run, id), bloomStrength(run));
  return {
    seed: n.seed,
    size: n.size,
    terrain: n.terrain,
    // No cave rock in a fortress: it could seal the gates.
    caves: hold ? 'off' : n.caves,
    layout: 'random',
    events,
    portrait,
    // A stronghold's warlord starts with three nests: half the map would be a head start.
    domShare: n.kind === 'domination' && !hold ? DOMINATION_SHARE : finale ? undefined : CONQUEST_SHARE,
    // The citadel's guards grow with the army you bring, so a late-run swarm can't just rush it.
    stronghold: hold ? { player: 1, scale: Math.max(1, armySize(run, fielded) / STRONGHOLD_ARMY) } : undefined,
    siege: n.kind === 'hold' ? siegeFor(run, n.depth) : undefined,
    // Brutal: after the heart, the rivals still have to be beaten.
    heart: finale ? { strength: bloomStrength(run), rule: RUN_DIFFICULTY[difficultyOf(run)].bots > 0 ? 'heart+rivals' : 'heart' } : undefined,
    players: [
      {
        faction: run.color,
        team: 0,
        human: true,
        army: armyFor(run, fielded),
        nestTypes: run.unlocks.nests,
        mods: modsFor(run.perks, fighters(run.broods, fielded, maxFielded(run))),
      },
      ...factions.slice(0, n.rivals).map((faction, i): PlayerSetup => {
        const personality = rng.pick(PERSONALITIES);
        const lord = lords[i];
        const plain: PlayerSetup = { faction, team: i + 1, human: false, bot: { difficulty: n.difficulty, personality } };
        if (!lord) return plain;
        const p = warlordPlayer(run, lord, plain);
        // In its stronghold, the warlord turtles whatever its usual temper.
        // Its three nests from the start would out-produce you: it spawns slower there.
        return hold ? { ...p, prod: p.prod! * STRONGHOLD_PROD, bot: { ...p.bot!, personality: 'turtler', citadel: true } } : p;
      }),
    ],
  };
}

/**
 * Hold the line (#67): longer, faster and bigger waves further into the run,
 * bigger still for every node the Bloom ate (and, in battle, for every field
 * nest it holds: SIEGE.perNest). PROVISIONAL (#68).
 */
export function siegeFor(run: RunState, depth: number): SiegeSetup {
  const t = Math.min(1, depth / Math.max(1, run.nodes[run.heart].depth));
  return {
    seconds: Math.round(lerp(180, 300, t)),
    first: 20,
    every: Math.round(lerp(36, 26, t)),
    size: Math.round(lerp(22, 38, t) * swarmScale(bloomStrength(run))),
    grow: 1.18,
    depth: t,
  };
}

/** A rival slot as the warlord: its trait in mods (and production, and powers), its personality, weakened by erosion. */
function warlordPlayer(run: RunState, w: Warlord, slot: PlayerSetup): PlayerSetup {
  const t = TRAITS[w.trait];
  const mods = defaultMods();
  t.apply(mods);
  const d = slot.bot!.difficulty;
  const prod = (DIFFICULTY[d]?.prod ?? 1) * (t.prod ?? 1) * Math.max(EROSION_FLOOR, 1 - EROSION * erosion(run, w));
  return { ...slot, mods, prod, bot: { difficulty: d, personality: w.personality, ...(t.noPowers ? { powers: false as const } : {}) } };
}

/** The warlord a node's battle announces (none outside domains; the finale's first). */
export function warlordOf(
  run: RunState,
  id: number,
): { faction: number; name: string; traitId: TraitId; trait: string; text: string; weakened: number; citadel: boolean } | null {
  const w = run.nodes[id].kind === 'finale' ? finaleWarlords(run)[0] : warlordFighting(run, id);
  if (!w) return null;
  const t = TRAITS[w.trait];
  const citadel = run.nodes[id].kind !== 'finale' && w.stronghold === id && !w.broken;
  return { faction: w.faction, name: w.name, traitId: w.trait, trait: t.name, text: t.text, weakened: erosion(run, w), citadel };
}

export interface Rival {
  faction: number;
  personality: Personality;
  creature: Creature;
  /** this rival is a warlord */
  warlord?: Warlord;
}

/** A node's rivals as the battle will field them, each with its creature portrait (#72). */
export function rivals(run: RunState, id: number): Rival[] {
  const n = run.nodes[id];
  const lords = n.kind === 'finale' ? finaleWarlords(run) : [warlordFighting(run, id)].filter((w): w is Warlord => !!w);
  return nodeSetup(run, id, false)
    .players.filter((p) => p.bot)
    .map((p, i) => {
      const personality = p.bot!.personality;
      const warlord = lords.find((w) => w.faction === p.faction);
      // A warlord keeps one face all run.
      const art = warlord
        ? creature(hashString(`warlord:${run.seed}:${warlord.id}`), p.faction, { temper: personality, tier: 3 })
        : creature(hashString(`rival:${n.seed}:${i}`), p.faction, { temper: personality, tier: n.difficulty });
      return { faction: p.faction, personality, creature: art, warlord };
    });
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** How much bigger the Bloom's swarms are for each node it swallowed (at most double). */
export const swarmScale = (strength: number) => Math.min(2, 1 + 0.06 * strength);

/**
 * A battle's map events from the Bloom: the closer it is (pressure 0..1), the
 * sooner and more often its swarms come; the more it ate, the bigger they are.
 * Far from the front, they're the calm preset's wild swarms.
 */
export function bloomEvents(p: number, strength: number): EventParams {
  const size = Math.round(lerp(22, 40, p) * swarmScale(strength));
  return {
    swarm: { first: Math.round(lerp(200, 100, p)), every: Math.round(lerp(240, 90, p)), size },
    drop: p > 0.66 ? { first: 75, every: 80 } : p > 0.2 ? { first: 105, every: 120 } : { first: 120, every: 150 },
    colossus: p > 0.66 ? [200, 420] : p > 0.2 ? [240] : [],
    regrow: Math.round(lerp(20, 7, p)),
    bloom: p > 0.2,
  };
}

/** The Bloom as a node's battle would meet it right now, for previews. */
export function bloomLabel(run: RunState, id: number): string {
  const s = bloomStrength(run);
  if (run.nodes[id].kind === 'finale') return s > 0 ? `The heart, fed by ${s} node${s === 1 ? '' : 's'}` : 'The heart, unfed';
  const p = pressure(run, id);
  const word = p > 0.66 ? 'Close' : p > 0.2 ? 'Nearing' : 'Far';
  const swarms = p > 0.66 ? 'its swarms come often' : p > 0.2 ? 'its swarms come' : 'wild swarms are rare';
  return `${word}: ${swarms}${s > 0 && p > 0.2 ? `, ×${swarmScale(s).toFixed(1)} size` : ''}`;
}

/** How a battle ended for the run: the human's survivors by kind, nests fully held, time. */
export function battleReport(w: World, human: number, won: boolean): BattleReport {
  const survivors = [0, 0, 0, 0];
  for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === human && w.kind[i] < survivors.length) survivors[w.kind[i]]++;
  const nests = w.nests.filter((n) => n.owner === human && n.control >= 1).length;
  return { won, survivors, nests, seconds: w.tick / TICK_HZ };
}
