import { EVENT_PRESETS, type EventSpec, type MapSpec, type NestSpec } from '../sim/mapgen';
import { NEUTRAL, NestType } from '../sim/constants';
import type { MatchSetup } from '../sim/setup';
import type { CrystalSpec, FieldSpec, Capsule } from '../sim/terrain';
import type { World } from '../sim/world';
import type { TimedCommand } from './session';

/**
 * The tutorial (#17): five short missions on hand-authored maps that grow in
 * complexity as ideas are introduced, about ten minutes in all, then a real
 * 1v1. Missions are plain data plus step checks that read the world and the
 * player's orders, so a headless test can play every one to the end.
 */

/** HUD actions a mission can hide to keep the lesson focused. */
export type Lock = 'surge' | 'nova' | 'upgrade' | 'fortify' | 'barrage' | 'blink' | 'lockdown';
const ALL_POWERS: Lock[] = ['surge', 'nova', 'upgrade', 'fortify', 'barrage', 'blink', 'lockdown'];

export interface StepCtx {
  w: World;
  human: number;
  /** the player's orders so far */
  log: readonly TimedCommand[];
}

export interface Step {
  /** what to do now; mobile mode gets touch wording */
  text: { desktop: string; mobile: string };
  done: (c: StepCtx) => boolean;
  /** nests to pulse while this step is active */
  highlight?: (c: StepCtx) => number[];
}

export interface Mission {
  id: string;
  title: string;
  /** one line for the briefing: what this mission teaches */
  teaches: string;
  /** debrief bullets */
  learned: string[];
  setup: (portrait: boolean) => MatchSetup;
  locked: Lock[];
  steps: Step[];
}

// ---- map helpers -----------------------------------------------------------

const W = 1100, H = 680;
const none: EventSpec = { params: EVENT_PRESETS.off, swarmSpawns: [], dropSpots: [], colossusPaths: [] };

const nest = (x: number, y: number, type: number, player: number, garrison: number, extra: Partial<NestSpec> = {}): NestSpec => ({
  x, y, type, level: 1, player, garrison, ...extra,
});
const wall = (x1: number, y1: number, x2: number, y2: number, r = 16): Capsule => ({ x1, y1, x2, y2, r });

function map(nests: NestSpec[], o: { walls?: Capsule[]; fields?: FieldSpec[]; crystals?: CrystalSpec[]; events?: EventSpec } = {}): MapSpec {
  return { width: W, height: H, nests, terrain: { walls: o.walls ?? [], fields: o.fields ?? [], crystals: o.crystals ?? [] }, events: o.events ?? none };
}

/** Portrait screens get the map transposed, the same way generated maps turn. */
function orient(m: MapSpec, portrait: boolean): MapSpec {
  if (!portrait) return m;
  const p = <T extends { x: number; y: number }>(o: T): T => ({ ...o, x: o.y, y: o.x });
  const c = <T extends Capsule>(o: T): T => ({ ...o, x1: o.y1, y1: o.x1, x2: o.y2, y2: o.x2 });
  const pt = ([x, y]: [number, number]): [number, number] => [y, x];
  return {
    width: m.height,
    height: m.width,
    nests: m.nests.map(p),
    terrain: { walls: m.terrain.walls.map(c), fields: m.terrain.fields.map(c), crystals: m.terrain.crystals.map(p) },
    events: { ...m.events, swarmSpawns: m.events.swarmSpawns.map(pt), dropSpots: m.events.dropSpots.map(pt), colossusPaths: m.events.colossusPaths.map((l) => l.map(pt)) },
  };
}

const solo = (m: MapSpec, portrait: boolean, energy = 0): MatchSetup => ({
  seed: 1701,
  size: 'small',
  map: orient(m, portrait),
  endless: true,
  players: [{ faction: 0, team: 0, human: true, energy }],
});

const versus = (m: MapSpec, portrait: boolean, personality: 'turtler' | 'expander', energy = 0): MatchSetup => ({
  seed: 1702,
  size: 'small',
  map: orient(m, portrait),
  players: [
    { faction: 0, team: 0, human: true, energy },
    { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality } },
  ],
});

// ---- step checks -------------------------------------------------------------

