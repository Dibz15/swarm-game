import { EVENT_PRESETS, type EventSpec, type MapSpec, type NestSpec } from '../sim/mapgen';
import { NEUTRAL, NestType, POWER, TICK_HZ, UPGRADE_PICK_RADIUS } from '../sim/constants';
import type { MatchSetup } from '../sim/setup';
import type { CrystalSpec, FieldSpec, Capsule } from '../sim/terrain';
import type { World } from '../sim/world';
import type { DemoAction } from '../ui/demo';
import { feedNeed, novaRadius, type Command } from '../sim/commands';
import { nestIcon } from '../ui/nesticon';
import { inArmy, UNIT_FEEDING, WILD_SWARM } from '../sim/world';
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
  /** where in `log` the current step began (#115): orders after it are this step's */
  since?: number;
}

export interface Step {
  /** what to do now; mobile mode gets touch wording */
  text: { desktop: string; mobile: string };
  done: (c: StepCtx) => boolean;
  /** nests to pulse while this step is active */
  highlight?: (c: StepCtx) => number[];
  /** a ghost cursor acting the step out on the map (world coordinates) */
  demo?: (c: StepCtx) => DemoAction[];
  /** a HUD element to make glow (a selector inside the HUD), for steps about the HUD */
  pulse?: string;
  /** a live line under the instruction (a countdown, say) */
  status?: (c: StepCtx) => string | null;
  /** commands issued (as the player) when the step begins: summon its swarm, say */
  enter?: (c: StepCtx) => Command[];
  /**
   * Once you've done your part and the step waits on the world (#115): what
   * the coach says instead of the action hint ("your dots are on their way").
   */
  wait?: { text: { desktop: string; mobile: string }; when: (c: StepCtx) => boolean };
  /** a tour step (#115): the game holds and the coach shows Next; `MissionRun.ack` moves on */
  next?: true;
  /** a HUD element brought to the middle of the screen, enlarged, while the step lasts (it goes home after) */
  spotlight?: string;
}

export interface Mission {
  id: string;
  title: string;
  /** one line for the briefing: what this mission teaches */
  teaches: string;
  /** debrief bullets */
  learned: string[];
  setup: () => MatchSetup;
  locked: Lock[];
  /** hold the game for a few seconds whenever the instruction changes, so it can be read first */
  readPause?: boolean;
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

const solo = (m: MapSpec, energy = 0): MatchSetup => ({
  seed: 1701,
  size: 'small',
  map: m,
  endless: true,
  players: [{ faction: 0, team: 0, human: true, energy }],
});

const versus = (m: MapSpec, personality: 'turtler' | 'expander', energy = 0, passive = false, unitCap = 0, prod?: number): MatchSetup => ({
  seed: 1702,
  size: 'small',
  map: m,
  players: [
    { faction: 0, team: 0, human: true, energy },
    { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality, passive }, unitCap, prod },
  ],
});

// ---- step checks -------------------------------------------------------------

const owned = (c: StepCtx) => c.w.nests.filter((n) => n.owner === c.human).length;
const ordered = (c: StepCtx, t: TimedCommand['cmd']['t']) => c.log.some((l) => l.cmd.t === t);
const unowned = (ids: number[]) => (c: StepCtx) => ids.filter((id) => c.w.nests[id]?.owner !== c.human);
const won = (c: StepCtx) => c.w.over && c.w.winnerTeam === c.w.teamOf[c.human];

