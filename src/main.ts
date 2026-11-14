import './style.css';
import { teamLayout, teamsList } from './ui/teams';
import { AudioEngine } from './audio/engine';
import { FACTION_HEX, FACTION_RGB } from './content/factions';
import { GameView, type Services } from './game/gameView';
import type { EndReason, Recording } from './game/recording';
import { allMatches, deleteMatch, downloadJson, loadMatch, recordingEnabled, saveMatch, saveRecording } from './game/recordStore';
import type { MatchSave } from './net/matchSave';
import type { Character } from './game/character';
import { LocalSession } from './game/session';
import { ordinal } from './game/standing';
import { loadProgress, MISSIONS, MissionRun, nextMission, saveProgress } from './game/tutorial';
import { InputController } from './input/controller';
import { Camera } from './render/camera';
import { Particles, Rings } from './render/particles';
import { Renderer } from './render/renderer';
import { drawWorld } from './render/scene';
import { PERSONALITIES } from './sim/ai/bot';
import { Kind, MAX_UNITS, NEUTRAL, TICK_HZ } from './sim/constants';
import type { MatchSetup } from './sim/setup';
import { spawnUnit } from './sim/world';
import { mapBloom, needsBattle, newRun, resolveTurn, type RunNode, type RunState, type TurnResult } from './campaign/run';
import { battleType, briefingFor, briefsSeen, markBriefSeen, resetBriefs, type BriefLord } from './campaign/briefings';
import type { BattleReport } from './campaign/broods';
import { battleReport, nodeSetup, warlordOf } from './campaign/battle';
import { PLAYTEST, type Playtest } from './campaign/playtest';
import { playtestMenu } from './ui/playtest';
import { fortressGrid } from './ui/fortressGrid';
import { mapGrid } from './ui/mapGrid';
import { FORTIFY } from './sim/fortify';
import { deleteRun, finishRun, listRuns, loadHistory, saveRun } from './campaign/store';
import { recruitPick, rewardPick, runDebrief, runHub, runMap, starterPick, type MapIntro } from './ui/campaign';
import { runHowTo } from './ui/runtour';
import { loadGuide, saveGuide, wantsTour } from './campaign/tour';
import { DemoOverlay } from './ui/demo';
import { Hud } from './ui/hud';
import { ScreenAwake } from './ui/wakeLock';
import { initUiMode, isMobile, markMobileNoticeSeen, onCellData, setUiMode, shouldShowMobileNotice } from './ui/mobile';
import { buildSetup, campaignMenu, randomSetup, skirmishMenu, endScreen, howToPlay, loadPrefs, mainMenu, menuCard, missionBriefing, missionDebrief, mobileNotice, NEXT_STEP_TEXT, pauseMenu, quickSetup, randomSeed, settingsScreen, skirmishSetup, tutorialMenu } from './ui/screens';
import { creatureGrid } from './ui/creatures';
import { BUILD } from './game/recording';
import type { DesyncReport } from './net/desync';
import type { GuestLobby, HostGo, HostLobby, HostLobbyOptions, LobbyState, StartInfo } from './net/lobby';
import type { NetMatch } from './net/match';
import type { Router, Transport } from './net/transport';
import { DELAY_BAD_MS, DELAY_WARN_MS, formatTime } from './ui/hud';
import type { LobbyView } from './ui/lobby';
import { FACTION_NAMES } from './content/factions';
import { relayOnly } from './net/ice';

/** the multiplayer code, loaded on first use */
type Mp = typeof import('./net/mp');
let mpModule: Promise<Mp> | null = null;
const loadMp = (): Promise<Mp> => (mpModule ??= import('./net/mp'));

/** A multiplayer room this tab is in (#162): its lobby, and the screen showing it. */
interface Room {
  id: string;
  secret: string;
  /** we run the room: from the start, or since hosting passed to us (#166) */
  host: boolean;
  link: string;
  /** the characters on offer to us, for the room's screen */
  choices: Character[];
  /** this room's match as we saved it when everyone lost touch (#191): ours to pick up if nobody hosts it */
  save: MatchSave | null;
  /**
   * our seat token here (#164), read once: every hello, take-over and save
   * uses this one, so a save matches our seat's seal even with no
   * sessionStorage (#191)
   */
  token: string;
  view: LobbyView;
  router: Router | null;
  lobby: HostLobby | GuestLobby | null;
  /** the lobby state the screen last showed, for join and leave notices (#184) */
  seen: LobbyState | null;
  /** measures our links to the others every few seconds, for the roster (#184) */
  linkPoll: ReturnType<typeof setInterval> | null;
}

const ROOM_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const roomCode = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ROOM_CHARS[b % ROOM_CHARS.length]).join('');
/** `#room=<id>.<secret>` anywhere in a link or hash */
/**
 * This tab's seat token for a room (#164): kept in sessionStorage, so a
 * reload (same tab) gets its seat back mid-match; a new tab is a new player.
 * The host keeps it private; it never reaches other players.
 */
/** Our seat token for a room from a saved match (#191): the seat to get back, from a new tab too. */
function setSeatToken(room: string, token: string): void {
  try {
    sessionStorage.setItem(`swarm-seat:${room}`, token);
  } catch {
    /* no storage: seatToken makes a new one, and we join as a new player */
  }
}

function seatToken(room: string): string {
  const key = `swarm-seat:${room}`;
  try {
    const have = sessionStorage.getItem(key);
    if (have && /^[0-9a-f]{32}$/.test(have)) return have;
  } catch {
    /* no storage: a reload will be a new player */
  }
  const t = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(key, t);
  } catch {
    /* as above */
  }
  return t;
}

/**
 * The room this tab hosts, as it last was before a match (#184): a reload
 * finds it here and runs the room again, unless hosting was passed on.
 */
/**
 * The peers this tab told its seat token in a room (#202): after a reload,
 * one of them that comes up gets it straight away, with no question first.
 * They know it already, so nothing new leaks.
 */
const toldKey = (room: string) => `swarm-told:${room}`;
function loadTold(room: string): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(toldKey(room)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-16) : [];
  } catch {
    return [];
  }
}
function addTold(room: string, peer: string): void {
  try {
    sessionStorage.setItem(toldKey(room), JSON.stringify([...loadTold(room).filter((p) => p !== peer), peer].slice(-16)));
  } catch {
    /* no storage: a reload asks first */
  }
}

const hostedKey = (room: string) => `swarm-hosted:${room}`;
function saveHosted(room: string, state: LobbyState | null): void {
  try {
    if (state) sessionStorage.setItem(hostedKey(room), JSON.stringify(state));
    else sessionStorage.removeItem(hostedKey(room));
  } catch {
    /* no storage: a reload joins as a player */
  }
}
function loadHosted(room: string): string | null {
  try {
    return sessionStorage.getItem(hostedKey(room));
  } catch {
    return null;
  }
}

function parseRoom(s: string): { id: string; secret: string } | null {
  const m = /#room=([a-z0-9]{6,32})\.([a-z0-9]{8,64})/.exec(s.trim());
  return m ? { id: m[1], secret: m[2] } : null;
}
/** `?lag=400[&jitter=80&loss=0.02]` (#162): skirmishes run over a NetSession behind a simulated link */
function lagLink(): { latency: number; jitter: number; loss: number } | null {
  const q = new URLSearchParams(location.search);
  const lag = Number(q.get('lag'));
  if (!(lag > 0)) return null;
  return { latency: lag / 2, jitter: Number(q.get('jitter')) || 0, loss: Math.min(0.5, Number(q.get('loss')) || 0) };
}

class App {
  private canvas = document.getElementById('game') as HTMLCanvasElement;
  private ui = document.getElementById('ui') as HTMLDivElement;
  private perf = document.getElementById('perf') as HTMLDivElement;
  private renderer: Renderer;
  private camera = new Camera();
  private particles = new Particles();
  private rings = new Rings();
  private sfx = new AudioEngine();
  private input: InputController;
  private services: Services;

  private game: GameView | null = null;
  private hud: Hud | null = null;
  /** the networked match being played (#162), and the room it came from */
  private match: NetMatch | null = null;
  private room: Room | null = null;
  /** the multiplayer module, once loaded (a room or a match implies it is) */
  private mp: Mp | null = null;
  /** the pause menu in a networked match: opened by us, or because the host paused */
  private netMenu: 'user' | 'pause' | null = null;
  private netNote: HTMLElement | null = null;
  /** the pause menu's player table, and the latency report it last showed (#161) */
  private netPlayers: HTMLElement | null = null;
  private shownLat: unknown = null;
  /** background battle behind the menus */
  private demo: LocalSession | null = null;
  private screen: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  /** a full-screen modal (the run map) hides the menu and the demo: both pause under it (#130) */
  private covered = false;
  private endShown = false;
  /** an Easy bot had our seat (#164): its return is worth a word */
  private ownBot = false;
  /** the resume countdown's last second shown, for its tick (#198) */
  private resumeShown = -1;
  /** no word from the host; the match waits while a new one is found (#166) */
  private stalled = false;
  /** we lost touch with every other player (#191): the match stands still, saved (`saveFailed`: or not, storage refused) */
  private lostTouch = false;
  private saveFailed = false;
  /** we picked the room's match up from our save, and nobody is back yet (#191): saved again now and then, until someone is */
  private resumeKeep: ReturnType<typeof setInterval> | null = null;
  /** the desync card (#165), while the match is halted for one */
  private desyncView: { el: HTMLDivElement; detail: (text: string) => void; canResync: (on: boolean) => void } | null = null;
  /** the host's word on the last desync, which may come before the halt does */
  private desyncNote: { tick: number; text: string } | null = null;
  /** the current match's recording was saved at its end */
  private recSaved = false;
  /** a phone's screen stays on through a room match (#193) */
  private readonly awake = new ScreenAwake();
  /** dev, or `?debug` (#193): when the world last stepped, and the gaps between steps, ms: the stall a player sees */
  private stepAt = { tick: -1, at: 0, gaps: [] as number[] };
  private timeSteps = import.meta.env.DEV;
  /** difficulty of the current quick match, so "New map" rolls another one */
  private quick: number | null = null;
  /** the campaign run and node the current battle belongs to */
  private run: { state: RunState; node: number; fielded: number[] } | null = null;
  /** ghost cursor acting out the current tutorial step */
  private demoOverlay: DemoOverlay | null = null;
  private demoKey = '';
  private last = 0;
  private time = 0;
  private frames = 0;
  private fpsAcc = 0;
  private fps = 0;
  private showPerf = new URLSearchParams(location.search).has('debug');
  /** `?audiodebug` (#118): audio health under the perf line; `?debug` shows it too. */
  private showAudio = ['audiodebug', 'debug'].some((k) => new URLSearchParams(location.search).has(k));
  private audioAcc = 0;
  private audioText = '';
  private worstFrame = 0;
  private worstSim = 0;
  /** the last audio glitch the overlay saw, so a crackle heard can be matched to it */
  private glitch: { at: number; what: string } | null = null;
  private frame = 0;

