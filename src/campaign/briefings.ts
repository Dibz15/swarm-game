import { DOMINATION, KEYS, SURGE, TICK_HZ } from '../sim/constants';
import { SIEGE } from '../sim/siege';
import type { World } from '../sim/world';
import { same, type Hint, type Mission, type Step, type StepCtx } from '../game/tutorial';
import { KIND_TEXT } from './kinds';
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
/** Your capital (or first nest), for coming home at the end; -1 if you hold none. */
const home = (c: StepCtx) => {
  const own = c.w.nests.filter((n) => n.owner === c.human);
  return (own.find((n) => n.capital) ?? own[0])?.id ?? -1;
};
/** A last step back on your home, ringed (the camera stays put if you hold no nest). */
const homeStep = (text: string): Step =>
  tour(text, {
    highlight: (c) => [home(c)].filter((id) => id >= 0),
    focus: (c) => {
      const id = home(c);
      return id >= 0 ? onNest(id, 1.4)(c) : undefined;
    },
  });
/** A span of seconds in words: "a minute", "2 minutes", "1 second", "90 seconds". */
export function duration(secs: number): string {
  if (secs >= 60 && secs % 60 === 0) return secs === 60 ? 'a minute' : `${secs / 60} minutes`;
  return `${secs} second${secs === 1 ? '' : 's'}`;
}

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
      `Every ${SIEGE.boonEvery === 2 ? 'other wave' : `${SIEGE.boonEvery} waves`}, you pick a boon. If your capital falls, you have ${SIEGE.retake / TICK_HZ} seconds to take it back. Hold on!`,
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
    homeStep(
      `${seal > 0 ? `The key nests are sealed for ${seal === 60 ? 'the first minute' : duration(seal)}, and` : 'The key nests are'} better guarded than most. Build up on the nests around you first, then strike.`,
    ),
  ];
}

function stronghold(w: World, lord?: BriefLord): Step[] {
  const cit = w.citadel;
  // A skirmish's stronghold (#222) has no warlord: a bot holds it, and its guards grow with the sides attacking.
  const who = lord ? `${lord.name}'s` : "The holder's";
  const steps = [
    tour(`<b>${lord ? "A warlord's stronghold" : 'The stronghold'}.</b> ${who} citadel (ringed) sits behind walls. Take it and the battle is won, even with rivals left.`, {
      highlight: () => [cit],
      focus: onNest(cit, 1.8),
    }),
    tour(`Walls stop your dots: find a gate. The citadel is heavily guarded, and its guards grow with ${lord ? 'the army you bring' : 'every side attacking it'}, so bring them all at once.`, {
      highlight: () => [cit],
    }),
  ];
  if (lord)
    steps.push(
      tour(`The warlord fights with its trait, <b>${lord.trait}</b>: ${lord.text}. Its name and trait stay up here all battle.`, {
        pulse: '.warlord-chip',
      }),
    );
  steps.push(homeStep(`Or win the plain way: wipe out every rival, or hold ${Math.round(w.domShare * 100)}% of the nests for ${duration(DOMINATION.ticks / TICK_HZ)}.`));
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
    homeStep(
      rivals
        ? 'The rivals want it too, and on this difficulty they must be beaten after the heart falls. Good luck.'
        : 'The rivals are fighting over it too. Let them wear it down if you like. Good luck.',
    ),
  ];
}

function conquest(w: World): Step[] {
  return [
    tour(
      `<b>Conquest.</b> Wipe out every rival, or hold ${Math.round(w.domShare * 100)}% of the nests for ${duration(DOMINATION.ticks / TICK_HZ)}. This bar is your share of the nests.`,
      { pulse: '.nestshare' },
    ),
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
 * `kind` is the node's kind, for the one-line summary.
 */
export function briefingFor(w: World, kind: RunNode['kind'], lord?: BriefLord): Mission | null {
  const type = battleType(w);
  if (!type) return null;
  const steps =
    type === 'hold' ? hold(w) : type === 'domination' ? domination(w) : type === 'stronghold' ? stronghold(w, lord) : type === 'finale' ? finale(w) : conquest(w);
  return {
    id: `brief:${type}`,
    title: TITLES[type],
    teaches: KIND_TEXT[kind],
    learned: [],
    setup: () => {
      throw new Error('a battle briefing has no match of its own');
    },
    locked: [],
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