/** Orders given since the current step began. */
const sinceStep = (c: StepCtx) => c.log.slice(c.since ?? 0);
const orderedSince = (c: StepCtx, t: TimedCommand['cmd']['t']) => sinceStep(c).some((l) => l.cmd.t === t);
/** Dots sent (or a rally set) at one of these nests since the step began. */
const sentTo = (ids: (c: StepCtx) => number[]) => (c: StepCtx): boolean => {
  const want = ids(c).map((id) => c.w.nests[id]);
  return sinceStep(c).some(({ cmd }) => {
    if (cmd.t !== 'move' && cmd.t !== 'rally') return false;
    return want.some((n) => (cmd.t === 'move' && cmd.nest === n.id) || (cmd.x - n.x) ** 2 + (cmd.y - n.y) ** 2 <= (n.r * 1.6) ** 2);
  });
};
/** The waiting line once dots are on their way: what the lesson waits for. */
const onTheWay = (what: string): { desktop: string; mobile: string } => {
  const t = `⏳ Your dots are on their way. The lesson goes on when they ${what}.`;
  return { desktop: t, mobile: t };
};
/** Wait for the dots sent at these nests to take them. */
const waitTake = (ids: number[], what: string): Step['wait'] => ({ text: onTheWay(what), when: sentTo(() => ids) });

/** Your dots within reach of a nest, against what feeding it needs (#115). */
function feedStatus(c: StepCtx, id: number): string | null {
  const n = c.w.nests[id];
  if (n.owner !== c.human || n.level >= 2) return null;
  let near = 0;
  for (let i = 0; i < c.w.n; i++) {
    if (c.w.owner[i] === c.human && inArmy(c.w, i) && (c.w.x[i] - n.x) ** 2 + (c.w.y[i] - n.y) ** 2 <= UPGRADE_PICK_RADIUS ** 2) near++;
  }
  const need = Math.max(0, feedNeed(n));
  if (n.feedIncoming > 0) return null;
  return near < need
    ? `Dots near your nest: <b>${near}</b>, it needs ${need}: bring more`
    : `Dots near your nest: <b>${near}</b>, it needs ${need}: enough, upgrade now`;
}

// ---- demos -------------------------------------------------------------------

/** Box-select the main group of the player's dots (the ones near their middle). */
function selectArmy(c: StepCtx, max = 260): DemoAction[] {
  const { w, human } = c;
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i] || w.owner[i] !== human || w.state[i] === UNIT_FEEDING) continue;
    cx += w.x[i];
    cy += w.y[i];
    n++;
  }
  if (!n) return [];
  cx /= n;
  cy /= n;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i] || w.owner[i] !== human || w.state[i] === UNIT_FEEDING) continue;
    if ((w.x[i] - cx) ** 2 + (w.y[i] - cy) ** 2 > max * max) continue;
    x0 = Math.min(x0, w.x[i]);
    y0 = Math.min(y0, w.y[i]);
    x1 = Math.max(x1, w.x[i]);
    y1 = Math.max(y1, w.y[i]);
  }
  return [{ t: 'drag', from: [x0 - 24, y0 - 24], to: [x1 + 24, y1 + 24] }];
}

const at = (c: StepCtx, id: number): [number, number] => [c.w.nests[id].x, c.w.nests[id].y];
/** Select the army and send it at the first nest in `ids` the player doesn't hold. */
const sendTo = (ids: (c: StepCtx) => number[]) => (c: StepCtx): DemoAction[] => {
  const id = ids(c).find((i) => c.w.nests[i].owner !== c.human);
  return id === undefined ? [] : [...selectArmy(c), { t: 'tap', at: at(c, id), order: true }];
};

/** Seconds from the Nova step starting to its swarm appearing at the map edge. */
const SWARM_LEAD = 3;

/** Is an enemy inside the Nova that the player's dots near `home` would cast? */
function inNovaReach(c: StepCtx, home: { x: number; y: number }, wild: boolean): boolean {
  const { w, human } = c;
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i] || w.owner[i] !== human || w.state[i] === UNIT_FEEDING) continue;
    if ((w.x[i] - home.x) ** 2 + (w.y[i] - home.y) ** 2 > 300 * 300) continue;
    cx += w.x[i];
    cy += w.y[i];
    n++;
  }
  if (n < 4) return false;
  cx /= n;
  cy /= n;
  const r = novaRadius(n);
  for (let i = 0; i < w.n; i++) {
    if (!w.alive[i] || (wild ? w.wild[i] !== WILD_SWARM : !w.hostile(w.owner[i], human))) continue;
    if ((w.x[i] - cx) ** 2 + (w.y[i] - cy) ** 2 < r * r) return true;
  }
  return false;
}