  constructor() {
    this.renderer = new Renderer(this.canvas);
    this.input = new InputController(this.canvas, this.camera, this.renderer);
    this.input.onPause = () => this.togglePause();
    this.services = {
      renderer: this.renderer,
      camera: this.camera,
      particles: this.particles,
      rings: this.rings,
      sfx: this.sfx,
      toast: (m, c) => this.hud?.toast(m, c),
    };
    this.sfx.setListener(this.camera);
    window.addEventListener(
      'pointerdown',
      (e) => {
        this.sfx.unlock();
        const rec = this.game?.rec;
        if (rec) rec.source = e.target !== this.canvas ? 'hud' : e.pointerType === 'touch' ? 'touch' : 'mouse';
      },
      { capture: true },
    );
    // Save what we have when the tab is hidden: phones may never come back.
    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      if (hidden) this.saveRec('unload', false);
      // Hidden, the music can't keep time: sleep, and wake (or recover from an interruption) on return.
      this.sfx.setHidden(hidden);
      // In a room match, a hidden page's seat is away at once (#164); back, it's ours again. A phone that runs
      // the match hands that on as it goes (#193): hidden, it freezes
      this.match?.setHidden(hidden);
      // the browser let go of the screen's wake lock when the page hid (#193)
      if (!hidden) this.awake.shown();
    });
    // The browser is about to freeze the page (Page Lifecycle, #193): whoever ranks next runs the match from here.
    document.addEventListener('freeze', () => {
      if (this.match?.runner && !this.game?.world.over) this.match.handOffNow();
    });
    // Closing the page while hosting: hand hosting to the next player first (#166).
    window.addEventListener('pagehide', (e) => {
      if (e.persisted) return;
      if (this.match?.runner && !this.game?.world.over) this.match.handOff();
      // in the room before a match: the next player runs it (#184); with nobody to take it, a reload runs it again
      else if (!this.match && this.room?.host && this.mp && this.room.lobby instanceof this.mp.HostLobby && this.room.lobby.handOff()) saveHosted(this.room.id, null);
    });
    window.addEventListener('keydown', (e) => {
      this.sfx.unlock();
      const rec = this.game?.rec;
      if (rec) rec.source = 'key';
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') this.toggleMute();
      if (e.key === '`') this.showPerf = !this.showPerf;
    });
  }

  start(): void {
    initUiMode();
    this.renderer.resize();
    this.camera.setView(this.renderer.width, this.renderer.height);
    const q = new URLSearchParams(location.search);
    // Dev: poke at the running app from the console.
    if (q.has('debug')) {
      (window as unknown as { swarm: App }).swarm = this;
      this.timeSteps = true;
    }
    const bench = Number(q.get('bench'));
    if (bench > 0) this.startBench(bench);
    else if (q.has('eventdemo')) this.startEventDemo();
    else if (q.has('creatures')) this.setScreen(creatureGrid());
    else if (q.has('fortress')) this.setScreen(fortressGrid());
    else if (q.has('maps')) this.setScreen(mapGrid((setup) => this.startGame(setup, { scenario: 'maps (dev)' })));
    else if (q.has('heart')) this.startHeartDemo(Number(q.get('heart')) || 0);
    else if (q.has('playtest')) this.showPlaytests();
    else {
      this.showMenu();
      // a room link: straight into that room
      this.joinFromHash();
    }
    // a room link opened in a tab that already has the game: only the hash changes
    window.addEventListener('hashchange', () => this.joinFromHash());
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---- screens -----------------------------------------------------------

  private setScreen(s: HTMLElement | null): void {
    this.screen?.remove();
    this.screen = s;
    if (s) this.ui.appendChild(s);
  }

  private setModal(m: HTMLElement | null): void {
    // Only the run map darkens the score (showRunMap sets it again).
    this.sfx.setBloom(0);
    this.modal?.remove();
    this.modal = m;
    if (m) this.ui.appendChild(m);
    // the run map and the room (#184) cover everything: the demo battle stops under them
    this.covered = !!m && (m.classList.contains('runmap') || m.classList.contains('opaque'));
    this.ui.classList.toggle('covered', this.covered);
  }

  private showMenu(): void {
    this.endGame();
    this.closeRoom();
    this.startDemo();
    this.sfx.useTheme(null);
    this.setModal(null);
    const menu = mainMenu({
      skirmish: () => this.showSkirmish(),
      multiplayer: () => void this.showMultiplayer(),
      campaign: () => this.showCampaign(),
      howto: () => this.setModal(howToPlay(() => this.setModal(null))),
      settings: () => this.setModal(settingsScreen(this.sfx, () => this.setModal(null))),
    });
    const card = this.menuSuggestion();
    if (shouldShowMobileNotice()) {
      const n = mobileNotice({
        ok: () => {
          markMobileNoticeSeen();
          n.remove();
        },
        desktop: () => {
          markMobileNoticeSeen();
          setUiMode('desktop');
          n.remove();
        },
      });
      menu.appendChild(n);
    } else if (card) menu.appendChild(card);
    this.setScreen(menu);
  }

  // ---- tutorial (#17) ------------------------------------------------------

  /** The menu's one suggestion: try the tutorial, continue it, or what to play next. */
  private menuSuggestion(): HTMLElement | null {
    const p = loadProgress();
    const dismiss = (patch: Partial<typeof p>) => () => {
      saveProgress({ ...loadProgress(), ...patch });
      this.showMenu();
    };
    if (!p.graduated && p.done.length === 0 && !p.offered) {
      const c = menuCard('<b>New to SWARM?</b> The tutorial teaches the basics in about 10 minutes, then sets you up for a real match.', [
        {
          label: 'Start tutorial',
          primary: true,
          on: () => {
            saveProgress({ ...p, offered: true });
            c.remove();
            this.briefMission(0);
          },
        },
        { label: 'Not now', on: dismiss({ offered: true }) },
      ]);
      return c;
    }
    if (!p.graduated && p.done.length > 0) {
      const i = nextMission(p);
      const c = menuCard(`<b>Continue the tutorial:</b> mission ${i + 1} of ${MISSIONS.length}, ${MISSIONS[i].title}.`, [
        { label: 'Continue', primary: true, on: () => this.briefMission(i) },
        { label: 'Not now', on: () => c.remove() },
      ]);
      return c;
    }
    if (p.next) {
      const buttons: { label: string; primary?: boolean; on: () => void }[] =
        p.next === 'ffa'
          ? [{ label: 'Play a 4-player FFA', primary: true, on: () => this.playSuggested('ffa') }]
          : p.next === 'rematch'
            ? [
                // The Normal 1v1 is the tutorial's last mission (#147): replay it there, tracked.
                { label: 'Rematch Normal', primary: true, on: () => this.briefMission(MISSIONS.length - 1) },
                { label: '1v1 vs Easy', on: () => this.playSuggested('easy1v1') },
              ]
            : [{ label: 'Play the 1v1', primary: true, on: () => this.briefMission(MISSIONS.length - 1) }];
      buttons.push({ label: 'Dismiss', on: dismiss({ next: undefined }) });
      return menuCard(NEXT_STEP_TEXT[p.next], buttons);
    }
    return null;
  }

  private playSuggested(kind: 'normal1v1' | 'easy1v1' | 'ffa'): void {
    saveProgress({ ...loadProgress(), next: undefined });
    this.startGame(quickSetup(kind));
  }

  private showCampaign(): void {
    this.setModal(
      campaignMenu(loadProgress(), listRuns().length, {
        tutorial: () => this.showTutorial(),
        run: () => this.showRunHub(),
        back: () => this.setModal(null),
      }),
    );
  }

  // ---- procedural campaign (#18) --------------------------------------------

  private showRunHub(): void {
    if (this.game) this.showMenu();
    this.setModal(
      runHub(listRuns(), loadHistory(), randomSeed(), this.sfx, {
        resume: (run) => this.showRunMap(run),
        start: (seed) =>
          this.setModal(
            starterPick(seed, {
              pick: (pack, difficulty) => {
                const run = newRun(seed, loadPrefs().color, pack, Date.now(), difficulty);
                saveRun(run);
                this.sfx.runStart();
                this.showRunMap(run);
              },
              back: () => this.showRunHub(),
            }),
          ),
        remove: (run) => {
          deleteRun(run.id);
          this.showRunHub();
        },
        replayBriefs: resetBriefs,
        back: () => this.showCampaign(),
        howto: () => this.showRunHowTo(),
      }),
    );
  }

  /** The procedural campaign's How to play (#217): its terms, and the map tour on your latest run. */
  private showRunHowTo(): void {
    const latest = listRuns()[0];
    this.setModal(
      runHowTo({
        back: () => this.showRunHub(),
        replay: latest ? () => this.showRunMap(latest, null, true) : undefined,
        replayLabel: latest ? `Tour the map (${latest.seedText})` : undefined,
        note: latest ? undefined : 'Your first run opens with a tour of the map. Tap ? on a run\'s map to see it again.',
      }),
    );
  }

  private showRunMap(run: RunState, intro: MapIntro | null = null, tour = false): void {
    if (this.game) this.showMenu();
    // A rescued brood waiting for a place, then a reward waiting to be picked, come first (also when resuming a run).
    if (run.recruit && run.status === 'active') {
      this.setModal(recruitPick(run, this.sfx, { save: () => saveRun(run), done: () => this.showRunMap(run, intro, tour) }));
      return;
    }
    if (run.offer && run.status === 'active') {
      this.setModal(rewardPick(run, this.sfx, { save: () => saveRun(run), done: () => this.showRunMap(run, intro, tour) }));
      return;
    }
    this.setModal(
      runMap(
        run,
        this.sfx,
        { go: (id, fielded) => this.runMove(run, id, fielded), leave: () => this.leaveRun(run), save: () => saveRun(run), toured: () => saveGuide({ ...loadGuide(), toured: true }) },
        intro,
        // A run's first turn opens with the map tour, once (#217); playtests never.
        tour || (!run.id.startsWith(PLAYTEST) && wantsTour(run)),
      ),
    );
    this.sfx.setBloom(mapBloom(run));
  }

  /** Out of a run: back to the run list, or to the playtests a playtest run came from. */
  private leaveRun(run: RunState): void {
    if (run.id.startsWith(PLAYTEST)) this.showPlaytests();
    else this.showRunHub();
  }

  /** Playtests (?playtest): throwaway runs that open on one feature. Nothing is saved. */
  private showPlaytests(): void {
    if (this.game) this.showMenu();
    this.setModal(playtestMenu({ play: (p) => this.startPlaytest(p), back: () => this.showMenu() }));
  }

  // Dev playtests write straight into the world, outside the sim's command stream: never in a networked match (#159).
  private startPlaytest(p: Playtest): void {
    const scene = p.make(loadPrefs().color);
    if (scene.kind === 'map') return this.showRunMap(scene.run);
    const run = scene.run;
    this.runMove(run, scene.node, run.broods.map((b) => b.id));
    const w = this.game?.world;
    if (!w || this.game?.session.net) return;
    if (w.siege && scene.extra === 'ending') {
      // The clock nearly out, and no waves left to come.
      w.siege.until = w.tick + 15 * TICK_HZ;
      w.siege.next = w.siege.waves.length;
      return;
    }
    if (w.siege && scene.extra === 'capital') {
      const sg = w.siege, game = this.game;
      setTimeout(() => {
        if (this.game !== game || w.over) return;
        const cap = w.nests[sg.defenders[0].capital];
        cap.owner = -1;
        cap.controller = NEUTRAL;
        cap.control = 0;
      }, 4000);
      return;
    }
    if (w.citadel < 0) return;
    const c = w.nests[w.citadel];
    const human = this.game!.human;
    if (scene.extra === 'gates') {
      // Your army, just outside the gate that faces the middle.
      const dx = w.width / 2 - c.x, dy = w.height / 2 - c.y, d = Math.hypot(dx, dy) || 1;
      const R = FORTIFY.ringR[run.nodes[scene.node].size] + 70;
      const gx = c.x + (dx / d) * R, gy = c.y + (dy / d) * R;
      let k = 0;
      for (let i = 0; i < w.n; i++) {
        if (!w.alive[i] || w.owner[i] !== human) continue;
        const x = gx + ((k % 8) - 3.5) * 9, y = gy + (Math.floor(k / 8) - 2) * 9;
        w.x[i] = w.px[i] = w.ox[i] = x;
        w.y[i] = w.py[i] = w.oy[i] = y;
        k++;
      }
      this.camera.open(gx, gy, this.renderer.dpr);
    } else if (scene.extra === 'fall') {
      // A few seconds in, its guards fall and the citadel is yours.
      this.camera.open(c.x, c.y, this.renderer.dpr);
      const game = this.game;
      setTimeout(() => {
        if (this.game !== game || w.over) return;
        for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === c.owner && Math.hypot(w.x[i] - c.x, w.y[i] - c.y) < 260) w.dmg[i] = 1e9;
        c.owner = c.controller = human;
        c.control = 1;
        this.sfx.citadelFall();
      }, 4000);
    }
  }

  /** Dev (?heart=N): a throwaway run's finale, the Bloom fed by N nodes. Nothing is saved. */
  private startHeartDemo(strength: number): void {
    const run = newRun(`heart-${strength}`, loadPrefs().color, 'swarm', Date.now());
    run.swallowed = run.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'finale').slice(0, strength).map((n) => n.id);
    for (const b of run.broods) b.size = 20;
    this.startGame(nodeSetup(run, run.heart, run.broods.map((b) => b.id)), { scenario: 'campaign: finale (dev)', goal: false });
  }

  /** Move to a node: fight for it, or march through a node already taken. */
  private runMove(run: RunState, id: number, fielded: number[]): void {
    if (!needsBattle(run, id)) {
      const from = run.bloom.time;
      const res = resolveTurn(run, id, null);
      this.saveRunState(run);
      this.runSounds(res);
      this.showRunMap(run, this.runIntro(from, res));
      return;
    }
    const node = run.nodes[id];
    this.startGame(nodeSetup(run, id, fielded), { scenario: `campaign: ${node.kind}`, goal: false });
    this.run = { state: run, node: id, fielded };
    this.armRunBattle(run, id);
  }

  /**
   * What a campaign battle adds on top of its match, once it has started (and
   * again on a restart): campaign locks, the warlord, the first-time briefing.
   */
  private armRunBattle(run: RunState, id: number): void {
    const node = run.nodes[id];
    if (!run.unlocks.nova) this.game!.lock('nova', 'Unlock Nova at the camp');
    // A warlord's ground (#66): its sting, and its trait announced and kept on screen.
    const lord = warlordOf(run, id);
    if (lord) {
      this.game!.warlord = { faction: lord.faction, trait: lord.traitId };
      this.hud?.setWarlord(lord);
      this.hud?.toast(lord.citadel ? `♛ ${lord.name}'s stronghold: take the citadel to win` : `♛ ${lord.name}: ${lord.text}`, FACTION_HEX[lord.faction]);
      this.sfx.warlordSting(lord.faction);
    }
    this.briefBattle(run, node.kind, lord);
  }

  /**
   * The first battle of each kind (#218): hold at the start and show what's
   * different about it. Once per kind, finished or skipped; never in playtests.
   */
  private briefBattle(run: RunState, kind: RunNode['kind'], lord: BriefLord | null): void {
    const g = this.game;
    if (!g || run.id.startsWith(PLAYTEST)) return;
    const type = battleType(g.world);
    if (!type || briefsSeen().includes(type)) return;
    const m = briefingFor(g.world, kind, lord ?? undefined);
    if (!m) return;
    g.briefing = new MissionRun(m, 0);
    g.onGuideEnd = () => markBriefSeen(type);
  }

  /** How the battle ended for the run: survivors by kind, nests held, time. */
  private battleReport(won: boolean): BattleReport {
    const g = this.game;
    return g ? battleReport(g.world, g.human, won) : { won, survivors: [0, 0, 0, 0], nests: 0, seconds: 0 };
  }

  /** The map's Bloom animation for a turn; none after a checkpoint restore, which rewinds the Bloom. */
  private runIntro(from: number, res: TurnResult): MapIntro | null {
    return res.checkpoint === 'restored' ? null : { from, fresh: res.fresh };
  }

  private runSounds(res: TurnResult): void {
    const s = this.sfx;
    for (const e of res.events) {
      if (e.what === 'died') s.broodLost();
      else if (e.what === 'wounded') s.broodWounded();
      else if (e.what === 'rescued') s.broodRescued();
    }
    if (res.warlords.some((w) => w.what === 'broken')) s.domainBroken();
    if (res.checkpoint === 'reached') s.checkpointReached();
    if (res.checkpoint === 'restored') s.checkpointRestart();
  }

  /** The battle is over (or abandoned): update the run and show the debrief. */
  private finishRunBattle(report: BattleReport): void {
    const r = this.run;
    if (!r) return;
    this.run = null;
    const from = r.state.bloom.time;
    const res = resolveTurn(r.state, r.node, report, r.fielded);
    this.saveRunState(r.state);
    this.runSounds(res);
    if (r.state.status === 'won') this.sfx.victory();
    else if (r.state.status === 'lost') this.sfx.defeat();
    this.setModal(
      runDebrief(r.state, r.state.nodes[r.node], report.won, res, {
        next: () => this.showRunMap(r.state, this.runIntro(from, res)),
        hub: () => this.leaveRun(r.state),
      }),
    );
  }

  private saveRunState(run: RunState): void {
    if (run.status === 'active') saveRun(run);
    else finishRun(run);
  }

  private showTutorial(): void {
    // Back from a mission's briefing returns here, and from here to the Campaign menu.
    this.setModal(tutorialMenu(loadProgress(), { play: (i) => this.briefMission(i, () => this.showTutorial()), back: () => this.showCampaign() }));
  }

  private briefMission(i: number, back: () => void = () => this.setModal(null)): void {
    if (this.game) this.showMenu();
    this.setModal(missionBriefing(MISSIONS[i], i, { start: () => this.playMission(i), back }));
  }

  private playMission(i: number, prevEnd: EndReason = 'quit'): void {
    const m = MISSIONS[i];
    this.startGame(m.setup(), { scenario: `tutorial: ${m.title}`, goal: false }, prevEnd);
    const g = this.game!;
    g.mission = new MissionRun(m, i);
    g.locked = new Set(m.locked);
    this.demoOverlay = new DemoOverlay(this.ui, this.camera, () => this.renderer.dpr, isMobile);
    // Tutorial maps are small: show all of it.
    this.camera.fit();
  }

  /** Restart the ghost-cursor demo whenever the tutorial step changes. */
  private updateDemo(g: GameView, dt: number): void {
    const d = this.demoOverlay;
    const m = g.mission;
    if (!d || !m) return;
    // Once you've done your part and the step waits on the world, the demo stops (#115):
    // replaying the action then reads as the next thing to do.
    const waiting = !!g.waitHint;
    const key = `${m.step}:${waiting}`;
    if (key !== this.demoKey) {
      this.demoKey = key;
      const step = m.current;
      d.play(step?.demo && !waiting ? () => step.demo!(m.ctx({ w: g.world, human: g.human, log: g.session.log })) : null);
    }
    // The demo is decoration: if it ever breaks, drop it rather than the game loop.
    try {
      d.update(dt, !g.result && !g.session.paused && !this.input.busy);
    } catch (err) {
      console.error('tutorial demo stopped', err);
      d.destroy();
      this.demoOverlay = null;
    }
  }

  /** Record a finished (or skipped) mission and move on. */
  private completeMission(i: number): void {
    const p = loadProgress();
    const first = !p.done.includes(MISSIONS[i].id);
    if (first) p.done.push(MISSIONS[i].id);
    // Winning the graduation 1v1 (#147) the first time: graduated, and the menu suggests a
    // free-for-all. A replay later doesn't bring that suggestion back.
    if (MISSIONS[i].real && first) {
      p.graduated = true;
      p.next = 'ffa';
    }
    saveProgress(p);
  }

  /** Straight into the next mission: the debrief already said what's next, and the coach names it. */
  private afterMission(i: number): void {
    if (i < MISSIONS.length - 1) this.playMission(i + 1);
  }

  private skipMission(): void {
    const m = this.game?.mission;
    // A battle briefing (#218): skipping it just lets the battle go on.
    if (this.game?.briefing) return this.game.endGuide();
    // The graduation match can't be skipped (#147).
    if (!m || m.mission.real) return;
    this.completeMission(m.index);
    this.afterMission(m.index);
  }

  private showSkirmish(): void {
    this.setModal(
      skirmishMenu({
        quick: (difficulty) => {
          const setup = randomSetup(difficulty);
          if (lagLink()) return void this.startLagged(setup);
          this.startGame(setup);
          this.quick = difficulty;
        },
        custom: () => this.showSetup(),
        back: () => this.setModal(null),
      }),
    );
  }

  private showSetup(): void {
    this.setModal(skirmishSetup((setup, scenario) => (lagLink() ? void this.startLagged(setup, scenario) : this.startGame(setup, { scenario })), () => this.showSkirmish()));
  }

  /** with `?lag=`, a skirmish runs over a NetSession behind a simulated link */
  private async startLagged(setup: MatchSetup, scenario?: string): Promise<void> {
    const mp = (this.mp = await loadMp());
    const seat = setup.players.find((p) => p.human)?.faction ?? 0;
    this.startGame(setup, { scenario, match: mp.NetMatch.local(setup, seat, lagLink()!) });
  }

  // ---- multiplayer (#162) ---------------------------------------------------

  private async showMultiplayer(): Promise<void> {
    const mp = (this.mp = await loadMp());
    this.setModal(
      mp.multiplayerMenu({
        saved: (await allMatches()).map((m) => ({
          label: `Room ${m.room.slice(0, 4)} · ${formatTime(m.tick)} in · saved ${new Date(m.savedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`,
          open: () => void this.openRoom(m.room, m.secret, false),
          del: () => void deleteMatch(m.room).then(() => this.showMultiplayer()),
        })),
        host: () => void this.openRoom(roomCode(10), roomCode(16), true),
        join: (link) => {
          const r = parseRoom(link);
          if (r) void this.openRoom(r.id, r.secret, false);
        },
        back: () => this.setModal(null),
      }),
    );
  }

  /** Join the room in the URL's hash, unless already in it. */
  private joinFromHash(): void {
    const r = parseRoom(location.hash);
    if (!r || this.room?.id === r.id) return;
    if (this.game) {
      this.endGame();
      this.startDemo();
      this.setScreen(null);
    }
    void this.openRoom(r.id, r.secret, false);
  }

  /**
   * The room's transport. Over WebRTC, ask our Worker for relay (TURN)
   * credentials first (#163); without them only direct connections work.
   */
  private async openTransport(mp: Mp, id: string, secret: string, view: LobbyView): Promise<Transport> {
    if (new URLSearchParams(location.search).get('net') === 'local') return mp.broadcastTransport(id);
    const relay = relayOnly();
    const turn = await mp.fetchTurn(id);
    if (relay && !turn) throw new Error('Hide my IP is on, but the relay can’t be reached right now, so you can’t connect. Turn it off in Settings, or try again later.');
    return mp.webrtcTransport({
      room: id,
      secret,
      ice: { turn: turn ?? undefined, relayOnly: relay },
      onError: () =>
        view.status(
          turn ? 'A player was found but couldn’t connect, even through the relay. Check your connection and try again.' : 'A player was found but couldn’t connect directly, and the relay isn’t available. One of your networks may be blocking it.',
          true,
        ),
    });
  }

  /** Host a room, or join one: the lobby screen, then the transport, then the lobby on it. */
  private async openRoom(id: string, secret: string, host: boolean): Promise<void> {
    this.closeRoom();
    const raw = host ? null : loadHosted(id);
    // a match from this room we saved when everyone lost touch (#191): our seat by its token, from any tab.
    // Not when we'll host it (a reload of a room we ran), and alongside loading the multiplayer code
    const hosting = host || /"phase":"(lobby|starting)"/.test(raw ?? '');
    const [mp, found] = await Promise.all([loadMp(), hosting ? null : loadMatch(id)]);
    this.mp = mp;
    // this tab ran this room before a reload, and nobody took it over: run it again (#184)
    const hosted = raw ? mp.parseLobby(raw) : null;
    if (hosted?.phase === 'lobby' || hosted?.phase === 'starting') host = true;
    const save = host ? null : found;
    if (save) setSeatToken(id, save.token);
    const token = save?.token || seatToken(id);
    const hash = `#room=${id}.${secret}`;
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
    const link = `${location.origin}${location.pathname}${location.search}${hash}`;
    const last = mp.loadCharacter();
    const choices = mp.characterChoices(last ? 3 : 4, last ? [last.name] : []);
    if (last) choices.unshift(last);
    const room: Room = { id, secret, host, link, choices, save, token, view: null as unknown as LobbyView, router: null, lobby: null, seen: null, linkPoll: null };
    const view = (room.view = this.roomView(mp, room));
    this.room = room;
    this.setModal(view.el);
    view.render(null, '', false);
    view.status(host ? 'Opening the room…' : 'Connecting to the room…');
    let t: Transport;
    try {
      t = await this.openTransport(mp, id, secret, view);
    } catch (e) {
      view.fail('Couldn’t connect', e instanceof Error && e.message.startsWith('Hide my IP') ? e.message : 'Couldn’t open the room. Check your connection and try again.', true);
      return;
    }
    if (this.room !== room) return t.close(); // left while it opened
    const router = new mp.Router(t);
    room.router = router;
    mp.netNote(`== room ${id} as ${mp.short(t.self)}${host ? ' (host)' : ''}${hosted ? ' (reclaimed after a reload)' : ''}, told before: ${loadTold(id).map(mp.short).join(' ') || 'none'}`);
    const clock = () => performance.now();
    if (host) {
      room.lobby = this.wireHostLobby(
        new mp.HostLobby(router.view(mp.LOBBY_KINDS), {
          build: BUILD,
          char: choices[0].seed,
          prefs: loadPrefs(),
          seed: hosted?.seed ?? randomSeed(),
          clock,
          mobile: isMobile(),
          cell: onCellData(),
          ownToken: token,
          roomKey: `${id}.${secret}`,
          takeOver: hosted ? { state: hosted, connected: [], reclaim: true } : undefined,
        }),
      );
      if (hosted) room.lobby.announce();
      room.seen = structuredClone(room.lobby.state);
      view.status('Send the link to your friends. They appear here as they join.');
    } else {
      room.lobby = this.wireGuestLobby(new mp.GuestLobby(router.view(mp.LOBBY_KINDS), { build: BUILD, char: choices[0].seed, mobile: isMobile(), cell: onCellData(), token, told: loadTold(id), clock }));
      view.status('Looking for the host…');
    }
    room.linkPoll = setInterval(() => this.pollLinks(room), 3000);
    this.renderRoom();
  }

  /** How our link to each player in the room is doing (#184): ping, and whether it's through the relay. */
  private pollLinks(room: Room): void {
    const t = room.router?.transport;
    const s = room.lobby?.state;
    if (this.room !== room || this.game || !t?.linkInfo || !s) return;
    const peers = s.rows.flatMap((r) => (r.k === 'human' && r.peer !== t.self ? [r.peer] : []));
    void Promise.all(peers.map(async (p) => [p, await t.linkInfo!(p).catch(() => ({}))] as const)).then((got) => {
      if (this.room === room) room.view.links(new Map(got));
    });
  }

  /** Who came and went since the screen last looked (#184): a note and a sound for each. */
  private rosterNews(st: LobbyState): void {
    const r = this.room, mp = this.mp;
    if (!r || !mp) return;
    const prev = r.seen;
    r.seen = structuredClone(st);
    if (this.game) return; // mid-match, the match says who's away
    const self = r.router?.transport.self;
    const { joined, left } = mp.rosterChanges(prev, st);
    for (const seat of joined) {
      const row = st.rows[seat];
      if (row.k !== 'human' || row.peer === self) continue;
      r.view.notice(`${mp.playerCharacter(row.char).name} joined`, FACTION_HEX[seat]);
      this.sfx.joined();
    }
    for (const l of left) {
      r.view.notice(`${mp.playerCharacter(l.char).name} left`, FACTION_HEX[l.seat]);
      this.sfx.left();
    }
  }

  /** The room's screen: with the host's controls when we run the room. */
  private roomView(mp: Mp, room: Room): LobbyView {
    const hostLobby = () => (room.lobby instanceof mp.HostLobby ? room.lobby : null);
    return mp.lobbyScreen(room.link, room.choices, {
      leave: () => this.leaveRoom(),
      retry: () => void this.openRoom(room.id, room.secret, room.host),
      tick: (n) => this.sfx.countTick(n),
      ready: (on) => (room.lobby instanceof mp.GuestLobby ? room.lobby.mark(on) : undefined),
      pick: (seat, team, char) => {
        mp.saveCharacter(mp.playerCharacter(char));
        const l = room.lobby;
        if (l instanceof mp.HostLobby) l.pickOwn(seat, team, char);
        else l?.pick(seat, team, char);
      },
      host: room.host
        ? {
            map: (patch) => hostLobby()?.setMap(patch),
            teams: (on) => hostLobby()?.setTeams(on),
            mode: (mode) => hostLobby()?.setMode(mode),
            holder: (seat) => hostLobby()?.setHolder(seat),
            waves: (level) => hostLobby()?.setWaves(level),
            botSecs: (secs) => hostLobby()?.setBotSecs(secs),
            seed: (text) => hostLobby()?.setSeed(text),
            row: (seat, row) => hostLobby()?.setRow(seat, row),
            kick: (seat) => hostLobby()?.kick(seat),
            start: () => hostLobby()?.start(),
            cancel: () => hostLobby()?.cancelStart(),
            lock: (on) => hostLobby()?.setLocked(on),
            fillBots: () => hostLobby()?.fillBots(),
            randomMap: (on) => hostLobby()?.setRandomMap(on),
            runner: (peer) => hostLobby()?.setRunner(peer),
          }
        : undefined,
    });
  }

  private wireHostLobby(lobby: HostLobby): HostLobby {
    lobby.onChange = (st) => {
      this.rosterNews(st);
      this.renderRoom();
      this.peersChanged();
      // kept for a reload (#184); a match moves hosting its own way
      if (this.room) saveHosted(this.room.id, st.phase === 'playing' ? null : st);
    };
    lobby.onGo = (go) => this.hostGo(go);
    // a guest reloaded mid-match and proved their seat: it answers to their new connection (#164)
    lobby.onRejoin = (seat, peer) => this.match?.rebind(seat, peer);
    // a rejoining player talks to whoever runs the match (#190)
    lobby.runnerOf = () => this.match?.runnerPeer ?? null;
    // two of us picked the match up from our saves at once (#191): one keeps it
    lobby.onRival = (_peer, yieldToIt) => {
      if (yieldToIt) this.yieldRoom();
    };
    return lobby;
  }

  private wireGuestLobby(lobby: GuestLobby): GuestLobby {
    const status = (text: string, error = false) => this.room?.view.status(text, error);
    lobby.onChange = (st) => {
      this.peersChanged();
      // in: say so, once (#184)
      const self = this.room?.router?.transport.self;
      const wasIn = !!this.room?.seen?.rows.some((r) => r.k === 'human' && r.peer === self);
      if (!wasIn && st.rows.some((r) => r.k === 'human' && r.peer === self)) this.sfx.joined();
      this.rosterNews(st);
      // back in the lobby while the match was still on: the host ended it (#183)
      const ended = st.phase === 'lobby' && !!this.match && !this.game?.world.over;
      status(ended ? 'The host ended the match.' : st.phase === 'playing' ? 'The match is starting…' : '');
      this.renderRoom();
      // the host brought everyone back after a match
      if (st.phase === 'lobby' && this.match) this.backToRoom();
    };
    lobby.onRefused = (why) => {
      // mid-match: this tab's seat moved to another tab (#164), or the host removed us
      if (this.match && this.mp) {
        this.input.enabled = false;
        this.setModal(this.mp.messageCard('You left this match', why, [{ label: 'Menu', primary: true, on: () => this.leaveRoom() }]));
        return;
      }
      // a version mismatch won't go away by trying again
      this.room?.view.fail(/removed you/.test(why) ? 'Removed from the room' : 'Couldn’t join', why, !/different version|removed you/.test(why));
    };
    // in a match, the match itself watches the host (and finds a new one, #166)
    lobby.onNoHost = (why) => {
      this.mp?.netNote(`!! no host (${why}): ${lobby.debug()}`);
      if (this.match) return;
      // nobody runs the match we saved (#191): ours to pick up
      if (this.room?.save) return this.offerResume();
      this.roomLost(why);
    };
    lobby.onHostLink = (state) => {
      if (this.match) return;
      if (state === 'lost') status('Lost connection to the host. Reconnecting…', true);
      else status(lobby.state?.phase === 'playing' ? 'The match is starting…' : '');
    };
    lobby.onStart = (st) => this.guestGo(st);
    // who has our token (#202), for a reload to go straight to them
    lobby.onTold = (peer) => {
      if (this.room) addTold(this.room.id, peer);
    };
    // the host left the room before a match, and passed it on (#184)
    lobby.onPass = (to, mine, tokens) => {
      if (mine) return this.becomeLobbyHost(tokens);
      const row = lobby.state?.rows.find((r) => r.k === 'human' && r.peer === to);
      if (row?.k === 'human' && this.mp) this.room?.view.notice(`${this.mp.playerCharacter(row.char).name} is hosting the room now`);
    };
    return lobby;
  }

  /** The host left the room before a match, and it's ours to run now (#184): its state, everyone still in it, its seat tokens. */
  private becomeLobbyHost(tokens: string[]): void {
    const r = this.room, mp = this.mp;
    if (!r?.router || !mp || r.host || !(r.lobby instanceof mp.GuestLobby) || !r.lobby.state) return;
    const old = r.lobby;
    const st = old.state!;
    old.close();
    const self = r.router.transport.self;
    const connected = st.rows.flatMap((row) => (row.k === 'human' && row.peer !== self && row.peer !== st.host ? [row.peer] : []));
    const lobby = this.takeOverRoom(r, mp, { char: this.ownChar(st), seed: st.seed, takeOver: { state: st, connected, tokens } });
    r.seen = structuredClone(lobby.state);
    if (!this.game) this.setModal(r.view.el);
    lobby.announce();
    r.view.notice('You’re hosting the room now');
    r.view.status('The host left, so the room is yours to run.');
    this.renderRoom();
  }

  /**
   * We hosted the room, and another player hosts the match now (#166): we
   * were cut off and it moved on without us. The room goes with the match:
   * follow the new host's lobby, so there's never two.
   */
  private becomeRoomGuest(leader: string): void {
    const r = this.room, mp = this.mp;
    if (!r?.router || !mp || !r.host || !(r.lobby instanceof mp.HostLobby)) return;
    const old = r.lobby;
    old.close();
    r.host = false;
    r.view = this.roomView(mp, r);
    const lobby = this.wireGuestLobby(new mp.GuestLobby(r.router.view(mp.LOBBY_KINDS), { build: BUILD, char: this.ownChar(old.state), mobile: isMobile(), cell: onCellData(), token: r.token, told: loadTold(r.id), clock: () => performance.now() }));
    lobby.follow(leader);
    lobby.state = { ...old.state, host: leader };
    r.lobby = lobby;
  }

  /** The character we play in this room: our row's, else the one we came in with. */
  private ownChar(s: LobbyState | null): number {
    const self = this.room?.router?.transport.self;
    const row = s?.rows.find((r) => r.k === 'human' && r.peer === self);
    return row?.k === 'human' ? row.char : (this.room?.choices[0].seed ?? 0);
  }

  /** Nobody hosts the match we saved (#191): pick it up from our save, or go. */
  private offerResume(): void {
    const save = this.room?.save, mp = this.mp;
    if (!save || !mp) return;
    const ago = Math.max(1, Math.round((Date.now() - save.savedAt) / 60_000));
    const when = ago < 60 ? `${ago} min ago` : new Date(save.savedAt).toLocaleString();
    this.setModal(
      mp.messageCard(
        'Nobody’s hosting this match',
        `You saved it ${when}, ${formatTime(save.tick)} in. Pick it up from your save and you host it: the others get their seats back by opening the same link.`,
        [
          { label: 'Back to menu', on: () => this.leaveRoom() },
          { label: 'Resume the match', primary: true, on: () => this.resumeSaved() },
        ],
      ),
    );
  }

  /**
   * Run the room's match again from our save (#191): the room as we last saw
   * it, the match from where it stood. Checked first, so a save that can't
   * be picked up never leaves the room half torn down. The save stays until
   * someone is back: if this page goes too, it can be picked up again.
   */
  private resumeSaved(): void {
    const r = this.room, mp = this.mp, save = r?.save;
    if (!r?.router || !mp || !save || !(r.lobby instanceof mp.GuestLobby)) return;
    // a host turned up meanwhile (another player picked it up): theirs it is, we rejoin it
    if (r.lobby.host) return;
    if (!mp.canResume(save, `${r.id}.${r.secret}`)) return this.cantResume(r.id);
    r.lobby.close();
    r.save = null;
    try {
      const own = save.lobby.rows[save.seat];
      const lobby = this.takeOverRoom(r, mp, { char: own?.k === 'human' ? own.char : r.choices[0].seed, seed: save.lobby.seed, takeOver: { state: save.lobby, connected: [], setup: save.setup, resume: true } });
      lobby.announce();
      r.seen = structuredClone(lobby.state);
      const match = mp.NetMatch.resume(r.router.view(mp.MATCH_KINDS), save);
      this.startGame(save.setup, { seat: save.seat, match, record: false });
    } catch (e) {
      console.warn('couldn’t resume the match', e);
      return this.cantResume(r.id);
    }
    // saved again now and then while we wait, so a crash loses little; the first player back ends it
    this.resumeKeep = setInterval(() => this.saveRoomMatch(), 30_000);
  }

  /** The save can't be picked up (#191): say so, and offer to forget it. */
  private cantResume(room: string): void {
    const mp = this.mp;
    this.closeRoom();
    if (!mp) return this.showMenu();
    this.setModal(
      mp.messageCard('This save can’t be picked up', 'It doesn’t match your seat in that room, so the others couldn’t rejoin you. This happens when the browser wouldn’t keep your seat for the room.', [
        { label: 'Back to menu', on: () => this.showMenu() },
        { label: 'Delete it', primary: true, on: () => void deleteMatch(room).then(() => this.showMenu()) },
      ]),
    );
  }

  /** A player is back in the match we picked up (#191): no need for the save any more. */
  private resumeDone(): void {
    if (this.resumeKeep) clearInterval(this.resumeKeep);
    this.resumeKeep = null;
    if (this.room) void deleteMatch(this.room.id);
  }

  /** Two of us picked this match up at once (#191): the other keeps it; we rejoin theirs, from our save, by our token. */
  private yieldRoom(): void {
    const r = this.room;
    if (!r) return;
    if (this.resumeKeep) clearInterval(this.resumeKeep);
    this.resumeKeep = null;
    const { id, secret } = r;
    // save where we stand first, so the rejoin finds a save and our token
    void this.saveRoomMatch().then(() => {
      this.endGame();
      this.closeRoom();
      void this.openRoom(id, secret, false);
    });
  }

  /** The room's match, saved as it stands (#191). False when storage refused it. */
  private async saveRoomMatch(): Promise<boolean> {
    const r = this.room, m = this.match;
    const lobby = r?.lobby?.state;
    if (!r || !m || !lobby) return false;
    return saveMatch({ ...m.exportSave(), room: r.id, secret: r.secret, savedAt: Date.now(), token: r.token, lobby: structuredClone(lobby) });
  }

  /** We lost touch with everyone (#191): save the match where it stands; someone's back: the save goes. */
  private lostAll(on: boolean): void {
    this.lostTouch = on;
    this.saveFailed = false;
    const r = this.room;
    if (!r || !this.match) return;
    if (!on) return void deleteMatch(r.id);
    void this.saveRoomMatch().then((ok) => (this.saveFailed = !ok));
  }

  /** The room's rows changed mid-match (a rejoin under a new peer id): the match's list of who could host follows (#166). */
  private peersChanged(): void {
    const s = this.room?.lobby?.state;
    if (this.match && this.game && s?.phase === 'playing') this.match.updatePeers(this.mp!.matchPeers(s, this.game.setup));
  }

  /**
   * Hosting passed to us mid-match (#166): the room comes too. Its state as
   * we last saw it, run from here; its rows carry every seat's seal, so a
   * player who reloads gets their seat back from us (#192).
   */
  private becomeRoomHost(): void {
    const r = this.room, mp = this.mp, m = this.match;
    if (!r?.router || !mp || !m || r.host || !(r.lobby instanceof mp.GuestLobby) || !r.lobby.state) return;
    const old = r.lobby;
    old.close();
    const lobby = this.takeOverRoom(r, mp, { char: this.ownChar(old.state), seed: old.state!.seed, takeOver: { state: old.state!, connected: m.livePeers(), setup: m.session.setup } });
    lobby.announce();
  }

  /**
   * We run the room from here on (#184, #166, #191): a host lobby taken over
   * from `takeOver`, with our token and the room's key, and a host's screen.
   * The caller has closed the lobby before it, and announces this one.
   */
  private takeOverRoom(r: Room, mp: Mp, o: { char: number; seed: string; takeOver: NonNullable<HostLobbyOptions['takeOver']> }): HostLobby {
    r.host = true;
    r.view = this.roomView(mp, r);
    const lobby = new mp.HostLobby(r.router!.view(mp.LOBBY_KINDS), {
      build: BUILD,
      char: o.char,
      prefs: loadPrefs(),
      seed: o.seed,
      clock: () => performance.now(),
      mobile: isMobile(),
      cell: onCellData(),
      ownToken: r.token,
      roomKey: `${r.id}.${r.secret}`,
      takeOver: o.takeOver,
    });
    r.lobby = this.wireHostLobby(lobby);
    return lobby;
  }

  private renderRoom(): void {
    const r = this.room;
    if (!r?.lobby || !r.router) return;
    const l = r.lobby;
    r.view.render(l.state, r.router.transport.self, r.host && (l as HostLobby).canStart());
  }

  /** The host's lobby says go: every guest is ready. */
  private hostGo(go: HostGo): void {
    const r = this.room;
    if (!r?.router || !this.mp) return;
    this.startGame(go.setup, { seat: go.hostSeat, match: this.mp.NetMatch.host(r.router.view(this.mp.MATCH_KINDS), go), record: false });
  }

  private guestGo(s: StartInfo): void {
    const r = this.room;
    const mp = this.mp;
    if (!r?.router || r.host || !mp) return;
    // back after a reload (#164): the match is under way, a snapshot of it is on its way
    const resume = s.tick > 0;
    try {
      const st = (r.lobby as GuestLobby).state;
      // every human seat, to take over hosting if it comes to that (#166)
      const peers = st ? mp.matchPeers(st, s.setup) : [];
      // the host may not be who runs the match (#190)
      const owner = st ? mp.seatOf(st, st.host) : undefined;
      // the host's "Runs the match" choice (#190): whoever runs it later honours it too
      const pinned = st?.runner ? mp.seatOf(st, st.runner) : -1;
      const match = mp.NetMatch.guest(r.router.view(mp.MATCH_KINDS), s.setup, s.seat, s.runner ?? s.host, {
        resume,
        peers,
        botMs: (st?.botSecs ?? 60) * 1000,
        owner,
        // no lobby yet: the host by peer, found once the list of players has them
        ownerPeer: owner === undefined ? s.host : undefined,
        runnerSeat: pinned >= 0 ? pinned : undefined,
      });
      // back in a match we'd saved (#191): once its world is ours, the save is done with
      if (resume && r.save) {
        const id = r.id;
        match.session.onAdopt = () => {
          r.save = null;
          void deleteMatch(id);
        };
      }
      this.startGame(s.setup, { seat: s.seat, match, record: false });
    } catch {
      r.view.status('The host sent a match this version can’t play.', true);
      return;
    }
    if (!resume) (r.lobby as GuestLobby).ready();
  }

  /** After a match: back to the room's lobby (the host brings everyone). */
  private backToRoom(sameMap = false): void {
    const r = this.room;
    if (!r) return this.showMenu();
    if (r.host) (r.lobby as HostLobby | null)?.backToLobby({ sameMap });
    this.endGame();
    // nothing runs behind the room (#184): the menu starts the demo again when we leave it
    this.setScreen(null);
    this.setModal(r.view.el);
    this.renderRoom();
  }

  /** Who sits in a seat: their character's name in a room, else the colour's. */
  private seatName(seat: number): string {
    const row = this.room?.lobby?.state?.rows[seat];
    return row?.k === 'human' && this.mp ? this.mp.playerCharacter(row.char).name : FACTION_NAMES[seat];
  }

  /** The host left, never answered, or its link dropped for good. */
  private roomLost(why: 'none' | 'left' | 'lost'): void {
    const r = this.room;
    if (!r) return;
    if (this.game && this.match) {
      this.input.enabled = false;
      this.netMenu = null;
      this.setModal(
        this.mp!.messageCard(
          why === 'left' ? 'The host left' : 'Lost the host',
          `${why === 'lost' ? 'The connection to the host dropped and didn’t come back. ' : ''}The match can’t go on without the host, who runs it for everyone.`,
          [{ label: 'Menu', primary: true, on: () => this.leaveRoom() }],
        ),
      );
      return;
    }
    if (why === 'left') r.view.fail('The host left', 'The host closed the room. Ask them to open a new one and send you the link.');
    else if (why === 'lost') r.view.fail('Lost the host', 'The connection to the host dropped and didn’t come back. Check your connection and try again.', true);
    else r.view.fail('No one is hosting', 'Nobody answered on this link. Check that it’s the latest one, or ask the host to open the room again.', true);
  }

  /** Leave the room for good, and go back to the menu. */
  private leaveRoom(): void {
    const r = this.room, mp = this.mp;
    let linger = 0;
    if (r) {
      saveHosted(r.id, null); // leaving on purpose: a reload doesn't bring the room back
      // the host leaving before a match: the next player runs the room (#184); give the word a moment to get out
      if (!this.match && r.host && mp && r.lobby instanceof mp.HostLobby && r.lobby.handOff()) linger = 150;
    }
    this.closeRoom(linger);
    this.showMenu();
  }

  private closeRoom(linger = 0): void {
    const r = this.room;
    if (!r) return;
    this.mp?.netNote(`== left room ${r.id}${r.lobby && 'debug' in r.lobby ? `: ${r.lobby.debug()}` : ''}`);
    this.room = null;
    if (r.linkPoll) clearInterval(r.linkPoll);
    this.match?.close();
    this.match = null;
    this.syncAwake();
    if (linger > 0) {
      setTimeout(() => {
        r.lobby?.close();
        r.router?.close();
      }, linger);
    } else {
      r.lobby?.close();
      r.router?.close();
    }
    if (parseRoom(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  // ---- networked pause menu (#162): only the host stops the match --------

  private toggleNetMenu(): void {
    const g = this.game;
    const m = this.match;
    if (!g || !m) return;
    // only the host stops the match, and not once out of it (#183)
    const pauses = m.host && !g.spectating;
    if (this.netMenu) {
      if (pauses) g.session.setPaused(false);
      this.closeNetMenu();
      return;
    }
    if (pauses) g.session.setPaused(true);
    this.openNetMenu('user');
  }

  /** Players' games stopped matching (#165): the match halted for everyone; say so, and what can be done. */
  private showDesync(tick: number): void {
    const mp = this.mp, m = this.match, g = this.game;
    if (!mp || !m || !g) return;
    this.netMenu = null;
    this.netNote = null;
    this.netPlayers = null;
    this.input.enabled = false;
    this.input.reset();
    const card = mp.desyncCard({
      when: formatTime(tick),
      host: m.host,
      download: () => this.downloadDesync(tick),
      // done here when we run the match; else asked of whoever does, and the card goes once turns flow (#190)
      resync: () => {
        if (m.requestResync()) this.closeDesync();
      },
      resume: () => {
        g.session.setPaused(false);
        this.closeDesync();
      },
      leave: () => this.leaveMatch(),
    });
    this.desyncView = card;
    this.setModal(card.el);
    const r = m.desyncReport;
    if (r?.tick === tick) this.desyncDetail(r);
    if (this.desyncNote?.tick === tick) card.detail(`First difference: ${this.desyncNote.text}`);
  }

  /** The host's findings, on its desync card. */
  private desyncDetail(r: DesyncReport): void {
    const v = this.desyncView;
    if (!v) return;
    const who = r.odd.length < Object.keys(r.hashes).length ? ` Out of step: ${r.odd.map((s) => this.seatName(s)).join(', ')}.` : ' No majority to tell who is out of step.';
    v.detail(r.first ? `First difference: ${r.first}.${who}` : r.ref < 0 ? `No game to compare with came in.${who}` : `No field differs, only the hash.${who}`);
    v.canResync(r.ref >= 0);
  }

  private closeDesync(): void {
    if (!this.desyncView) return;
    this.desyncView = null;
    this.setModal(null);
    this.input.enabled = true;
  }

  /** Everything needed to see this desync again, as a file (#165). The host's has the whole match. */
  private downloadDesync(tick: number): void {
    const mp = this.mp, m = this.match, g = this.game;
    if (!mp || !m || !g) return;
    const s = m.session;
    const r = m.desyncReport;
    const own = s.keptSnap(tick);
    const ownHash = s.hashLog.find(([t]) => t === tick)?.[1];
    const report =
      r && r.tick === tick
        ? r
        : { tick, hashes: ownHash === undefined ? {} : { [g.human]: ownHash }, odd: [], snaps: new Map(own ? [[g.human, own]] : []), diffs: {} };
    // the whole match's record is with whoever runs it (#190), not the host
    const reported = m.runner ? m.reportedHashes() : { [g.human]: s.hashLog.slice() };
    const turns = m.runner && m.seq ? m.seq.closedTurns() : s.closedTurns();
    downloadJson(`swarm-desync-${tick}.json`, mp.buildBundle({ setup: g.setup, seat: g.human, host: m.runner, report, reported, turns }));
  }

  /**
   * A networked match is paused (not halted by a desync) and no menu shows
   * it: the resume's countdown for everyone, with a tick each second, or who
   * paused it. Null when it isn't paused.
   */
  private pauseLine(g: GameView): string | null {
    const m = this.match;
    const st = m?.session.status;
    if (!m || !g.session.paused || this.netMenu || this.desyncView || (st?.paused && st.by < 0)) {
      this.resumeShown = -1;
      return null;
    }
    if (st?.paused && st.resumeIn >= 0) {
      const n = Math.max(1, Math.ceil((st.resumeIn - (performance.now() - st.at)) / 1000));
      if (n !== this.resumeShown) this.sfx.countTick(n);
      this.resumeShown = n;
      return `Resuming in ${n}…`;
    }
    this.resumeShown = -1;
    return m.host ? 'Resuming…' : 'The host paused the match.';
  }

  /** The line that stays on screen while you watch after your defeat (#183). */
  private updateBanner(g: GameView): void {
    const h = this.hud;
    if (!h) return;
    // first: nobody at all, the match saved (#191); then no host to be had, rejoining or not; there's a way out
    if (this.lostTouch && !g.result) {
      const text = this.saveFailed ? 'Lost touch with everyone. Reconnecting… (couldn’t save this match)' : 'Lost touch with everyone. Reconnecting… Your match is saved: open the room link again to pick it up.';
      return h.banner(text, [{ label: 'Leave', on: () => this.leaveRoom() }]);
    }
    if (this.stalled && !g.result) return h.banner('Lost touch with the host. Finding a new one…', [{ label: 'Leave', on: () => this.leaveRoom() }]);
    // paused with the menu closed: say so, and count down a resume, so it never looks like a hang (#198)
    const pause = this.pauseLine(g);
    if (pause) return h.banner(pause);
    if (g.session.syncing) return h.banner('Rejoining the match…');
    if (g.session.seatBot) this.ownBot = true; // back from a reload with a bot in our seat: no control entry said so
    if (g.session.seatBot && !g.spectating && !g.result) return h.banner('An Easy bot is playing for you. Taking your seat back…');
    if (!g.spectating || g.result) return h.banner(null);
    const p = g.placing;
    h.banner(`You've been defeated${p ? ` · ${ordinal(p.place)} of ${p.of}` : ''}. Watching the rest of the match.`, [{ label: 'Leave', on: () => this.leaveMatch() }]);
  }

  /**
   * Leave a room match. Whoever runs it hands that on to the next player
   * first (#166), so the match goes on without them; the handoff gets a
   * moment to go out before the connection closes. A host who doesn't run
   * it just goes: whoever does becomes host (#190).
   */
  private leaveMatch(): void {
    const m = this.match;
    if (!m?.runner || this.game?.world.over) return this.leaveRoom();
    if (m.handOff()) {
      this.input.enabled = false;
      setTimeout(() => this.leaveRoom(), 150);
      return;
    }
    // nobody can take over right now (the others are hidden, or still rejoining): say what leaving does
    if (m.livePeers().length === 0) return this.leaveRoom();
    this.confirmNet('Leave the match?', 'Nobody can take over hosting right now, so leaving ends the match for everyone else. To stop it and keep the room, use End match instead.', 'Leave and end it', () => this.leaveRoom());
  }

  /** Who'd be host if we left now (#190): whoever runs the match, or if that's us, who'd run it next. */
  private nextHostSeat(): number {
    const m = this.match;
    if (!m) return -1;
    return m.runner ? m.successorSeat() : m.leaderSeat;
  }

  /** Host (#183): stop the match for everyone and bring them back to the room, to change settings or let someone in. */
  private endMatch(): void {
    this.confirmNet('End the match for everyone?', 'Everyone goes back to the room, where you can change the settings or let someone new join, then start again.', 'End match', () => this.backToRoom());
  }

  /** Host (#183): the same room and settings, from the start. */
  private restartMatch(): void {
    this.confirmNet('Restart the match for everyone?', 'Same room, same settings, from the start.', 'Restart', () => {
      this.backToRoom(true);
      (this.room?.lobby as HostLobby | null)?.start();
    });
  }

  /** A yes/no card over the match; no goes back to the menu it came from. */
  private confirmNet(title: string, text: string, yes: string, on: () => void): void {
    if (!this.mp || !this.game) return;
    this.netMenu = 'user';
    this.netNote = null;
    this.netPlayers = null;
    this.input.enabled = false;
    this.setModal(
      this.mp.messageCard(title, text, [
        { label: yes, primary: true, on },
        { label: 'Back', on: () => this.openNetMenu('user') },
      ]),
    );
  }

  private openNetMenu(kind: 'user' | 'pause'): void {
    const g = this.game!;
    const host = !!this.match?.host;
    const pauses = host && !g.spectating;
    this.netMenu = kind;
    this.input.enabled = false;
    this.input.reset();
    const m = pauseMenu({
      title: pauses || g.session.paused ? 'Paused' : 'Menu',
      note: ' ',
      resume: () => this.toggleNetMenu(),
      resumeLabel: pauses ? 'Resume' : 'Back to the match',
      // the host can stop or restart the match without leaving the room (#183)
      restart: host ? () => this.restartMatch() : undefined,
      more: host ? [{ label: 'End match', on: () => this.endMatch() }] : undefined,
      quit: () => this.leaveMatch(),
      quitLabel: host && this.nextHostSeat() >= 0 ? `Leave (hosting passes to ${this.seatName(this.nextHostSeat())})` : 'Leave match',
      audio: this.sfx,
      teams: teamLayout(g.world, g.human).team ? teamsList(g.world, g.human) : undefined,
      players: '<div class="players"></div>',
    });
    this.netNote = m.querySelector('.note');
    this.netPlayers = m.querySelector('.players');
    this.shownLat = null;
    this.setModal(m);
    this.updateNetNote();
  }

  private closeNetMenu(): void {
    this.netMenu = null;
    this.netNote = null;
    this.netPlayers = null;
    this.setModal(null);
    this.input.enabled = true;
  }

  /** The host paused or resumed: guests' menus follow. */
  private netPaused(paused: boolean): void {
    if (!this.game || this.match?.host) return;
    if (paused && !this.netMenu) this.openNetMenu('pause');
    else if (!paused && this.netMenu === 'pause') this.closeNetMenu();
  }

  private updateNetNote(): void {
    const n = this.netNote;
    const g = this.game;
    if (!n || !g) return;
    const host = !!this.match?.host;
    const st = this.match?.session.status ?? null;
    const since = st ? performance.now() - st.at : 0;
    const secs = (ms: number) => formatTime(Math.max(0, Math.ceil((ms - since) / 1000)) * TICK_HZ);
    let text: string;
    if (g.session.paused) {
      if (st?.paused && st.by < 0) text = 'Stopped: players’ games stopped matching.';
      else if (st?.paused && st.resumeIn >= 0) text = `Resuming in ${Math.max(1, Math.ceil((st.resumeIn - since) / 1000))}…`;
      else if (st?.paused) text = `${host ? 'The match is paused for everyone' : 'The host paused the match'}. It resumes by itself in ${secs(st.auto)}.`;
      else text = host ? 'The match is paused for everyone.' : 'The host paused the match.';
    } else if (g.spectating) text = 'You’re out. The match keeps going while this menu is open.';
    else text = host ? 'Pausing…' : 'The match keeps going while this menu is open.';
    if (n.textContent !== text) n.textContent = text;
    n.hidden = false;
    const lat = this.match?.session.lat;
    if (this.netPlayers && lat && lat !== this.shownLat) {
      this.shownLat = lat;
      this.netPlayers.innerHTML = this.playersHtml();
    }
  }

  /** Everyone in the match: who, connected or not, round trip and how long their orders take (#161). */
  private playersHtml(): string {
    const lat = this.match?.session.lat ?? [];
    if (!lat.length) return '<p class="hint">Measuring…</p>';
    const me = this.game?.human;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    // the host, and who runs the match when that's someone else (#190): round trips are to them
    const owner = this.match?.ownerSeat ?? -1;
    const runs = this.match?.leaderSeat ?? -1;
    const role = (seat: number) =>
      (seat === owner ? ' <small class="role">host</small>' : '') + (seat === runs && runs !== owner ? ' <small class="role" title="Their browser keeps the match’s clock: they’re best placed to keep everyone’s delay down.">runs the match</small>' : '');
    const rows = lat.map((r) => {
      const tag = r.state === 'away' ? ' <small>away</small>' : r.state === 'bot' ? ' <small>bot playing</small>' : r.state === 'spectating' ? ' <small>watching</small>' : '';
      const cls = r.delay >= DELAY_BAD_MS ? 'bad' : r.delay >= DELAY_WARN_MS ? 'warn' : '';
      // what the delay is made of (#198): the network, the turn it's scheduled for, evening out PvP, smoothing out jitter
      const tick = 1000 / TICK_HZ;
      const ms = (ticks: number) => Math.round(ticks * tick);
      const parts = `${r.rtt} ms network + ${ms(r.d - r.hold)} ms scheduling + ${ms(r.buffer)} ms smoothing${r.hold ? ` + ${ms(r.hold)} ms evening out (PvP)` : ''}`;
      return `<tr><td><i style="background:${FACTION_HEX[r.seat]}"></i>${esc(this.seatName(r.seat))}${r.seat === me ? ' (you)' : ''}${role(r.seat)}${tag}</td><td>${r.rtt} ms</td><td class="${cls}" title="${parts}">${r.delay} ms</td></tr>`;
    });
    // phones can't hover: say what our own delay is made of under the table
    const mine = lat.find((r) => r.seat === me);
    const tick = 1000 / TICK_HZ;
    const why = mine
      ? `<p class="hint lat-why">Your orders: ${mine.rtt} ms network, ${Math.round((mine.d - mine.hold) * tick)} ms scheduling, ${Math.round(mine.buffer * tick)} ms smoothing${mine.hold ? `, ${Math.round(mine.hold * tick)} ms evening out with a slower rival` : ''}.</p>`
      : '';
    return `<table class="lat"><thead><tr><th></th><th title="To whoever runs the match">Round trip</th><th>Order delay</th></tr></thead><tbody>${rows.join('')}</tbody></table>${why}`;
  }

  private startDemo(): void {
    const n = 4;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const setup: MatchSetup = {
      seed,
      size: 'medium',
      terrain: 'standard',
      events: 'normal',
      players: Array.from({ length: n }, (_, i) => ({
        faction: [0, 1, 2, 3, 4, 5][(i + seed) % 6],
        team: i,
        human: false,
        bot: { difficulty: 2, personality: PERSONALITIES[(i + seed) % 4] },
      })),
    };
    // Unique colors
    const used = new Set<number>();
    for (const p of setup.players) {
      while (used.has(p.faction)) p.faction = (p.faction + 1) % 6;
      used.add(p.faction);
    }
    this.demo = new LocalSession(setup);
    this.demo.speed = 1.6;
    this.camera.setMap(this.demo.world.width, this.demo.world.height);
    this.camera.fit();
    this.particles.clear();
    this.rings.list = [];
  }

  /**
   * `opts.seat`: the local seat (#156), one of the setup's human factions; default: the first human.
   * `opts.match`: a networked match (#162), which brings its own session.
   */
  private startGame(setup: MatchSetup, opts: { scenario?: string; record?: boolean; seat?: number; match?: NetMatch; goal?: boolean } = {}, prevEnd: EndReason = 'quit'): void {
    this.endGame(prevEnd);
    this.match = opts.match ?? null;
    // a phone running the match hands it on when its page hides (#193): it freezes there
    if (this.match) this.match.handOffWhenHidden = isMobile();
    this.demo = null;
    this.setModal(null);
    this.setScreen(null);
    this.endShown = false;
    this.syncAwake();
    this.recSaved = false;
    this.quick = null;
    this.run = null;
    const record = opts.record !== false && recordingEnabled();
    this.game = new GameView(setup, this.services, record ? { scenario: opts.scenario, mobile: isMobile() } : null, { seat: opts.seat, session: this.match?.session, spectate: !!(this.match && this.room) });
    if (this.match) {
      this.match.events = {
        onSeat: (seat, state) => {
          if (seat === this.game?.human) {
            if (state === 'human' && this.ownBot) this.hud?.toast('You’re back in control', '#8aa0b8');
            this.ownBot = state === 'bot';
            return;
          }
          // a player back in a match we picked up from our save (#191)
          if (state === 'human' && this.resumeKeep) this.resumeDone();
          const who = this.seatName(seat);
          if (state === 'away') this.hud?.toast(`${who} lost connection`, '#8aa0b8');
          else if (state === 'bot') this.hud?.toast(`${who} dropped: an Easy bot took over`, '#ffb627');
          else this.hud?.toast(`${who} is back`, '#8aa0b8');
        },
        onPause: (p) => this.netPaused(p),
        // another player runs the match now (#166, #190): a performance detail, the Players table shows it
        onLeader: () => {
          if (this.netPlayers) this.netPlayers.innerHTML = this.playersHtml();
        },
        // the host left: someone new is host (#190), and the room goes with them
        onOwner: (seat, peer) => {
          const me = peer === this.room?.router?.transport.self;
          this.hud?.toast(me ? 'You’re hosting now' : `${this.seatName(seat)} is now hosting`, '#8aa0b8');
          if (me) this.becomeRoomHost();
          else if (this.room?.host) this.becomeRoomGuest(peer);
          else (this.room?.lobby as GuestLobby | null)?.follow(peer);
          // halted by a desync: the card's host buttons (resync, resume) go with hosting
          const halted = this.match?.session.halted ?? -1;
          if (this.desyncView && halted >= 0) this.showDesync(halted);
        },
        onStall: (stalled) => (this.stalled = stalled),
        onLost: (on) => this.lostAll(on),
        onDesync: (t) => this.showDesync(t),
        onDesyncReport: (r) => this.desyncDetail(r),
        // the host's word can come before our halt turn does: keep it for the card
        onDesyncNote: (t, text) => {
          this.desyncNote = { tick: t, text };
          this.desyncView?.detail(`First difference: ${text}`);
        },
      };
    }
    // dev (#165): `?desync=<tick>` nudges this tab's world at that tick, to see a desync end to end
    const nudgeAt = Number(new URLSearchParams(location.search).get('desync'));
    if (this.match && this.mp && nudgeAt > 0) {
      const nudge = this.mp.nudgeWorld;
      this.match.session.beforeStep = (t, w) => void (t === nudgeAt && nudge(w));
    }
    this.sfx.useTheme(setup.seed);
    this.input.game = this.game;
    this.input.enabled = true;
    this.input.reset();
    this.hud = new Hud(this.ui, {
      all: () => this.game?.selectAll(),
      surge: () => this.game?.surge(),
      nova: () => this.game?.nova(),
      upgrade: () => this.game?.upgrade(),
      clear: () => this.game?.clearSelection(),
      nearest: () => this.game?.toNearestNest(),
      pause: () => this.togglePause(),
      mute: () => this.toggleMute(),
      fortify: () => this.game?.startAim('fortify'),
      barrage: () => this.game?.startAim('barrage'),
      blink: () => this.game?.startAim('blink'),
      lockdown: () => this.game?.startAim('lockdown'),
      skip: () => this.skipMission(),
      go: () => this.game?.skipRead(),
      next: () => this.game?.nextStep(),
    });
    this.hud.setMuted(this.sfx.muted);
    if (this.room) this.hud.names = (f) => this.seatName(f);
    this.applyInsets();
    if (record) this.hud.toast(opts.scenario ? `Recording: ${opts.scenario}` : 'Recording this match', '#8aa0b8');
    // Open on the player's home, zoomed in a little.
    this.camera.open(...this.game.homePoint(), this.renderer.dpr);
    if (opts.goal !== false) {
      this.announceGoal();
      this.game.markHome();
    }
  }

  /**
   * A skirmish or room's match type (#222), outside the campaign and the
   * tutorial (which brief their own): what wins, as a toast; alone, the first
   * time, the campaign's briefing for that kind of battle (#218), which holds
   * the match while it shows.
   */
  private announceGoal(): void {
    const g = this.game;
    if (!g) return;
    const w = g.world;
    const type = battleType(w);
    if (type !== 'domination' && type !== 'stronghold' && type !== 'hold') return;
    // the holder from the setup, not the citadel's owner now: it may have fallen before a rejoin or resume
    const hs = g.setup.stronghold;
    const holder = hs ? g.setup.players[hs.player].faction : -1;
    const text =
      type === 'domination'
        ? 'Domination: score on the gold-ringed key nests'
        : type === 'stronghold'
          ? `♛ Stronghold: take ${this.seatName(holder)}'s citadel to win`
          : (w.siege?.defenders.length ?? 1) > 1
            ? 'Hold the line together: keep every capital until the clock runs out'
            : 'Hold the line: keep your capital until the clock runs out';
    this.hud?.toast(text, type === 'stronghold' ? FACTION_HEX[holder] : '#ffd166');
    // seen apart from the campaign's: its briefings name the warlord, and a skirmish's mustn't use them up
    const seen = `skirmish:${type}`;
    if (g.session.net || g.human < 0 || briefsSeen().includes(seen)) return;
    const m = briefingFor(w, type === 'stronghold' ? 'conquest' : type);
    if (!m) return;
    g.briefing = new MissionRun(m, 0);
    g.onGuideEnd = () => markBriefSeen(seen);
  }

  private endGame(reason: EndReason = 'quit'): void {
    this.saveRec(reason, true);
    this.match?.close();
    this.match = null;
    this.syncAwake();
    this.ownBot = false;
    this.stalled = false;
    this.lostTouch = false;
    if (this.resumeKeep) clearInterval(this.resumeKeep);
    this.resumeKeep = null;
    this.desyncView = null;
    this.desyncNote = null;
    this.netMenu = null;
    this.netNote = null;
    this.netPlayers = null;
    this.demoOverlay?.destroy();
    this.demoOverlay = null;
    this.demoKey = '';
    this.hud?.destroy();
    this.hud = null;
    this.camera.setInsets(0, 0);
    this.game = null;
    this.input.game = null;
  }

  /** Keep the camera's usable area in step with the HUD (#36). */
  private applyInsets(): void {
    const d = this.renderer.dpr;
    this.camera.edgePad = 40 * d;
    const h = this.hud;
    if (h) this.camera.setInsets(Math.round(h.insetTop * d), Math.round(h.insetBottom * d), Math.round(h.insetLeft * d), Math.round(h.insetRight * d));
  }

  private togglePause(): void {
    const g = this.game;
    if (!g || g.result) return;
    if (this.match && this.room) return this.toggleNetMenu();
    g.rec?.pause(g.world, !g.session.paused, performance.now() / 1000);
    if (g.session.paused) {
      g.session.setPaused(false);
      this.input.enabled = true;
      this.setModal(null);
    } else {
      g.session.setPaused(true);
      this.input.enabled = false;
      this.input.reset();
      this.setModal(
        pauseMenu({
          resume: () => this.togglePause(),
          restart: () => {
            const run = this.run;
            if (g.mission) this.playMission(g.mission.index, 'restart');
            else this.startGame(g.setup, { scenario: g.rec?.scenario, seat: g.human >= 0 ? g.human : undefined, goal: !run }, 'restart');
            this.run = run;
            // A campaign battle keeps its locks and warlord, and a briefing not yet seen shows again.
            if (run) this.armRunBattle(run.state, run.node);
          },
          // Leaving a campaign battle is a retreat: it counts as a loss.
          quit: () => {
            if (!this.run) return this.showMenu();
            const report = this.battleReport(false);
            this.showMenu();
            this.finishRunBattle(report);
          },
          quitLabel: this.run ? 'Retreat (counts as a loss)' : undefined,
          audio: this.sfx,
          // Who's on your team (#74), in a team match.
          teams: teamLayout(g.world, g.human).team ? teamsList(g.world, g.human) : undefined,
        }),
      );
    }
  }

  private toggleMute(): void {
    this.sfx.setMuted(!this.sfx.muted);
    this.hud?.setMuted(this.sfx.muted);
  }

  /** A phone keeps its screen on while a room match is under way (#193). */
  private syncAwake(): void {
    this.awake.set(!!this.match && !this.endShown && isMobile());
  }

  /**
   * The room traffic this page saw (#216), oldest first, with where finding
   * the host stands now. In the console: `copy(swarm.netLog())`.
   */
  netLog(): string {
    const l = this.room?.lobby;
    const now = l && 'debug' in l ? `now: ${l.debug()}` : `now: ${this.room ? 'hosting' : 'not in a room'}`;
    return `${this.mp?.netLog() ?? '(multiplayer never loaded)'}\n${now}`;
  }

  /** Dev, or `?debug` (#193): the longest and 95th-percentile gaps between world steps since the last call, ms. */
  turnGaps(): { max: number; p95: number; steps: number } {
    const g = this.stepAt.gaps.slice().sort((a, b) => a - b);
    this.stepAt.gaps = [];
    return { max: Math.round(g[g.length - 1] ?? 0), p95: Math.round(g[Math.floor(g.length * 0.95)] ?? 0), steps: g.length };
  }

  private showEnd(): void {
    const g = this.game!;
    this.endShown = true;
    this.syncAwake();
    // the match is over: nothing left to pick up (#191)
    if (this.room && this.match) void deleteMatch(this.room.id);
    this.input.enabled = false;
    this.input.reset();
    const won = g.result === 'victory';
    if (this.run) {
      const report = this.battleReport(won);
      this.showMenu();
      this.finishRunBattle(report);
      return;
    }
    if (g.mission) {
      const i = g.mission.index;
      const real = !!g.mission.mission.real;
      if (won) this.completeMission(i);
      // Lost the graduation 1v1 before ever winning it: the menu suggests a rematch, or a warm-up.
      else if (real && !loadProgress().done.includes(g.mission.mission.id)) saveProgress({ ...loadProgress(), next: 'rematch' });
      this.setModal(
        missionDebrief(g.mission.mission, i, won, {
          next: () => (won ? this.afterMission(i) : this.skipMission()),
          retry: () => this.playMission(i, 'restart'),
          menu: () => this.showMenu(),
          easy: () => this.playSuggested('easy1v1'),
        }),
      );
      return;
    }
    if (this.match && this.room) {
      const room = this.room;
      const names: Record<number, string> = {};
      room.lobby?.state?.rows.forEach((_, i) => (names[i] = this.seatName(i)));
      const buttons = [{ label: 'Leave room', on: () => this.leaveRoom() }];
      if (room.host) buttons.push({ label: 'Back to lobby', primary: true, on: () => this.backToRoom() } as { label: string; on: () => void; primary?: boolean });
      this.setModal(endScreen(g.world, g.human, won, { rematch: () => undefined, newMap: () => undefined, quit: () => this.leaveRoom() }, { names, buttons, note: room.host ? undefined : 'The host can bring everyone back to the lobby.' }));
      return;
    }
    this.setModal(
      endScreen(g.world, g.human, g.result === 'victory', {
        rematch: () => {
          const q = this.quick;
          this.startGame(g.setup, { scenario: g.rec?.scenario, seat: g.human >= 0 ? g.human : undefined });
          this.quick = q;
        },
        newMap: () => {
          const q = this.quick;
          this.startGame(q !== null ? randomSetup(q) : buildSetup(loadPrefs(), randomSeed()));
          this.quick = q;
        },
        quit: () => this.showMenu(),
      }),
    );
  }

  /**
   * Store the current match's recording. `final` marks it saved, so a match
   * that already ended isn't saved again as quit.
   */
  private saveRec(reason: EndReason, final: boolean): void {
    const g = this.game;
    if (!g?.rec || this.recSaved) return;
    const log = g.session.log;
    // A match left within seconds with no orders tells us nothing.
    if (!log.length && g.world.tick < 15 * TICK_HZ) return;
    const ctrl = 'ctrlLog' in g.session ? (g.session.ctrlLog as Recording['ctrl']) : undefined;
    void saveRecording(g.rec.finish(g.world, log, reason, ctrl));
    if (final) this.recSaved = true;
  }

  // ---- benchmark ---------------------------------------------------------

  private startBench(n: number): void {
    this.showPerf = true;
    const setup: MatchSetup = {
      seed: 99,
      size: 'large',
      players: [
        { faction: 0, team: 0, human: true },
        { faction: 1, team: 1, human: false, bot: { difficulty: 0, personality: 'turtler' } },
      ],
    };
    this.startGame(setup, { record: false });
    const w = this.game!.world;
    const half = Math.floor(Math.min(n, MAX_UNITS - w.count - 64) / 2);
    for (let k = 0; k < half * 2; k++) {
      const side = k % 2;
      const x = side ? w.width * 0.75 + (k % 37) * 4 : w.width * 0.25 - (k % 37) * 4;
      const y = w.height * 0.2 + ((k * 7) % Math.floor(w.height * 0.6));
      spawnUnit(w, side, Kind.Dot, x, y, w.width / 2, w.height / 2, 60);
    }
    this.camera.fit();
  }

  /** `?eventdemo`: a match where every map event fires within seconds. */
  private startEventDemo(): void {
    this.startGame({
      seed: 7,
      size: 'small',
      terrain: 'standard',
      events: { swarm: { first: 3, every: 40, size: 30 }, drop: { first: 2, every: 30 }, colossus: [5], regrow: 5 },
      players: [
        { faction: 0, team: 0, human: true },
        { faction: 1, team: 1, human: false, bot: { difficulty: 1, personality: 'expander' } },
      ],
    }, { record: false });
  }

  /** The `?audiodebug` lines: frame and sim worst, voices, music scheduler, context. */
  private audioLine(secs: number): string {
    const a = this.sfx.stats();
    const ms = (s: number) => (s * 1000).toFixed(0);
    const m = a.music;
    const music = m
      ? `music: lookahead ${ms(m.lookahead)} ms · timer gap ≤${m.worstGap.toFixed(0)} ms · headroom ≥${Number.isFinite(m.minHeadroom) ? ms(m.minHeadroom) : '-'} ms · skips ${m.skips}`
      : 'music: off';
    const u = a.underruns;
    // Remember the latest glitch, so a crackle heard can be matched to its cause.
    const now = performance.now();
    if (u && u.events > 0) this.glitch = { at: now, what: `audio thread underrun ×${u.events} (${u.ms.toFixed(0)} ms)` };
    if (m && (m.late > 0 || m.skips > 0))
      this.glitch = { at: now, what: `music timer late (gap ${m.worstGap.toFixed(0)} ms): ${m.skips ? 'skipped ahead' : `${m.late} steps dropped`}` };
    const ago = this.glitch ? `${((now - this.glitch.at) / 1000).toFixed(1)} s ago: ${this.glitch.what}` : 'none yet';
    return [
      `frame ≤${this.worstFrame.toFixed(0)} ms · sim ≤${this.worstSim.toFixed(1)} ms`,
      `voices ${a.voices}/${a.softCap}/${a.hardCap} · dropped ${(a.dropped / Math.max(secs, 0.001)).toFixed(0)}/s`,
      music,
      `underruns ${u ? `${u.events} (${u.ms.toFixed(0)} ms)` : 'n/a in this browser'} · late steps ${m?.late ?? '-'}`,
      `last glitch: ${ago}`,
      `ctx ${a.state} · ${a.sampleRate} Hz · base ${ms(a.baseLatency)} ms · out ${ms(a.outputLatency)} ms`,
      `quality ${a.quality} (${a.level}) · latency ${a.latencyHint}${a.off.length ? ` · off: ${a.off.join(',')}` : ''}`,
    ].join('\n');
  }

  // ---- frame loop --------------------------------------------------------

  private loop(t: number): void {
    if (this.last) this.worstFrame = Math.max(this.worstFrame, t - this.last);
    const dt = Math.min(0.1, this.last ? (t - this.last) / 1000 : 0);
    this.last = t;
    this.time += dt;
    this.frames++;
    this.fpsAcc += dt;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.frames / this.fpsAcc;
      this.frames = 0;
      this.fpsAcc = 0;
    }

    if (this.renderer.resize()) {
      this.camera.setView(this.renderer.width, this.renderer.height);
      if (!this.game) this.camera.fit();
    }

    const r = this.renderer;
    r.beginFrame();
    this.frame++;

    this.room?.lobby?.update();
    if (this.game) {
      const g = this.game;
      this.input.update(dt);
      this.match?.update();
      g.update(dt, this.time);
      if (this.timeSteps && g.world.tick !== this.stepAt.tick) {
        const now = performance.now();
        if (this.stepAt.tick >= 0 && this.stepAt.gaps.length < 100_000) this.stepAt.gaps.push(now - this.stepAt.at);
        this.stepAt.tick = g.world.tick;
        this.stepAt.at = now;
      }
      // the host resumed: guests' pause menus give way to the countdown over the map (#198)
      if (this.netMenu === 'pause' && (this.match?.session.status?.resumeIn ?? -1) >= 0) this.closeNetMenu();
      if (this.netMenu) this.updateNetNote();
      if (g.result) this.saveRec(g.result, true);
      this.hud?.update(g, dt);
      this.hud?.syncPending(g);
      this.updateBanner(g);
      // resynced or resumed: turns flow again, so the card goes (#165)
      if (this.desyncView && !g.session.paused) this.closeDesync();
      this.applyInsets();
      this.updateDemo(g, dt);
      g.render(this.time);
      if (g.result && !this.endShown && this.time - g.resultTime > 1.6) this.showEnd();
    } else if (this.demo && this.covered) {
      // Hidden under the run map: keep the score going, but don't step or draw the battle.
      this.sfx.update(dt, this.demo.world, -1, 'menu');
    } else if (this.demo) {
      const d = this.demo;
      d.update(dt);
      const w = d.world;
      for (let k = 0; k < w.deaths.length; k += 4) {
        this.particles.burst(w.deaths[k], w.deaths[k + 1], FACTION_RGB[w.deaths[k + 2]], 3, 45, 2, 0.45);
        this.sfx.death(w.deaths[k], w.deaths[k + 1], w.deaths[k + 2]);
      }
      w.deaths = [];
      this.sfx.update(dt, w, -1, 'menu');
      w.fx = [];
      if (w.over || w.tick > 30 * 60 * 6) this.startDemo();
      // slow cinematic drift
      this.camera.zoom = this.camera.fitZoom * 1.12;
      this.camera.cx = w.width / 2 + Math.sin(this.time * 0.05) * w.width * 0.05;
      this.camera.cy = w.height / 2 + Math.cos(this.time * 0.04) * w.height * 0.04;
      drawWorld(r, w, {
        alpha: d.alpha,
        time: this.time,
        frame: this.frame,
        selected: null,
        selectedNests: new Set(),
        hoverNest: -1,
        human: -1,
      });
    }

    // Under the run map the canvas keeps its last frame: nothing new to show.
    if (!this.covered) {
      this.particles.update(dt);
      this.rings.update(dt);
      this.particles.draw(r);
      this.rings.draw(r);
      this.camera.update(dt, this.time);
      if (this.game) this.hud?.placeYou(this.game);
      r.draw(this.camera, this.time);
    }

    const sess = this.game?.session ?? this.demo;
    if (sess) this.worstSim = Math.max(this.worstSim, sess.lastStepMs);
    if (this.showPerf || this.showAudio) {
      const w = this.game?.world ?? this.demo?.world;
      this.perf.style.display = 'block';
      let text = `${this.fps.toFixed(0)} fps · sim ${sess?.lastStepMs.toFixed(2) ?? '-'} ms · units ${w?.count ?? 0} · beams ${w?.beamCount ?? 0}`;
      if (this.showAudio) {
        // A few times a second: cheap on phones, and the worst values per window.
        this.audioAcc += dt;
        if (this.audioAcc >= 0.25 || !this.audioText) {
          this.audioText = this.audioLine(this.audioAcc);
          this.audioAcc = 0;
          this.worstFrame = this.worstSim = 0;
        }
        text += '\n' + this.audioText;
      }
      this.perf.textContent = text;
    } else this.perf.style.display = 'none';

    requestAnimationFrame((tt) => this.loop(tt));
  }
}

try {
  const app = new App();
  // Handy for poking at state from the console during development.
  if (import.meta.env.DEV) (window as unknown as { swarm: App }).swarm = app;
  app.start();
} catch (err) {
  const ui = document.getElementById('ui')!;
  ui.innerHTML = `<div class="screen modal"><div class="card"><h2>Can't start SWARM</h2><p>${(err as Error).message}</p><p>This game needs a browser with WebGL2.</p></div></div>`;
  console.error(err);
}