const owned = (c: StepCtx) => c.w.nests.filter((n) => n.owner === c.human).length;
const ordered = (c: StepCtx, t: TimedCommand['cmd']['t']) => c.log.some((l) => l.cmd.t === t);
const unowned = (ids: number[]) => (c: StepCtx) => ids.filter((id) => c.w.nests[id]?.owner !== c.human);
const won = (c: StepCtx) => c.w.over && c.w.winnerTeam === c.w.teamOf[c.human];

// ---- the missions ----------------------------------------------------------------

export const MISSIONS: Mission[] = [
  {
    id: 'move',
    title: 'First steps',
    teaches: 'Select your dots, send them, and capture nests.',
    learned: ['Select dots, then give them an order.', 'Nests you capture make more dots.'],
    locked: ALL_POWERS,
    setup: (portrait) => solo(map([nest(170, 340, NestType.Hive, 0, 12), nest(480, 300, NestType.Hive, -1, 3), nest(820, 400, NestType.Hive, -1, 6)]), portrait),
    steps: [
      {
        text: {
          desktop: 'Drag a box around your dots to select them, then <b>right-click</b> the glowing nest to send them.',
          mobile: 'Drag across your dots to select them, then <b>tap</b> the glowing nest to send them.',
        },
        done: (c) => owned(c) >= 2,
        highlight: unowned([1]),
      },
      {
        text: {
          desktop: 'Captured nests make dots for you. Take the last nest too: it has more guards, so bring everyone.',
          mobile: 'Captured nests make dots for you. Take the last nest too: it has more guards, so bring everyone.',
        },
        done: (c) => owned(c) >= 3,
        highlight: unowned([2]),
      },
    ],
  },
  {
    id: 'rally',
    title: 'Rally and nest types',
    teaches: 'Send new dots where they are needed, and meet the three unit types.',
    learned: ['A nest’s rally point sends its new dots straight to the front.', 'Hives make Swarmers, Forges make Shields, Spires make Spears.', 'Swarmers beat Spears, Spears beat Shields, Shields beat Swarmers.'],
    locked: ALL_POWERS,
    setup: (portrait) =>
      solo(
        map(
          [nest(160, 340, NestType.Hive, 0, 12), nest(470, 180, NestType.Forge, -1, 7), nest(560, 500, NestType.Hive, -1, 5), nest(900, 340, NestType.Spire, -1, 10)],
          { walls: [wall(700, 140, 700, 280), wall(700, 400, 700, 540)] },
        ),
        portrait,
      ),
    steps: [
      {
        text: {
          desktop: '<b>Click your nest</b> to select it, then right-click the glowing Forge. That sets a rally point: new dots walk there by themselves.',
          mobile: '<b>Tap your nest</b> to select it, then tap the glowing Forge. That sets a rally point: new dots walk there by themselves.',
        },
        done: (c) => ordered(c, 'rally'),
        highlight: () => [1],
      },
      {
        text: {
          desktop: 'Forges make <b>Shields</b>: slow and tough. Capture the Forge and the Hive below it.',
          mobile: 'Forges make <b>Shields</b>: slow and tough. Capture the Forge and the Hive below it.',
        },
        done: (c) => c.w.nests[1].owner === c.human && c.w.nests[2].owner === c.human,
        highlight: unowned([1, 2]),
      },
      {
        text: {
          desktop: 'Spires make <b>Spears</b>. The wheel (bottom right) shows who beats whom. Walls block the way: go through the gap and take the Spire.',
          mobile: 'Spires make <b>Spears</b>. The wheel shows who beats whom. Walls block the way: go through the gap and take the Spire.',
        },
        done: (c) => c.w.nests[3].owner === c.human,
        highlight: unowned([3]),
      },
    ],
  },
  {
    id: 'fight',
    title: 'First fight',
    teaches: 'Fight an enemy, use energy for Surge, and knock a player out.',
    learned: ['Fights start on their own when armies meet: bring more dots.', 'Energy builds over time and from captures; Surge spends it for a burst of speed and damage.', 'A player with no nests and no dots is out.'],
    locked: ['nova', 'upgrade', 'fortify', 'barrage', 'blink', 'lockdown'],
    setup: (portrait) =>
      versus(
        map(
          [
            nest(150, 340, NestType.Hive, 0, 14),
            nest(950, 340, NestType.Hive, 1, 6),
            nest(420, 170, NestType.Hive, -1, 4),
            nest(420, 510, NestType.Forge, -1, 5),
            nest(700, 340, NestType.Hive, -1, 6),
          ],
          { walls: [wall(560, 60, 560, 250), wall(560, 430, 560, 620)] },
        ),
        portrait,
        'turtler',
        30,
      ),
    steps: [
      {
        text: {
          desktop: 'An enemy (pink) lives on the right. Grow first: capture the two glowing nests.',
          mobile: 'An enemy (pink) lives on the right. Grow first: capture the two glowing nests.',
        },
        done: (c) => c.w.nests[2].owner === c.human && c.w.nests[3].owner === c.human,
        highlight: unowned([2, 3]),
      },
      {
        text: {
          desktop: 'Fights happen by themselves when armies meet. When yours does, select your dots and press <b>Surge (Q)</b>: faster, harder hitting.',
          mobile: 'Fights happen by themselves when armies meet. When yours does, select your dots and tap <b>Surge</b>: faster, harder hitting.',
        },
        done: (c) => ordered(c, 'surge'),
        highlight: unowned([4]),
      },
      {
        text: {
          desktop: 'Capture the enemy’s home nest and finish its dots to knock it out.',
          mobile: 'Capture the enemy’s home nest and finish its dots to knock it out.',
        },
        done: won,
        highlight: (c) => c.w.nests.filter((n) => n.owner !== c.human && n.owner >= 0 && n.owner !== NEUTRAL).map((n) => n.id),
      },
    ],
  },
  {
    id: 'powers',
    title: 'Grow stronger',
    teaches: 'Level up nests, and use Barrage and Nova.',
    learned: ['Feeding dots into a nest levels it up: faster spawns and a turret.', 'Holding a nest type unlocks its power: a Spire gives Barrage.', 'Nova blasts everything around the selected dots: save it for big fights.'],
    locked: ['fortify', 'blink', 'lockdown'],
    setup: (portrait) =>
      solo(
        map(
          [
            nest(200, 340, NestType.Hive, 0, 30),
            nest(330, 160, NestType.Spire, 0, 2, { capital: false }),
            nest(760, 340, NestType.Bastion, -1, 10),
            nest(600, 560, NestType.Hive, -1, 6),
          ],
          {
            fields: [{ kind: 'nebula', x1: 560, y1: 120, x2: 640, y2: 200, r: 60 }],
            events: { params: { swarm: { first: 70, every: 45, size: 22 }, drop: null, colossus: [], regrow: 0 }, swarmSpawns: [[1080, 120]], dropSpots: [], colossusPaths: [] },
          },
        ),
        portrait,
        100,
      ),
    steps: [
      {
        text: {
          desktop: 'Select your home nest with dots next to it and press <b>Upgrade (U)</b>: dots feed it up to level 2, which spawns faster and shoots back.',
          mobile: 'Tap your home nest while dots are next to it, then tap <b>Upgrade</b>: dots feed it up to level 2, which spawns faster and shoots back.',
        },
        done: (c) => c.w.nests.some((n) => n.owner === c.human && n.level >= 2),
        highlight: () => [0],
      },
      {
        text: {
          desktop: 'Your Spire unlocks <b>Barrage (F)</b>: artillery where you aim. Press it, then click the guards of the Bastion.',
          mobile: 'Your Spire unlocks <b>Barrage</b>: artillery where you aim. Tap it, then tap the guards of the Bastion.',
        },
        done: (c) => ordered(c, 'barrage'),
        highlight: () => [2],
      },
      {
        text: {
          desktop: 'A wild swarm is coming from the top right. Gather your army at home, and when the swarm arrives select them and press <b>Nova (E)</b>.',
          mobile: 'A wild swarm is coming from the top right. Gather your army at home, and when the swarm arrives select them and tap <b>Nova</b>.',
        },
        done: (c) => ordered(c, 'nova'),
        highlight: () => [0],
      },
      {
        text: {
          desktop: 'Finish the job: capture the Bastion. Bastions shoot back hard, so go in big.',
          mobile: 'Finish the job: capture the Bastion. Bastions shoot back hard, so go in big.',
        },
        done: (c) => c.w.nests[2].owner === c.human,
        highlight: unowned([2]),
      },
    ],
  },
  {
    id: 'domination',
    title: 'Domination',
    teaches: 'Terrain, crystals, and winning by holding most of the map.',
    learned: ['Walls block movement and fire; nebula slows everything inside it.', 'Dots standing on a crystal charge your energy.', 'Hold the marked share of nests for 30 seconds to win by domination.'],
    locked: ['fortify', 'blink', 'lockdown'],
    // 5 of 9 nests: room to lose one to a raid and keep the countdown going.
    setup: (portrait) => ({
      domShare: 0.55,
      ...versus(
        map(
          [
            nest(140, 340, NestType.Hive, 0, 14),
            // A dug-in enemy home, so holding the map wins before a knockout does.
            nest(960, 340, NestType.Hive, 1, 22, { level: 2 }),
            nest(330, 140, NestType.Forge, -1, 5),
            nest(330, 540, NestType.Spire, -1, 5),
            nest(550, 340, NestType.Hive, -1, 9, { level: 2 }),
            nest(770, 140, NestType.Spire, -1, 5),
            nest(770, 540, NestType.Forge, -1, 5),
            nest(550, 110, NestType.Hive, -1, 4),
            nest(550, 570, NestType.Hive, -1, 4),
          ],
          {
            walls: [wall(440, 230, 440, 290), wall(440, 390, 440, 450), wall(660, 230, 660, 290), wall(660, 390, 660, 450)],
            fields: [{ kind: 'nebula', x1: 230, y1: 340, x2: 260, y2: 340, r: 50 }],
            crystals: [{ x: 300, y: 340, r: 34 }],
          },
        ),
        portrait,
        'turtler',
      ),
    }),
    steps: [
      {
        text: {
          desktop: 'Crystals charge energy while your dots stand on them. Park a few dots on the glowing crystal near home.',
          mobile: 'Crystals charge energy while your dots stand on them. Park a few dots on the glowing crystal near home.',
        },
        done: (c) => c.w.crystals.some((k) => k.holder === c.human),
      },
      {
        text: {
          desktop: 'Take the glowing nests. The top bar shows nests held: <b>stay past its marker for 30 seconds</b> to win by domination. No need to storm the enemy’s home.',
          mobile: 'Take the glowing nests. The top bar shows nests held: <b>stay past its marker for 30 seconds</b> to win by domination. No need to storm the enemy’s home.',
        },
        done: won,
        // The neutral nests to take; once they're held, home: hold on rather than attack.
        highlight: (c) => {
          const left = c.w.nests.filter((n) => n.owner !== c.human && !n.capital).map((n) => n.id);
          return left.length ? left : [0];
        },
      },
    ],
  },
];