/** A countdown, then "wait for it", then "now": Nova only hits around your dots. */
function swarmStatus(c: StepCtx): string | null {
  const ev = c.w.events;
  if (!ev) return null;
  let wild = 0;
  for (let i = 0; i < c.w.n; i++) if (c.w.alive[i] && c.w.wild[i] === WILD_SWARM) wild++;
  if (wild > 0) {
    return inNovaReach(c, c.w.nests[0], true)
      ? '<b>It’s on your dots: Nova now!</b>'
      : 'Here it comes. <b>Wait until it reaches your dots</b>: Nova only hits around them.';
  }
  const secs = Math.max(0, Math.ceil((ev.nextSwarm - c.w.tick) / TICK_HZ));
  return secs > 600 ? null : `Wild swarm in ${secs} s…`;
}

// ---- the missions ----------------------------------------------------------------

export const MISSIONS: Mission[] = [
  {
    id: 'move',
    title: 'First steps',
    teaches: 'Select your dots, send them, and capture nests.',
    learned: ['Select dots, then give them an order.', 'Move as one group: gather your dots, then send them together.', 'Nests you capture make more dots.'],
    locked: ALL_POWERS,
    setup: () => solo(map([nest(170, 340, NestType.Hive, 0, 12), nest(480, 300, NestType.Hive, -1, 3), nest(820, 400, NestType.Hive, -1, 6)])),
    steps: [
      {
        text: {
          desktop: 'Drag a box around your dots to select them, then <b>right-click</b> the glowing nest to send them.',
          mobile: 'Drag across your dots to select them, then <b>tap</b> the glowing nest to send them.',
        },
        done: (c) => owned(c) >= 2,
        highlight: unowned([1]),
        wait: waitTake([1], 'capture the glowing nest'),
        demo: sendTo(() => [1]),
      },
      {
        text: {
          desktop: 'Captured nests make dots for you. The last nest has more guards: <b>select all your dots and send them together</b>, as one group. <small>WASD or middle-drag moves the map, the wheel zooms.</small>',
          mobile: 'Captured nests make dots for you. The last nest has more guards: <b>select all your dots and send them together</b>, as one group. <small>Two fingers move and zoom the map.</small>',
        },
        done: (c) => owned(c) >= 3,
        highlight: unowned([2]),
        wait: waitTake([2], 'capture it'),
        demo: sendTo(() => [2]),
      },
    ],
  },
  {
    id: 'rally',
    title: 'Rally and nest types',
    teaches: 'Send new dots where they are needed, and meet the three unit types.',
    learned: [
      'A nest’s rally point sends its new dots straight to the front.',
      `${nestIcon(NestType.Hive)} Hives make Swarmers, ${nestIcon(NestType.Forge)} Forges make Shields, ${nestIcon(NestType.Spire)} Spires make Spears.`,
      'Swarmers beat Spears, Spears beat Shields, Shields beat Swarmers.',
    ],
    locked: ALL_POWERS,
    setup: () =>
      solo(
        map(
          [nest(160, 340, NestType.Hive, 0, 12), nest(470, 180, NestType.Forge, -1, 7), nest(560, 500, NestType.Hive, -1, 5), nest(900, 340, NestType.Spire, -1, 10)],
          { walls: [wall(700, 140, 700, 280), wall(700, 400, 700, 540)] },
        ),
      ),
    steps: [
      {
        text: {
          desktop: `<b>Click your nest</b> to select it, then right-click the glowing Forge ${nestIcon(NestType.Forge)}. That sets a rally point: new dots walk there by themselves.`,
          mobile: `<b>Drag across your nest</b> (dots and all) to select it, then tap the glowing Forge ${nestIcon(NestType.Forge)}. That sets a rally point: new dots walk there by themselves.`,
        },
        done: (c) => ordered(c, 'rally'),
        highlight: () => [1],
        demo: (c) => [{ t: 'tap', at: at(c, 0) }, { t: 'tap', at: at(c, 1), order: true }],
      },
      {
        text: {
          desktop: `Forges ${nestIcon(NestType.Forge)} make <b>Shields</b>: slow and tough. Capture the Forge and the Hive ${nestIcon(NestType.Hive)} below it.`,
          mobile: `Forges ${nestIcon(NestType.Forge)} make <b>Shields</b>: slow and tough. Capture the Forge and the Hive ${nestIcon(NestType.Hive)} below it.`,
        },
        done: (c) => c.w.nests[1].owner === c.human && c.w.nests[2].owner === c.human,
        highlight: unowned([1, 2]),
        wait: { text: onTheWay('hold the Forge and the Hive'), when: (c) => [1, 2].every((id) => c.w.nests[id].owner === c.human || sentTo(() => [id])(c)) },
        demo: sendTo(() => [1, 2]),
      },
      // Rock, paper, scissors (#115): the wheel comes to the middle, then goes home to its corner.
      {
        text: {
          desktop: 'Every type beats one and loses to another: <b>Swarmers overrun Spears, Spears pierce Shields, Shields stop Swarmers</b>. This wheel shows it. It lives in the corner, and lights up for the dots you select or the enemy you point at.',
          mobile: 'Every type beats one and loses to another: <b>Swarmers overrun Spears, Spears pierce Shields, Shields stop Swarmers</b>. This wheel shows it. It lives in the corner, and lights up for the dots you select.',
        },
        next: true,
        spotlight: '.counters',
        done: () => false,
      },
      {
        text: {
          desktop: `Spires ${nestIcon(NestType.Spire)} make <b>Spears</b>. Walls block the way: go through the gap and take the Spire.`,
          mobile: `Spires ${nestIcon(NestType.Spire)} make <b>Spears</b>. Walls block the way: go through the gap and take the Spire.`,
        },
        pulse: '.counters',
        done: (c) => c.w.nests[3].owner === c.human,
        highlight: unowned([3]),
        wait: waitTake([3], 'capture the Spire'),
        demo: sendTo(() => [3]),
      },
    ],
  },
  {
    id: 'fight',
    title: 'First fight',
    teaches: 'Fight an enemy, use energy for Surge, and knock a player out.',
    learned: [
      'Fights start on their own when armies meet: bring more dots.',
      'Energy builds over time and from captures; powers spend it. Surge gives your selected dots a burst of speed and damage.',
      'Holding a nest type unlocks its power: a Spire gives Barrage, a Den gives Blink.',
      'A player with no nests and no dots is out.',
    ],
    locked: ['nova', 'upgrade', 'fortify', 'barrage', 'blink', 'lockdown'],
    setup: () =>
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
        'turtler',
        30,
        // A lesson, not a race: it defends but never comes for your nests,
        // and stays small however long you take.
        true,
        14,
      ),
    steps: [
      {
        text: {
          desktop: 'An enemy (pink) lives on the right. Grow first: capture the two glowing nests.',
          mobile: 'An enemy (pink) lives on the right. Grow first: capture the two glowing nests.',
        },
        done: (c) => c.w.nests[2].owner === c.human && c.w.nests[3].owner === c.human,
        highlight: unowned([2, 3]),
        wait: { text: onTheWay('hold both nests'), when: (c) => [2, 3].every((id) => c.w.nests[id].owner === c.human || sentTo(() => [id])(c)) },
        demo: sendTo(() => [2, 3]),
      },
      // A short tour of the screen before the first power (#115).
      {
        text: {
          desktop: 'Before the fight, a quick look around. This bar is your <b>energy</b>. It builds up over time, and faster with every nest you capture.',
          mobile: 'Before the fight, a quick look around. This bar is your <b>energy</b>. It builds up over time, and faster with every nest you capture.',
        },
        next: true,
        pulse: '.energy',
        done: () => false,
      },
      {
        text: {
          desktop: '<b>Powers</b> spend energy. Surge is always here; others unlock as you hold nest types: a Spire gives Barrage, a Den gives Blink.',
          mobile: '<b>Powers</b> spend energy. Surge is always here; others unlock as you hold nest types: a Spire gives Barrage, a Den gives Blink.',
        },
        next: true,
        pulse: '.actions',
        done: () => false,
      },
      {
        text: {
          desktop: 'Powers act on the dots you have <b>selected</b>: drag over them, or press <b>All (Z)</b> to take every one. Select first, then cast.',
          mobile: 'Powers act on the dots you have <b>selected</b>: drag over them, or tap <b>All</b> to take every one. Select first, then cast.',
        },
        next: true,
        pulse: '[data-a=all]',
        done: () => false,
      },
      {
        text: {
          desktop: `Fights happen by themselves when armies meet. When yours does, select your dots and press <b>Surge (Q)</b>. It <b>spends ${POWER.surgeCost} energy</b>: your dots run faster and hit harder for a while. Watch the energy bar drop.`,
          mobile: `Fights happen by themselves when armies meet. When yours does, select your dots and tap <b>Surge</b>. It <b>spends ${POWER.surgeCost} energy</b>: your dots run faster and hit harder for a while. Watch the energy bar drop.`,
        },
        done: (c) => ordered(c, 'surge'),
        highlight: unowned([4]),
        pulse: '.energy',
        status: (c) => `Energy: <b>${Math.floor(c.w.factions[c.human].energy)}</b>${c.w.factions[c.human].energy < POWER.surgeCost ? ` (Surge needs ${POWER.surgeCost})` : ''}`,
        demo: (c) => [...selectArmy(c), { t: 'button', a: 'surge' }],
      },
      {
        text: {
          desktop: 'Capture the enemy’s home nest and finish its dots to knock it out.',
          mobile: 'Capture the enemy’s home nest and finish its dots to knock it out.',
        },
        done: won,
        highlight: (c) => c.w.nests.filter((n) => n.owner !== c.human && n.owner >= 0 && n.owner !== NEUTRAL).map((n) => n.id),
        wait: { text: onTheWay('knock the enemy out'), when: sentTo((c) => c.w.nests.filter((n) => n.owner !== c.human && n.owner >= 0 && n.owner !== NEUTRAL).map((n) => n.id)) },
        demo: sendTo((c) => c.w.nests.filter((n) => n.owner !== c.human && n.owner >= 0 && n.owner !== NEUTRAL).map((n) => n.id)),
      },
    ],
  },
  {
    id: 'powers',
    title: 'Grow stronger',
    teaches: 'Level up nests, and use Barrage and Nova.',
    learned: ['Feeding dots into a nest levels it up: faster spawns and a turret.', 'Holding a nest type unlocks its power: a Spire gives Barrage, which reaches targets near your nests.', 'Nova blasts everything around the selected dots: save it for big fights.'],
    locked: ['fortify', 'blink', 'lockdown'],
    readPause: true,
    setup: () =>
      solo(
        map(
          [
            nest(200, 340, NestType.Hive, 0, 30),
            nest(330, 160, NestType.Spire, 0, 2, { capital: false }),
            // Within Barrage range of the Spire (#41).
            nest(690, 330, NestType.Bastion, -1, 10),
            nest(600, 560, NestType.Hive, -1, 6),
          ],
          {
            fields: [{ kind: 'nebula', x1: 560, y1: 120, x2: 640, y2: 200, r: 60 }],
            // Swarms come when the Nova step summons them (then every 35 s), big
            // enough to outlast the home turret for a few seconds.
            events: { params: { swarm: { first: 100000, every: 35, size: 32 }, drop: null, colossus: [], regrow: 0 }, swarmSpawns: [[780, 40]], dropSpots: [[420, 340], [560, 420]], colossusPaths: [] },
          },
        ),
        100,
      ),
    steps: [
      {
        text: {
          desktop: 'A nest levels up by <b>feeding it dots</b>: enough of your dots must stand next to it. Select your home nest and press <b>Upgrade (U)</b>. Level 2 spawns faster and shoots back.',
          mobile: 'A nest levels up by <b>feeding it dots</b>: enough of your dots must stand next to it. Tap your home nest, then tap <b>Upgrade</b>. Level 2 spawns faster and shoots back.',
        },
        done: (c) => c.w.nests.some((n) => n.owner === c.human && n.level >= 2),
        highlight: () => [0],
        status: (c) => feedStatus(c, 0),
        wait: {
          text: { desktop: '⏳ Your dots are feeding the nest: it levels up when they’re all in.', mobile: '⏳ Your dots are feeding the nest: it levels up when they’re all in.' },
          when: (c) => orderedSince(c, 'upgrade') && c.w.nests[0].feedIncoming > 0,
        },
        demo: (c) => [{ t: 'tap', at: at(c, 0) }, { t: 'button', a: 'upgrade' }],
      },
      {
        text: {
          desktop: `Your Spire ${nestIcon(NestType.Spire)} unlocks <b>Barrage (F)</b>: a shell launched from your nearest nest. Press it, then click the guards of the Bastion ${nestIcon(NestType.Bastion)}.`,
          mobile: `Your Spire ${nestIcon(NestType.Spire)} unlocks <b>Barrage</b>: a shell launched from your nearest nest. Tap it, then tap the guards of the Bastion ${nestIcon(NestType.Bastion)}.`,
        },
        // Done once the shell has landed, so the next lesson doesn't freeze it mid-air (#115).
        done: (c) => ordered(c, 'barrage') && !c.w.barrages.some((b) => b.owner === c.human),
        wait: {
          text: { desktop: '⏳ Shell in the air: watch it land on the guards.', mobile: '⏳ Shell in the air: watch it land on the guards.' },
          when: (c) => c.w.barrages.some((b) => b.owner === c.human),
        },
        highlight: () => [2],
        demo: (c) => [{ t: 'button', a: 'barrage' }, { t: 'tap', at: at(c, 2) }],
      },
      {
        text: {
          desktop: 'A wild swarm is on its way. Gather your army at home, and when the swarm arrives select them and press <b>Nova (E)</b>.',
          mobile: 'A wild swarm is on its way. Gather your army at home, and when the swarm arrives select them and tap <b>Nova</b>.',
        },
        done: (c) => ordered(c, 'nova'),
        highlight: () => [0],
        status: swarmStatus,
        enter: (c) => [{ t: 'summon', p: c.human, secs: SWARM_LEAD }],
        demo: (c) => [...selectArmy(c), { t: 'button', a: 'nova' }],
      },
      {
        text: {
          desktop: `Finish the job: capture the Bastion ${nestIcon(NestType.Bastion)}. Bastions shoot back hard, so go in big.`,
          mobile: `Finish the job: capture the Bastion ${nestIcon(NestType.Bastion)}. Bastions shoot back hard, so go in big.`,
        },
        done: (c) => c.w.nests[2].owner === c.human,
        highlight: unowned([2]),
        wait: waitTake([2], 'capture the Bastion'),
        demo: sendTo(() => [2]),
      },
    ],
  },
  {
    id: 'domination',
    title: 'Domination',
    teaches: 'Terrain, crystals, and winning by holding most of the map.',
    learned: ['Walls block movement and fire; nebula slows everything inside it.', 'Dots standing on a crystal charge your energy.', 'Hold the marked share of nests for 30 seconds to win by domination.'],
    locked: ['fortify', 'blink', 'lockdown'],
    readPause: true,
    // 5 of 9 nests: room to lose one to a raid and keep the countdown going.
    setup: () => ({
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
        'turtler',
        0,
        false,
        // Not a full match yet (#115): it still raids, but builds at 40% speed and keeps a small army.
        18,
        0.4,
      ),
    }),
    steps: [
      {
        text: {
          desktop: 'Crystals charge energy while your dots stand on them. Park a few dots on the glowing crystal near home.',
          mobile: 'Crystals charge energy while your dots stand on them. Park a few dots on the glowing crystal near home.',
        },
        done: (c) => c.w.crystals.some((k) => k.holder === c.human),
        wait: {
          text: { desktop: '⏳ Dots heading to the crystal: it starts charging when they stand on it.', mobile: '⏳ Dots heading to the crystal: it starts charging when they stand on it.' },
          when: (c) => sinceStep(c).some(({ cmd }) => cmd.t === 'move' && (cmd.x - c.w.crystals[0].x) ** 2 + (cmd.y - c.w.crystals[0].y) ** 2 <= (c.w.crystals[0].r * 1.5) ** 2),
        },
        demo: (c) => [...selectArmy(c, 80), { t: 'tap', at: [c.w.crystals[0].x, c.w.crystals[0].y], order: true }],
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
        demo: sendTo((c) => c.w.nests.filter((n) => n.owner !== c.human && !n.capital).map((n) => n.id)),
      },
    ],
  },
];

