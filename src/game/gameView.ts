import { FACTION_NAMES, FACTION_RGB, WHITE } from '../content/factions';
import { Selection } from '../input/selection';
import type { Camera } from '../render/camera';
import type { Particles, Rings } from '../render/particles';
import type { Renderer } from '../render/renderer';
import { drawWorld } from '../render/scene';
import type { Sfx } from '../audio/sfx';
import { MAX_LEVEL, MAX_UNITS, NEST_NAMES, NEUTRAL, POWER, UNIT_FEEDING, UPGRADE_COST, type MatchSetup } from '../sim/index';
import type { Nest, World } from '../sim/world';
import { LocalSession } from './session';

export interface Services {
  renderer: Renderer;
  camera: Camera;
  particles: Particles;
  rings: Rings;
  sfx: Sfx;
  toast(msg: string, color?: string): void;
}

export type MatchResult = 'victory' | 'defeat';

/** A match in progress: owns the session, selection and event feedback. */
export class GameView {
  readonly session: LocalSession;
  readonly human: number;
  readonly selection = new Selection();
  hoverNest = -1;
  /** paint-select brush shown at the cursor while S is held */
  brush: { x: number; y: number; r: number } | null = null;
  result: MatchResult | null = null;
  resultTime = 0;
  private mask = new Uint8Array(MAX_UNITS);
  private frame = 0;

  constructor(
    readonly setup: MatchSetup,
    private readonly s: Services,
  ) {
    this.session = new LocalSession(setup);
    this.human = setup.players.find((p) => p.human)?.faction ?? -1;
    s.camera.setMap(this.world.width, this.world.height);
    s.camera.fit();
    s.particles.clear();
    s.rings.list = [];
  }

  get world(): World {
    return this.session.world;
  }

  update(dt: number, time: number): void {
    this.session.update(dt);
    this.drainEvents();
    this.selection.prune(this.world, this.human);
    const w = this.world;
    if (!this.result) {
      const me = w.factions[this.human];
      if (me?.eliminated) this.finish('defeat', time);
      else if (w.over) this.finish(w.winnerTeam === w.teamOf[this.human] ? 'victory' : 'defeat', time);
    }
    this.s.sfx.battle(this.session.paused ? 0 : w.beamCount / 500);
  }

  private finish(r: MatchResult, time: number): void {
    this.result = r;
    this.resultTime = time;
    if (r === 'victory') this.s.sfx.victory();
    else this.s.sfx.defeat();
  }

  render(time: number): void {
    this.frame++;
    drawWorld(this.s.renderer, this.world, {
      alpha: this.session.alpha,
      time,
      frame: this.frame,
      selected: this.selection.units.size ? this.selection.mask(this.world, this.mask) : null,
      selectedNests: this.selection.nests,
      hoverNest: this.hoverNest,
      human: this.human,
    });
    if (this.brush) {
      const b = this.brush;
      this.s.renderer.shape(true, b.x, b.y, b.r, 0, 1, 0, 1.5 / b.r, WHITE, 120);
    }
  }

