import './style.css';
import { teamLayout, teamsList } from './ui/teams';
import { AudioEngine } from './audio/engine';
import { FACTION_HEX, FACTION_RGB } from './content/factions';
import { GameView, type Services } from './game/gameView';
import type { EndReason, Recording } from './game/recording';
import { downloadJson, recordingEnabled, saveRecording } from './game/recordStore';
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
import { mapBloom, needsBattle, newRun, resolveTurn, type RunState, type TurnResult } from './campaign/run';
import type { BattleReport } from './campaign/broods';
import { battleReport, nodeSetup, warlordOf } from './campaign/battle';
import { PLAYTEST, type Playtest } from './campaign/playtest';
import { playtestMenu } from './ui/playtest';
import { fortressGrid } from './ui/fortressGrid';
import { mapGrid } from './ui/mapGrid';
import { FORTIFY } from './sim/fortify';
import { deleteRun, finishRun, listRuns, loadHistory, saveRun } from './campaign/store';
import { recruitPick, rewardPick, runDebrief, runHub, runMap, starterPick, type MapIntro } from './ui/campaign';
import { DemoOverlay } from './ui/demo';
import { Hud } from './ui/hud';
import { initUiMode, isMobile, markMobileNoticeSeen, setUiMode, shouldShowMobileNotice } from './ui/mobile';
import { buildSetup, campaignMenu, randomSetup, skirmishMenu, endScreen, howToPlay, loadPrefs, mainMenu, menuCard, missionBriefing, missionDebrief, mobileNotice, NEXT_STEP_TEXT, pauseMenu, quickSetup, randomSeed, settingsScreen, skirmishSetup, tutorialMenu } from './ui/screens';
import { creatureGrid } from './ui/creatures';
import { BUILD } from './game/recording';
import type { DesyncReport } from './net/desync';
import type { GuestLobby, HostGo, HostLobby, LobbyState, StartInfo } from './net/lobby';
import type { NetMatch } from './net/match';
import type { Router, Transport } from './net/transport';
import { formatTime } from './ui/hud';
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
  view: LobbyView;
  router: Router | null;
  lobby: HostLobby | GuestLobby | null;
}