/** Advances through one mission's steps as the match plays. */
export class MissionRun {
  step = 0;
  /** where in the order log the current step began (#115) */
  since = 0;
  /** the player pressed Next on a tour step */
  private acked = false;
  /** step-entry commands waiting to be issued */
  private queue: Command[] = [];
  private entered = -1;
  constructor(
    readonly mission: Mission,
    readonly index: number,
  ) {}

  /** Commands the current step wants issued when it begins (once). */
  take(c: StepCtx): Command[] {
    if (this.entered !== this.step && !this.complete) {
      this.entered = this.step;
      this.queue.push(...(this.mission.steps[this.step].enter?.(c) ?? []));
    }
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get complete(): boolean {
    return this.step >= this.mission.steps.length;
  }

  get current(): Step | null {
    return this.mission.steps[this.step] ?? null;
  }

  /** The context for the current step: orders since it began. */
  ctx(c: StepCtx): StepCtx {
    return { ...c, since: this.since };
  }

  /** Next, on a tour step. */
  ack(): void {
    if (this.current?.next) this.acked = true;
  }

  /** Has the player done their part, so the step now waits on the world? */
  waiting(c: StepCtx): boolean {
    return !!this.current?.wait?.when(this.ctx(c));
  }

  /** Check the current step (and any that are already satisfied). True if it moved on. */
  update(c: StepCtx): boolean {
    const before = this.step;
    while (!this.complete) {
      const s = this.mission.steps[this.step];
      if (!(s.next ? this.acked : s.done(this.ctx(c)))) break;
      this.step++;
      this.acked = false;
      this.since = c.log.length;
    }
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

/**
 * Is mission `i` open to play (#115)? The first always; then once the one
 * before is done, or you've already reached it or beyond (or graduated).
 */
export const missionUnlocked = (p: TutorialProgress, i: number): boolean =>
  i === 0 || p.graduated || MISSIONS.slice(i - 1).some((m) => p.done.includes(m.id));

/** The first mission not yet completed (or 0 to start over). */
export function nextMission(p: TutorialProgress): number {
  const i = MISSIONS.findIndex((m) => !p.done.includes(m.id));
  return i < 0 ? 0 : i;
}