/** Advances through one mission's steps as the match plays. */
export class MissionRun {
  step = 0;
  constructor(
    readonly mission: Mission,
    readonly index: number,
  ) {}

  get complete(): boolean {
    return this.step >= this.mission.steps.length;
  }

  get current(): Step | null {
    return this.mission.steps[this.step] ?? null;
  }

  /** Check the current step (and any that are already satisfied). True if it moved on. */
  update(c: StepCtx): boolean {
    const before = this.step;
    while (!this.complete && this.mission.steps[this.step].done(c)) this.step++;
    return this.step !== before;
  }
}

// ---- progress --------------------------------------------------------------

export interface TutorialProgress {
  /** missions completed, by id */
  done: string[];
  /** finished the last mission */
  graduated: boolean;
  /** the first-launch offer was answered */
  offered: boolean;
  /** suggestion shown on the main menu after graduating */
  next?: NextStep;
}

/** graduate: the 1v1 wasn't played yet; ffa: they won it; rematch: they lost it */
export type NextStep = 'graduate' | 'ffa' | 'rematch';

const KEY = 'swarm.tutorial';

export function loadProgress(): TutorialProgress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { done: [], graduated: false, offered: false, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { done: [], graduated: false, offered: false };
}

export function saveProgress(p: TutorialProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** The first mission not yet completed (or 0 to start over). */
export function nextMission(p: TutorialProgress): number {
  const i = MISSIONS.findIndex((m) => !p.done.includes(m.id));
  return i < 0 ? 0 : i;
}
