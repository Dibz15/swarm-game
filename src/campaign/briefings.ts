import { KEYS, SURGE, TICK_HZ } from '../sim/constants';
import { SIEGE } from '../sim/siege';
import type { World } from '../sim/world';
import type { Hint, Mission, Step, StepCtx } from '../game/tutorial';
import { FORT_TEXT, KIND_TEXT } from './kinds';
import type { RunNode } from './run';

/**
 * Battle briefings (#218): the first time you meet each kind of campaign
 * battle, it holds at the start and a few Next steps show what's different
 * about it: rings on the nests that matter, the camera on them, the HUD part
 * that tracks it. Plain tutorial missions (`guide`), run by the same coach.
 */

/** The kinds of campaign battle that get a briefing. */
export type BattleType = 'conquest' | 'domination' | 'hold' | 'stronghold' | 'finale';
export const BATTLE_TYPES: readonly BattleType[] = ['conquest', 'domination', 'hold', 'stronghold', 'finale'];

/** Which kind of battle this world is, read from the sim (null: nothing to brief). */
export function battleType(w: World): BattleType | null {
  if (w.siege) return 'hold';
  if (w.heart) return 'finale';
  if (w.citadel >= 0) return 'stronghold';
  if (w.keys.length) return 'domination';
  if (w.bloomSurge) return 'conquest';
  return null;
}

/** The warlord a stronghold belongs to, for its briefing. */
export interface BriefLord {
  name: string;
  trait: string;
  text: string;
}

const same = (t: string): Hint => ({ desktop: t, mobile: t });
const tour = (text: string | Hint, o: Omit<Step, 'text' | 'done' | 'next'> = {}): Step => ({
  text: typeof text === 'string' ? same(text) : text,
  done: () => false,
  next: true,
  ...o,
});