const ROOM_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const roomCode = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ROOM_CHARS[b % ROOM_CHARS.length]).join('');
/** `#room=<id>.<secret>` anywhere in a link or hash */
/**
 * This tab's seat token for a room (#164): kept in sessionStorage, so a
 * reload (same tab) gets its seat back mid-match; a new tab is a new player.
 * The host keeps it private; it never reaches other players.
 */
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
  /** no word from the host; the match waits while a new one is found (#166) */
  private stalled = false;
  /** the desync card (#165), while the match is halted for one */
  private desyncView: { el: HTMLDivElement; detail: (text: string) => void; canResync: (on: boolean) => void } | null = null;
  /** the host's word on the last desync, which may come before the halt does */
  private desyncNote: { tick: number; text: string } | null = null;
  /** the current match's recording was saved at its end */
  private recSaved = false;
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
      // In a room match, a hidden page's seat is away at once (#164); back, it's ours again.
      this.match?.setHidden(hidden);
    });
    // Closing the page while hosting: hand hosting to the next player first (#166).
    window.addEventListener('pagehide', (e) => {
      if (!e.persisted && this.match?.host && !this.game?.world.over) this.match.handOff();
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
    if (q.has('debug')) (window as unknown as { swarm: App }).swarm = this;
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
    this.covered = !!m?.classList.contains('runmap');
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
        back: () => this.showCampaign(),
      }),
    );
  }

  private showRunMap(run: RunState, intro: MapIntro | null = null): void {
    if (this.game) this.showMenu();
    // A rescued brood waiting for a place, then a reward waiting to be picked, come first (also when resuming a run).
    if (run.recruit && run.status === 'active') {
      this.setModal(recruitPick(run, this.sfx, { save: () => saveRun(run), done: () => this.showRunMap(run, intro) }));
      return;
    }
    if (run.offer && run.status === 'active') {
      this.setModal(rewardPick(run, this.sfx, { save: () => saveRun(run), done: () => this.showRunMap(run, intro) }));
      return;
    }
    this.setModal(
      runMap(run, this.sfx, { go: (id, fielded) => this.runMove(run, id, fielded), leave: () => this.leaveRun(run), save: () => saveRun(run) }, intro),
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
        const cap = w.nests[sg.capital];
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
    this.startGame(nodeSetup(run, run.heart, run.broods.map((b) => b.id)), { scenario: 'campaign: finale (dev)' });
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
    this.startGame(nodeSetup(run, id, fielded), { scenario: `campaign: ${node.kind}` });
    this.run = { state: run, node: id, fielded };
    if (!run.unlocks.nova) this.game!.lock('nova', 'Unlock Nova at the camp');
    // A warlord's ground (#66): its sting, and its trait announced and kept on screen.
    const lord = warlordOf(run, id);
    if (lord) {
      this.game!.warlord = { faction: lord.faction, trait: lord.traitId };
      this.hud?.setWarlord(lord);
      this.hud?.toast(lord.citadel ? `♛ ${lord.name}'s stronghold: take the citadel to win` : `♛ ${lord.name}: ${lord.text}`, FACTION_HEX[lord.faction]);
      this.sfx.warlordSting(lord.faction);
    }
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
    this.startGame(m.setup(), { scenario: `tutorial: ${m.title}` }, prevEnd);
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
    const mp = (this.mp = await loadMp());
    const hash = `#room=${id}.${secret}`;
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
    const link = `${location.origin}${location.pathname}${location.search}${hash}`;
    const last = mp.loadCharacter();
    const choices = mp.characterChoices(last ? 3 : 4, last ? [last.name] : []);
    if (last) choices.unshift(last);
    const room: Room = { id, secret, host, link, choices, view: null as unknown as LobbyView, router: null, lobby: null };
    const view = (room.view = this.roomView(mp, room));
    this.room = room;
    this.setModal(view.el);
    view.render(null, '', false);
    view.status(host ? 'Opening the room…' : 'Looking for the host…');
    let t: Transport;
    try {
      t = await this.openTransport(mp, id, secret, view);
    } catch (e) {
      view.status(e instanceof Error && e.message.startsWith('Hide my IP') ? e.message : 'Couldn’t open the room. Check your connection and try again.', true);
      return;
    }
    if (this.room !== room) return t.close(); // left while it opened
    const router = new mp.Router(t);
    room.router = router;
    const clock = () => performance.now();
    if (host) {
      room.lobby = this.wireHostLobby(new mp.HostLobby(router.view(mp.LOBBY_KINDS), { build: BUILD, char: choices[0].seed, prefs: loadPrefs(), seed: randomSeed(), clock, mobile: isMobile() }));
      view.status('Send the link to your friends, then start when everyone is in.');
    } else {
      room.lobby = this.wireGuestLobby(new mp.GuestLobby(router.view(mp.LOBBY_KINDS), { build: BUILD, char: choices[0].seed, mobile: isMobile(), token: seatToken(id), clock }));
    }
    this.renderRoom();
  }

  /** The room's screen: with the host's controls when we run the room. */
  private roomView(mp: Mp, room: Room): LobbyView {
    const hostLobby = () => (room.lobby instanceof mp.HostLobby ? room.lobby : null);
    return mp.lobbyScreen(room.link, room.choices, {
      leave: () => this.leaveRoom(),
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
            botSecs: (secs) => hostLobby()?.setBotSecs(secs),
            seed: (text) => hostLobby()?.setSeed(text),
            row: (seat, row) => hostLobby()?.setRow(seat, row),
            kick: (seat) => hostLobby()?.kick(seat),
            start: () => hostLobby()?.start(),
          }
        : undefined,
    });
  }

  private wireHostLobby(lobby: HostLobby): HostLobby {
    lobby.onChange = () => {
      this.renderRoom();
      this.peersChanged();
    };
    lobby.onGo = (go) => this.hostGo(go);
    // a guest reloaded mid-match and proved their seat: it answers to their new connection (#164)
    lobby.onRejoin = (seat, peer) => this.match?.rebind(seat, peer);
    return lobby;
  }

  private wireGuestLobby(lobby: GuestLobby): GuestLobby {
    const status = (text: string, error = false) => this.room?.view.status(text, error);
    lobby.onChange = (st) => {
      this.peersChanged();
      // back in the lobby while the match was still on: the host ended it (#183)
      const ended = st.phase === 'lobby' && !!this.match && !this.game?.world.over;
      status(st.phase === 'lobby' ? (ended ? 'The host ended the match. Waiting for the host to start the next one.' : 'Waiting for the host to start the match.') : 'The match is starting…');
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
      status(why, true);
    };
    // in a match, the match itself watches the host (and finds a new one, #166)
    lobby.onNoHost = (why) => {
      if (!this.match) this.roomLost(why);
    };
    lobby.onHostLink = (state) => {
      if (this.match) return;
      if (state === 'lost') status('Lost connection to the host. Reconnecting…', true);
      else status(lobby.state?.phase === 'playing' ? 'The match is starting…' : 'Waiting for the host to start the match.');
    };
    lobby.onStart = (st) => this.guestGo(st);
    return lobby;
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
    const lobby = this.wireGuestLobby(new mp.GuestLobby(r.router.view(mp.LOBBY_KINDS), { build: BUILD, char: this.ownChar(old.state), mobile: isMobile(), token: seatToken(r.id), clock: () => performance.now() }));
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

  /** The room's rows changed mid-match (a rejoin under a new peer id): the match's list of who could host follows (#166). */
  private peersChanged(): void {
    const s = this.room?.lobby?.state;
    if (this.match && this.game && s?.phase === 'playing') this.match.updatePeers(this.mp!.matchPeers(s, this.game.setup));
  }

  /**
   * Hosting passed to us mid-match (#166): the room comes too. Its state as
   * we last saw it, run from here; the old host's seat tokens didn't come, so
   * a player who reloads can't get back into this match.
   */
  private becomeRoomHost(): void {
    const r = this.room, mp = this.mp, m = this.match;
    if (!r?.router || !mp || !m || r.host || !(r.lobby instanceof mp.GuestLobby) || !r.lobby.state) return;
    const old = r.lobby;
    old.close();
    r.host = true;
    r.view = this.roomView(mp, r);
    const lobby = new mp.HostLobby(r.router.view(mp.LOBBY_KINDS), {
      build: BUILD,
      char: this.ownChar(old.state),
      prefs: loadPrefs(),
      seed: old.state!.seed,
      clock: () => performance.now(),
      mobile: isMobile(),
      takeOver: { state: old.state!, connected: m.livePeers() },
    });
    r.lobby = this.wireHostLobby(lobby);
    lobby.announce();
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
      const match = mp.NetMatch.guest(r.router.view(mp.MATCH_KINDS), s.setup, s.seat, s.host, { resume, peers, botMs: (st?.botSecs ?? 60) * 1000 });
      this.startGame(s.setup, { seat: s.seat, match, record: false });
    } catch {
      r.view.status('The host sent a match this version can’t play.', true);
      return;
    }
    if (!resume) (r.lobby as GuestLobby).ready();
  }

  /** After a match: back to the room's lobby (the host brings everyone). */
  private backToRoom(): void {
    const r = this.room;
    if (!r) return this.showMenu();
    if (r.host) (r.lobby as HostLobby | null)?.backToLobby();
    this.endGame();
    this.startDemo();
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
    r.view.status(
      why === 'left' ? 'The host left the room.' : why === 'lost' ? 'Lost connection to the host, and it didn’t come back. Check your connection and open the link again.' : 'No one is hosting this room. Check the link, or ask the host to open it again.',
      true,
    );
  }

  /** Leave the room for good, and go back to the menu. */
  private leaveRoom(): void {
    this.closeRoom();
    this.showMenu();
  }

  private closeRoom(): void {
    const r = this.room;
    if (!r) return;
    this.room = null;
    this.match?.close();
    this.match = null;
    r.lobby?.close();
    r.router?.close();
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
      resync: () => {
        if (m.resync()) this.closeDesync();
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
    const reported = m.host ? m.reportedHashes() : { [g.human]: s.hashLog.slice() };
    const turns = m.host && m.seq ? m.seq.closedTurns() : s.closedTurns();
    downloadJson(`swarm-desync-${tick}.json`, mp.buildBundle({ setup: g.setup, seat: g.human, host: m.host, report, reported, turns }));
  }

  /** The line that stays on screen while you watch after your defeat (#183). */
  private updateBanner(g: GameView): void {
    const h = this.hud;
    if (!h) return;
    // first: no host to be had, rejoining or not; there's a way out
    if (this.stalled && !g.result) return h.banner('Lost touch with the host. Finding a new one…', [{ label: 'Leave', on: () => this.leaveRoom() }]);
    if (g.session.syncing) return h.banner('Rejoining the match…');
    if (g.session.seatBot) this.ownBot = true; // back from a reload with a bot in our seat: no control entry said so
    if (g.session.seatBot && !g.spectating && !g.result) return h.banner('An Easy bot is playing for you. Taking your seat back…');
    if (!g.spectating || g.result) return h.banner(null);
    const p = g.placing;
    h.banner(`You've been defeated${p ? ` · ${ordinal(p.place)} of ${p.of}` : ''}. Watching the rest of the match.`, [{ label: 'Leave', on: () => this.leaveMatch() }]);
  }

  /**
   * Leave a room match. A host hands hosting to the next player first
   * (#166), so the match goes on without it; the handoff gets a moment to
   * go out before the connection closes.
   */
  private leaveMatch(): void {
    const m = this.match;
    if (!m?.host || this.game?.world.over) return this.leaveRoom();
    if (m.handOff()) {
      this.input.enabled = false;
      setTimeout(() => this.leaveRoom(), 150);
      return;
    }
    // nobody can take over right now (the others are hidden, or still rejoining): say what leaving does
    if (m.livePeers().length === 0) return this.leaveRoom();
    this.confirmNet('Leave the match?', 'Nobody can take over hosting right now, so leaving ends the match for everyone else. To stop it and keep the room, use End match instead.', 'Leave and end it', () => this.leaveRoom());
  }

  /** Host (#183): stop the match for everyone and bring them back to the room, to change settings or let someone in. */
  private endMatch(): void {
    this.confirmNet('End the match for everyone?', 'Everyone goes back to the room, where you can change the settings or let someone new join, then start again.', 'End match', () => this.backToRoom());
  }

  /** Host (#183): the same room and settings, from the start. */
  private restartMatch(): void {
    this.confirmNet('Restart the match for everyone?', 'Same room, same settings, from the start.', 'Restart', () => {
      this.backToRoom();
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
      quitLabel: host && this.match!.successorSeat() >= 0 ? `Leave (hosting passes to ${this.seatName(this.match!.successorSeat())})` : 'Leave match',
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
    const rows = lat.map((r) => {
      const tag = r.state === 'away' ? ' <small>away</small>' : r.state === 'bot' ? ' <small>bot playing</small>' : r.state === 'spectating' ? ' <small>watching</small>' : '';
      const cls = r.delay >= 300 ? 'bad' : r.delay >= 150 ? 'warn' : '';
      return `<tr><td><i style="background:${FACTION_HEX[r.seat]}"></i>${esc(this.seatName(r.seat))}${r.seat === me ? ' (you)' : ''}${tag}</td><td>${r.rtt} ms</td><td class="${cls}">${r.delay} ms</td></tr>`;
    });
    return `<table class="lat"><thead><tr><th></th><th>Round trip</th><th>Order delay</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
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
  private startGame(setup: MatchSetup, opts: { scenario?: string; record?: boolean; seat?: number; match?: NetMatch } = {}, prevEnd: EndReason = 'quit'): void {
    this.endGame(prevEnd);
    this.match = opts.match ?? null;
    this.demo = null;
    this.setModal(null);
    this.setScreen(null);
    this.endShown = false;
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
          const who = this.seatName(seat);
          if (state === 'away') this.hud?.toast(`${who} lost connection`, '#8aa0b8');
          else if (state === 'bot') this.hud?.toast(`${who} dropped: an Easy bot took over`, '#ffb627');
          else this.hud?.toast(`${who} is back`, '#8aa0b8');
        },
        onPause: (p) => this.netPaused(p),
        // hosting passed to another player (#166); the room comes with it
        onLeader: (seat, peer) => {
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
  }

  private endGame(reason: EndReason = 'quit'): void {
    this.saveRec(reason, true);
    this.match?.close();
    this.match = null;
    this.ownBot = false;
    this.stalled = false;
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
            else this.startGame(g.setup, { scenario: g.rec?.scenario, seat: g.human >= 0 ? g.human : undefined }, 'restart');
            this.run = run;
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

  private showEnd(): void {
    const g = this.game!;
    this.endShown = true;
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
