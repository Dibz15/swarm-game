import './style.css';
import { AudioEngine } from './audio/engine';
import { FACTION_RGB } from './content/factions';
import { GameView, type Services } from './game/gameView';
import type { EndReason } from './game/recording';
import { recordingEnabled, saveRecording } from './game/recordStore';
import { LocalSession } from './game/session';
import { loadProgress, MISSIONS, MissionRun, nextMission, saveProgress, type NextStep } from './game/tutorial';
import { InputController } from './input/controller';
import { Camera } from './render/camera';
import { Particles, Rings } from './render/particles';
import { Renderer } from './render/renderer';
import { drawWorld } from './render/scene';
import { PERSONALITIES } from './sim/ai/bot';
import { Kind, MAX_UNITS, TICK_HZ } from './sim/constants';
import type { MatchSetup } from './sim/setup';
import { spawnUnit } from './sim/world';
import { needsBattle, newRun, resolveTurn, type RunState, type TurnResult } from './campaign/run';
import type { BattleReport } from './campaign/broods';
import { nodeSetup } from './campaign/battle';
import { deleteRun, finishRun, listRuns, loadHistory, saveRun } from './campaign/store';
import { runDebrief, runHub, runMap, starterPick, type MapIntro } from './ui/campaign';
import { DemoOverlay } from './ui/demo';
import { Hud } from './ui/hud';
import { initUiMode, isMobile, markMobileNoticeSeen, setUiMode, shouldShowMobileNotice } from './ui/mobile';
import { buildSetup, campaignMenu, randomSetup, skirmishMenu, endScreen, howToPlay, loadPrefs, mainMenu, menuCard, missionBriefing, missionDebrief, mobileNotice, NEXT_STEP_TEXT, pauseMenu, quickSetup, randomSeed, settingsScreen, skirmishSetup, tutorialMenu } from './ui/screens';

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
  /** background battle behind the menus */
  private demo: LocalSession | null = null;
  private screen: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private endShown = false;
  /** the current match's recording was saved at its end */
  private recSaved = false;
  /** the current match is the tutorial's graduation 1v1 */
  private graduation = false;
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
      if (document.visibilityState === 'hidden') this.saveRec('unload', false);
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
    else this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---- screens -----------------------------------------------------------

  private setScreen(s: HTMLElement | null): void {
    this.screen?.remove();
    this.screen = s;
    if (s) this.ui.appendChild(s);
  }

  private setModal(m: HTMLElement | null): void {
    this.modal?.remove();
    this.modal = m;
    if (m) this.ui.appendChild(m);
  }

  private showMenu(): void {
    this.endGame();
    this.startDemo();
    this.setModal(null);
    const menu = mainMenu({
      skirmish: () => this.showSkirmish(),
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
                { label: 'Rematch Normal', primary: true, on: () => this.playSuggested('normal1v1') },
                { label: '1v1 vs Easy', on: () => this.playSuggested('easy1v1') },
              ]
            : [{ label: 'Play the 1v1', primary: true, on: () => this.playSuggested('normal1v1', true) }];
      buttons.push({ label: 'Dismiss', on: dismiss({ next: undefined }) });
      return menuCard(NEXT_STEP_TEXT[p.next], buttons);
    }
    return null;
  }

  private playSuggested(kind: 'normal1v1' | 'easy1v1' | 'ffa', graduation = false): void {
    if (!graduation) saveProgress({ ...loadProgress(), next: undefined });
    this.startGame(quickSetup(kind));
    this.graduation = graduation;
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
              pick: (pack) => {
                const run = newRun(seed, loadPrefs().color, pack);
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
    this.setModal(
      runMap(run, this.sfx, { go: (id, fielded) => this.runMove(run, id, fielded), leave: () => this.showRunHub(), save: () => saveRun(run) }, intro),
    );
  }

  /** Move to a node: fight for it, or march through a node already taken. */
  private runMove(run: RunState, id: number, fielded: number[]): void {
    if (!needsBattle(run, id)) {
      const from = run.bloom.front;
      const res = resolveTurn(run, id, null);
      this.saveRunState(run);
      this.runSounds(res);
      this.showRunMap(run, { from, fresh: res.fresh });
      return;
    }
    const node = run.nodes[id];
    this.startGame(nodeSetup(run, id, window.innerHeight > window.innerWidth * 1.15, fielded), { scenario: `campaign: ${node.kind}` });
    this.run = { state: run, node: id, fielded };
    if (!run.unlocks.nova) this.game!.lock('nova', 'Unlock Nova at the camp');
  }

  /** How the battle ended for the run: survivors by kind, nests held, time. */
  private battleReport(won: boolean): BattleReport {
    const g = this.game;
    const survivors = [0, 0, 0, 0];
    let nests = 0, seconds = 0;
    if (g) {
      const w = g.world;
      for (let i = 0; i < w.n; i++) if (w.alive[i] && w.owner[i] === g.human && w.kind[i] < survivors.length) survivors[w.kind[i]]++;
      nests = w.nests.filter((n) => n.owner === g.human).length;
      seconds = w.tick / TICK_HZ;
    }
    return { won, survivors, nests, seconds };
  }

  private runSounds(res: TurnResult): void {
    const s = this.sfx;
    for (const e of res.events) {
      if (e.what === 'died') s.broodLost();
      else if (e.what === 'wounded') s.broodWounded();
      else if (e.what === 'rescued') s.broodRescued();
    }
    if (res.checkpoint === 'reached') s.checkpointReached();
    if (res.checkpoint === 'restored') s.checkpointRestart();
  }

  /** The battle is over (or abandoned): update the run and show the debrief. */
  private finishRunBattle(report: BattleReport): void {
    const r = this.run;
    if (!r) return;
    this.run = null;
    const from = r.state.bloom.front;
    const res = resolveTurn(r.state, r.node, report, r.fielded);
    this.saveRunState(r.state);
    this.runSounds(res);
    if (r.state.status === 'won') this.sfx.victory();
    else if (r.state.status === 'lost') this.sfx.defeat();
    this.setModal(
      runDebrief(r.state, r.state.nodes[r.node], report.won, res, {
        next: () => this.showRunMap(r.state, { from, fresh: res.fresh }),
        hub: () => this.showRunHub(),
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
    this.startGame(m.setup(window.innerHeight > window.innerWidth * 1.15), { scenario: `tutorial: ${m.title}` }, prevEnd);
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
    const key = `${m.step}`;
    if (key !== this.demoKey) {
      this.demoKey = key;
      const step = m.current;
      d.play(step?.demo ? () => step.demo!({ w: g.world, human: g.human, log: g.session.log }) : null);
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
    if (!p.done.includes(MISSIONS[i].id)) p.done.push(MISSIONS[i].id);
    if (i === MISSIONS.length - 1) {
      p.graduated = true;
      p.next = 'graduate';
    }
    saveProgress(p);
  }

  /** Straight into the next mission: the debrief already said what's next, and the coach names it. */
  private afterMission(i: number): void {
    if (i < MISSIONS.length - 1) this.playMission(i + 1);
    else this.playSuggested('normal1v1', true);
  }

  private skipMission(): void {
    const m = this.game?.mission;
    if (!m) return;
    this.completeMission(m.index);
    this.afterMission(m.index);
  }

  private showSkirmish(): void {
    this.setModal(
      skirmishMenu({
        quick: (difficulty) => {
          this.startGame(randomSetup(difficulty));
          this.quick = difficulty;
        },
        custom: () => this.showSetup(),
        back: () => this.setModal(null),
      }),
    );
  }

  private showSetup(): void {
    this.setModal(skirmishSetup((setup, scenario) => this.startGame(setup, { scenario }), () => this.showSkirmish()));
  }

  private startDemo(): void {
    const n = 4;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const setup: MatchSetup = {
      seed,
      size: 'medium',
      terrain: 'standard',
      events: 'normal',
      portrait: window.innerHeight > window.innerWidth * 1.15,
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

  private startGame(setup: MatchSetup, opts: { scenario?: string; record?: boolean } = {}, prevEnd: EndReason = 'quit'): void {
    this.endGame(prevEnd);
    this.demo = null;
    this.setModal(null);
    this.setScreen(null);
    this.endShown = false;
    this.recSaved = false;
    this.graduation = false;
    this.quick = null;
    this.run = null;
    const record = opts.record !== false && recordingEnabled();
    this.game = new GameView(setup, this.services, record ? { scenario: opts.scenario, mobile: isMobile() } : null);
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
    });
    this.hud.setMuted(this.sfx.muted);
    this.applyInsets();
    if (record) this.hud.toast(opts.scenario ? `Recording: ${opts.scenario}` : 'Recording this match', '#8aa0b8');
    // Open on the player's home, zoomed in a little.
    this.camera.open(...this.game.homePoint(), this.renderer.dpr);
  }

  private endGame(reason: EndReason = 'quit'): void {
    this.saveRec(reason, true);
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
    if (this.hud) this.camera.setInsets(Math.round(this.hud.insetTop * d), Math.round(this.hud.insetBottom * d));
  }

  private togglePause(): void {
    const g = this.game;
    if (!g || g.result) return;
    g.rec?.pause(g.world, !g.session.paused, performance.now() / 1000);
    if (g.session.paused) {
      g.session.paused = false;
      this.input.enabled = true;
      this.setModal(null);
    } else {
      g.session.paused = true;
      this.input.enabled = false;
      this.input.reset();
      this.setModal(
        pauseMenu({
          resume: () => this.togglePause(),
          restart: () => {
            const run = this.run;
            if (g.mission) this.playMission(g.mission.index, 'restart');
            else this.startGame(g.setup, { scenario: g.rec?.scenario }, 'restart');
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
      if (won) this.completeMission(i);
      this.setModal(
        missionDebrief(g.mission.mission, i, won, {
          next: () => (won ? this.afterMission(i) : this.skipMission()),
          retry: () => this.playMission(i, 'restart'),
          menu: () => this.showMenu(),
        }),
      );
      return;
    }
    if (this.graduation) {
      const next: NextStep = won ? 'ffa' : 'rematch';
      saveProgress({ ...loadProgress(), next });
    }
    this.setModal(
      endScreen(g.world, g.human, g.result === 'victory', {
        rematch: () => {
          const q = this.quick;
          this.startGame(g.setup, { scenario: g.rec?.scenario });
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
    void saveRecording(g.rec.finish(g.world, log, reason));
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

  // ---- frame loop --------------------------------------------------------

  private loop(t: number): void {
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

    if (this.game) {
      const g = this.game;
      this.input.update(dt);
      g.update(dt, this.time);
      if (g.result) this.saveRec(g.result, true);
      this.hud?.update(g, dt);
      this.applyInsets();
      this.updateDemo(g, dt);
      g.render(this.time);
      if (g.result && !this.endShown && this.time - g.resultTime > 1.6) this.showEnd();
    } else if (this.demo) {
      const d = this.demo;
      d.update(dt);
      const w = d.world;
      for (let k = 0; k < w.deaths.length; k += 3) {
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

    this.particles.update(dt);
    this.rings.update(dt);
    this.particles.draw(r);
    this.rings.draw(r);
    this.camera.update(dt, this.time);
    r.draw(this.camera, this.time);

    if (this.showPerf) {
      const w = this.game?.world ?? this.demo?.world;
      const s = this.game?.session ?? this.demo;
      this.perf.style.display = 'block';
      this.perf.textContent = `${this.fps.toFixed(0)} fps · sim ${s?.lastStepMs.toFixed(2) ?? '-'} ms · units ${w?.count ?? 0} · beams ${w?.beamCount ?? 0}`;
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