/** The middle of some nests (the map's middle if none). */
function middle(w: World, ids: number[]): { x: number; y: number } {
  if (!ids.length) return { x: w.width / 2, y: w.height / 2 };
  let x = 0, y = 0;
  for (const id of ids) {
    x += w.nests[id].x;
    y += w.nests[id].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}
/** Close on one nest. */
const onNest = (id: number, zoom = 2) => (c: StepCtx) => ({ x: c.w.nests[id].x, y: c.w.nests[id].y, zoom });
/** Your capital (or first nest), for coming home at the end. */
const home = (c: StepCtx) => {
  const own = c.w.nests.filter((n) => n.owner === c.human);
  return (own.find((n) => n.capital) ?? own[0])?.id ?? -1;
};

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

function hold(w: World): Step[] {
  const sg = w.siege!;
  const mins = Math.round((sg.until - w.tick) / TICK_HZ / 60);
  return [
    tour(
      `<b>Hold the line.</b> You're dug in behind your own walls. Keep your capital (ringed) until the clock runs out${mins ? `, about ${mins} minute${mins > 1 ? 's' : ''}` : ''}: that's the win.`,
      { highlight: () => [sg.capital], focus: onNest(sg.capital, 2) },
    ),
    tour("The Bloom comes in waves. This timeline shows them marching toward now, and the clock at its end is how long you have left to hold.", {
      spotlight: '.siege',
    }),
    tour(
      `These are the Bloom's nests in the field (ringed): every one it holds makes its waves ${Math.round(SIEGE.perNest * 100)}% bigger. Sally out between waves and take them.`,
      { highlight: () => sg.bloomNests, focus: (c) => (sg.bloomNests.length ? { ...middle(c.w, sg.bloomNests), zoom: 1.1 } : null) },
    ),
    tour(
      `Every ${SIEGE.boonEvery === 2 ? 'other' : `${SIEGE.boonEvery}th`} wave, you pick a boon. If your capital falls, you have ${SIEGE.retake / TICK_HZ} seconds to take it back. Hold on!`,
      { highlight: () => [sg.capital], focus: onNest(sg.capital, 1.6) },
    ),
  ];
}

function domination(w: World): Step[] {
  const keys = [...w.keys];
  const seal = Math.round((w.keySealUntil - w.tick) / TICK_HZ);
  return [
    tour('<b>Domination.</b> The ringed nests are the <b>key nests</b>, circled in gold on the map. Whoever holds them, uncontested, scores.', {
      highlight: () => keys,
      focus: () => null,
    }),
    tour(`Hold every key nest for ${KEYS.points / TICK_HZ} seconds to win, or fewer of them for longer. Wiping out every rival wins too.`, {
      highlight: () => keys,
    }),
    tour(
      `${seal > 0 ? `The key nests are sealed for the first ${seal >= 60 && seal % 60 === 0 ? `${seal === 60 ? 'minute' : `${seal / 60} minutes`}` : `${seal} seconds`}, and` : 'The key nests are'} better guarded than most. Build up on the nests around you first, then strike.`,
      { highlight: (c) => [home(c)].filter((id) => id >= 0), focus: (c) => (home(c) >= 0 ? onNest(home(c), 1.4)(c) : null) },
    ),
  ];
}

function stronghold(w: World, kind: RunNode['kind'], lord?: BriefLord): Step[] {
  const cit = w.citadel;
  const who = lord ? `${lord.name}'s` : "The warlord's";
  const rest = FORT_TEXT[kind] ?? KIND_TEXT[kind];
  const steps = [
    tour(`<b>A warlord's stronghold.</b> ${who} citadel (ringed) sits behind walls. Take it and the battle is won, even with rivals left.`, {
      highlight: () => [cit],
      focus: onNest(cit, 1.8),
    }),
    tour('Walls stop your dots: find a gate. The citadel is heavily guarded, and its guards grow with the army you bring, so bring them all at once.', {
      highlight: () => [cit],
    }),
  ];
  if (lord)
    steps.push(
      tour(`The warlord fights with its trait, <b>${lord.trait}</b>: ${lord.text}. Its name and trait stay up here all battle.`, {
        pulse: '.warlord-chip',
      }),
    );
  if (rest)
    steps.push(
      tour(`Or win the plain way: ${lower(rest)}`, { highlight: (c) => [home(c)].filter((id) => id >= 0), focus: (c) => (home(c) >= 0 ? onNest(home(c), 1.4)(c) : null) }),
    );
  return steps;
}

function finale(w: World): Step[] {
  const h = w.heart!;
  const nests = [...h.nests];
  const rivals = h.rule === 'heart+rivals';
  return [
    tour("<b>The Bloom's heart.</b> Kill it to end the run. It pulses, lobs spores and calls defenders when you come close, and regrows if left alone.", {
      focus: (c) => ({ x: c.w.heart!.x, y: c.w.heart!.y, zoom: 1.6 }),
      spotlight: '.heartbar',
    }),
    tour('Its Bloom nests (ringed) ward it: each one still standing cuts the damage it takes. Take them first, then strike.', {
      highlight: () => nests,
      focus: () => null,
    }),
    tour(
      rivals
        ? 'The rivals want it too, and on this difficulty they must be beaten after the heart falls. Good luck.'
        : 'The rivals are fighting over it too. Let them wear it down if you like. Good luck.',
      { highlight: (c) => [home(c)].filter((id) => id >= 0), focus: (c) => (home(c) >= 0 ? onNest(home(c), 1.4)(c) : null) },
    ),
  ];
}

function conquest(): Step[] {
  return [
    tour('<b>Conquest.</b> Wipe out every rival, or hold 80% of the nests for 30 seconds. This bar is your share of the nests.', { pulse: '.nestshare' }),
    tour(`Don't stall: past ${SURGE.after / 60} minutes the Bloom surges in from the edges, every wave bigger than the last.`, { pulse: '.clock' }),
  ];
}

const TITLES: Record<BattleType, string> = {
  conquest: 'Conquest',
  domination: 'Domination',
  hold: 'Hold the line',
  stronghold: 'Stronghold',
  finale: "The Bloom's heart",
};

/**
 * The briefing for a battle's opening world (null if its kind has none).
 * `kind` is the node's kind (a stronghold is a Conquest or Domination underneath).
 */
export function briefingFor(w: World, kind: RunNode['kind'], lord?: BriefLord): Mission | null {
  const type = battleType(w);
  if (!type) return null;
  const steps =
    type === 'hold' ? hold(w) : type === 'domination' ? domination(w) : type === 'stronghold' ? stronghold(w, kind, lord) : type === 'finale' ? finale(w) : conquest();
  return {
    id: `brief:${type}`,
    title: TITLES[type],
    teaches: KIND_TEXT[kind],
    learned: [],
    setup: () => {
      throw new Error('a battle briefing has no match of its own');
    },
    locked: [],
    guide: true,
    steps,
  };
}

// ---- seen ------------------------------------------------------------------

const KEY = 'swarm.battleBriefs';

/** Battle types already briefed. */
export function briefsSeen(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (Array.isArray(p?.seen)) return p.seen.filter((s: unknown) => typeof s === 'string');
  } catch {
    /* ignore */
  }
  return [];
}

export function markBriefSeen(type: string): void {
  const seen = briefsSeen();
  if (seen.includes(type)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ seen: [...seen, type] }));
  } catch {
    /* ignore */
  }
}

/** Show every briefing again (the run hub's button). */
export function resetBriefs(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