  private drainEvents(): void {
    const w = this.world;
    const { particles, rings, sfx, camera, toast } = this.s;
    const d = w.deaths;
    for (let k = 0; k < d.length; k += 3) {
      particles.burst(d[k], d[k + 1], FACTION_RGB[d[k + 2]], 4, 55, 2, 0.5);
    }
    w.deaths = [];

    for (const e of w.fx) {
      const c = FACTION_RGB[e.f] ?? WHITE;
      const nest = w.nests[e.nest];
      switch (e.type) {
        case 'capture':
          rings.add({ x: e.x, y: e.y, r0: e.r, r1: e.r * 3.2, dur: 0.7, c, thick: 2.5 });
          particles.burst(e.x, e.y, c, 26, 120, 2.6, 0.8);
          if (e.f === this.human) {
            sfx.capture();
            toast(`Captured ${NEST_NAMES[nest.type]}`, hex(e.f));
          } else sfx.enemyCapture();
          break;
        case 'neutralize':
          rings.add({ x: e.x, y: e.y, r0: e.r * 1.4, r1: e.r * 0.6, dur: 0.5, c: FACTION_RGB[e.prev] ?? WHITE, thick: 2 });
          if (e.prev === this.human) {
            sfx.lost();
            toast(`Lost ${NEST_NAMES[nest.type]}`, '#ff5d73');
          }
          break;
        case 'levelup':
          rings.add({ x: e.x, y: e.y, r0: e.r, r1: e.r * 2.2, dur: 0.6, c: WHITE, thick: 2 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.5, r1: e.r * 1.6, dur: 0.5, c, thick: 4 });
          if (e.f === this.human) {
            sfx.levelUp();
            toast(`${NEST_NAMES[nest.type]} upgraded to level ${nest.level}`, hex(e.f));
          }
          break;
        case 'nova': {
          rings.add({ x: e.x, y: e.y, r0: 6, r1: e.r, dur: 0.55, c: WHITE, thick: 5 });
          rings.add({ x: e.x, y: e.y, r0: 4, r1: e.r * 1.15, dur: 0.8, c, thick: 3 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.2, r1: e.r, dur: 0.35, c, thick: 0, disc: true });
          particles.burst(e.x, e.y, c, 60, e.r * 2.2, 2.8, 0.9);
          const [sx, sy] = camera.toScreen(e.x, e.y);
          if (sx > -200 && sy > -200 && sx < camera.viewW + 200 && sy < camera.viewH + 200) {
            camera.shake = Math.min(1, camera.shake + (e.f === this.human ? 0.9 : 0.5));
            sfx.nova();
          }
          break;
        }
        case 'surge':
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.3, r1: e.r * 1.4, dur: 0.5, c, thick: 2 });
          if (e.f === this.human) sfx.surge();
          break;
        case 'upgradeFail':
          if (e.f === this.human) {
            sfx.fail();
            toast(`Need ${e.r} more dots near the nest to upgrade`, '#ffb627');
          }
          break;
        case 'eliminated':
          if (e.f === this.human) toast('You have been eliminated', '#ff5d73');
          else {
            toast(`${FACTION_NAMES[e.f]} eliminated`, hex(e.f));
            sfx.eliminated();
          }
          break;
        case 'absorb':
          break;
      }
    }
    w.fx = [];
  }

  // ---- player actions (from input and HUD) -------------------------------

  nestAt(wx: number, wy: number, slack = 1.25): Nest | null {
    let best: Nest | null = null;
    let bd = Infinity;
    for (const n of this.world.nests) {
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d <= (n.r * slack) ** 2 && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  private ownUnitsIn(test: (x: number, y: number) => boolean): number[] {
    const w = this.world;
    const out: number[] = [];
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== this.human || w.state[i] === UNIT_FEEDING) continue;
      if (test(w.x[i], w.y[i])) out.push(w.uid[i]);
    }
    return out;
  }

  selectBox(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const units = this.ownUnitsIn((x, y) => x >= ax && x <= bx && y >= ay && y <= by);
    const nests = this.world.nests
      .filter((n) => n.owner === this.human && n.x >= ax && n.x <= bx && n.y >= ay && n.y <= by)
      .map((n) => n.id);
    this.selection.set(units, nests, additive);
    if (units.length || nests.length) this.s.sfx.click();
  }

  /**
   * Click-select. Dots win over nests: a nest is picked only by clicking its
   * center, or when no dots are under the cursor.
   */
  selectAt(wx: number, wy: number, radius: number, additive: boolean): boolean {
    const n = this.nestAt(wx, wy);
    const own = n && n.owner === this.human ? n : null;
    const units = this.ownUnitsIn((x, y) => (x - wx) ** 2 + (y - wy) ** 2 <= radius * radius);
    const onCore = own && (own.x - wx) ** 2 + (own.y - wy) ** 2 <= (own.r * 0.4) ** 2;
    if (own && (onCore || units.length === 0)) {
      if (additive && this.selection.nests.has(own.id)) this.selection.nests.delete(own.id);
      else this.selection.set([], [own.id], additive);
      this.s.sfx.click();
      return true;
    }
    if (units.length) {
      // Grow to the whole local blob so a click grabs a group, not one dot.
      const w = this.world;
      let cx = 0, cy = 0;
      for (const u of units) {
        const s = w.uidToSlot.get(u)!;
        cx += w.x[s];
        cy += w.y[s];
      }
      cx /= units.length;
      cy /= units.length;
      const R = radius * 2.2;
      this.selection.set(this.ownUnitsIn((x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= R * R), [], additive);
      this.s.sfx.click();
      return true;
    }
    if (!additive) this.selection.clear();
    return false;
  }

  /** Brush selection (hold Space and move): adds own dots under the brush. */
  paintSelect(wx: number, wy: number, radius: number): void {
    const before = this.selection.units.size;
    for (const u of this.ownUnitsIn((x, y) => (x - wx) ** 2 + (y - wy) ** 2 <= radius * radius)) {
      this.selection.units.add(u);
    }
    if (this.selection.units.size > before) this.s.sfx.click();
  }

  selectAll(): void {
    this.selection.set(this.ownUnitsIn(() => true), [], false);
    this.s.sfx.click();
  }

  commandAt(wx: number, wy: number): boolean {
    const sel = this.selection;
    if (sel.empty) return false;
    const n = this.nestAt(wx, wy);
    const tx = n ? n.x : wx, ty = n ? n.y : wy;
    if (sel.units.size) {
      this.session.issue({ t: 'move', p: this.human, units: [...sel.units], x: wx, y: wy, nest: n ? n.id : -1 });
    }
    if (sel.nests.size) {
      this.session.issue({ t: 'rally', p: this.human, nests: [...sel.nests], x: tx, y: ty });
    }
    const c = FACTION_RGB[this.human];
    this.s.rings.add({ x: tx, y: ty, r0: n ? n.r * 1.8 : 22, r1: n ? n.r * 1.1 : 4, dur: 0.35, c, thick: 2 });
    this.s.sfx.order();
    return true;
  }

  surge(): void {
    if (!this.selection.units.size) return this.s.toast('Select dots first, then Surge', '#9aa4c7');
    if (this.world.factions[this.human].energy < POWER.surgeCost) return this.s.sfx.fail();
    this.session.issue({ t: 'surge', p: this.human, units: [...this.selection.units] });
  }

  nova(): void {
    if (this.selection.units.size < 4) return this.s.toast('Select at least 4 dots for Nova', '#9aa4c7');
    if (this.world.factions[this.human].energy < POWER.novaCost) return this.s.sfx.fail();
    this.session.issue({ t: 'nova', p: this.human, units: [...this.selection.units] });
  }

  upgrade(): void {
    const ids = [...this.selection.nests].filter((id) => {
      const n = this.world.nests[id];
      return n.level < MAX_LEVEL;
    });
    if (!ids.length) return this.s.toast('Select one of your nests to upgrade', '#9aa4c7');
    for (const id of ids) this.session.issue({ t: 'upgrade', p: this.human, nest: id });
  }

  /** remaining cost for the first selected upgradable nest */
  upgradeInfo(): { nest: Nest; cost: number } | null {
    for (const id of this.selection.nests) {
      const n = this.world.nests[id];
      if (n && n.level < MAX_LEVEL) return { nest: n, cost: UPGRADE_COST[n.level] - n.feedProgress - n.feedIncoming };
    }
    return null;
  }

  homePoint(): [number, number] {
    const w = this.world;
    const mine = w.nests.filter((n) => n.owner === this.human);
    if (mine.length) return [mine[0].x, mine[0].y];
    let x = 0, y = 0, c = 0;
    for (let i = 0; i < w.n; i++) {
      if (w.alive[i] && w.owner[i] === this.human) {
        x += w.x[i];
        y += w.y[i];
        c++;
      }
    }
    return c ? [x / c, y / c] : [w.width / 2, w.height / 2];
  }

  selectionCenter(): [number, number] | null {
    const w = this.world;
    let x = 0, y = 0, c = 0;
    for (const u of this.selection.units) {
      const s = w.uidToSlot.get(u);
      if (s === undefined) continue;
      x += w.x[s];
      y += w.y[s];
      c++;
    }
    for (const id of this.selection.nests) {
      x += w.nests[id].x;
      y += w.nests[id].y;
      c++;
    }
    return c ? [x / c, y / c] : null;
  }
}

export function hex(f: number): string {
  const c = FACTION_RGB[f] ?? FACTION_RGB[NEUTRAL];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
