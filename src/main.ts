import './style.css';
import { AudioEngine } from './audio/engine';
import { FACTION_RGB } from './content/factions';
import { GameView, type Services } from './game/gameView';
import { LocalSession } from './game/session';
import { InputController } from './input/controller';
import { Camera } from './render/camera';
import { Particles, Rings } from './render/particles';
import { Renderer } from './render/renderer';
import { drawWorld } from './render/scene';
import { PERSONALITIES } from './sim/ai/bot';
import { Kind, MAX_UNITS } from './sim/constants';
import type { MatchSetup } from './sim/setup';
import { spawnUnit } from './sim/world';
import { Hud } from './ui/hud';
import { buildSetup, endScreen, howToPlay, loadPrefs, mainMenu, pauseMenu, randomSeed, skirmishSetup } from './ui/screens';

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
    window.addEventListener('pointerdown', () => this.sfx.unlock(), { capture: true });
    window.addEventListener('keydown', (e) => {
      this.sfx.unlock();
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') this.toggleMute();
      if (e.key === '`') this.showPerf = !this.showPerf;
    });
  }

  start(): void {
    this.renderer.resize();
    this.camera.setView(this.renderer.width, this.renderer.height);
    const bench = Number(new URLSearchParams(location.search).get('bench'));
    if (bench > 0) this.startBench(bench);
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
    this.setScreen(
      mainMenu({
        skirmish: () => this.showSetup(),
        howto: () => this.setModal(howToPlay(() => this.setModal(null))),
      }),
    );
  }

  private showSetup(): void {
    this.setModal(skirmishSetup((setup) => this.startGame(setup), () => this.setModal(null)));
  }

  private startDemo(): void {
    const n = 4;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const setup: MatchSetup = {
      seed,
      size: 'medium',
      terrain: 'standard',
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

  private startGame(setup: MatchSetup): void {
    this.endGame();
    this.demo = null;
    this.setModal(null);
    this.setScreen(null);
    this.endShown = false;
    this.game = new GameView(setup, this.services);
    this.input.game = this.game;
    this.input.enabled = true;
    this.input.reset();
    this.hud = new Hud(this.ui, {
      all: () => this.game?.selectAll(),
      surge: () => this.game?.surge(),
      nova: () => this.game?.nova(),
      upgrade: () => this.game?.upgrade(),
      clear: () => this.game?.selection.clear(),
      pause: () => this.togglePause(),
      mute: () => this.toggleMute(),
      fortify: () => this.game?.startAim('fortify'),
      barrage: () => this.game?.startAim('barrage'),
      blink: () => this.game?.startAim('blink'),
      lockdown: () => this.game?.startAim('lockdown'),
    });
    this.hud.setMuted(this.sfx.muted);
    // Open on the player's home, zoomed in a little.
    const [hx, hy] = this.game.homePoint();
    this.camera.zoom = this.camera.fitZoom * 1.15;
    this.camera.cx = hx;
    this.camera.cy = hy;
    this.camera.clampPos();
  }

  private endGame(): void {
    this.hud?.destroy();
    this.hud = null;
    this.game = null;
    this.input.game = null;
  }

  private togglePause(): void {
    const g = this.game;
    if (!g || g.result) return;
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
          restart: () => this.startGame(g.setup),
          quit: () => this.showMenu(),
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
    this.setModal(
      endScreen(g.world, g.human, g.result === 'victory', {
        rematch: () => this.startGame(g.setup),
        newMap: () => this.startGame(buildSetup(loadPrefs(), randomSeed())),
        quit: () => this.showMenu(),
      }),
    );
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
    this.startGame(setup);
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
      this.hud?.update(g, dt);
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
