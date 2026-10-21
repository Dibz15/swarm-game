import type { GameView } from '../game/gameView';
import type { Camera } from '../render/camera';
import type { Renderer } from '../render/renderer';

interface Ptr {
  id: number;
  type: string;
  button: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  moved: boolean;
}

const DRAG_PX = 6;

/**
 * Mouse / touch / keyboard -> GameView actions.
 *
 * Mouse: left-drag box-select, left-click select, double-click select all,
 * hold Space + move to paint-select, right-click order, WASD / arrows /
 * middle-drag / wheel camera.
 * Touch: one-finger drag box-selects, tap orders when something is
 * selected (or selects own stuff when nothing is), two fingers pan + pinch.
 */
export class InputController {
  game: GameView | null = null;
  enabled = true;
  onPause: () => void = () => {};

  private ptrs = new Map<number, Ptr>();
  private boxEl: HTMLDivElement;
  private boxing = false;
  private panning = false;
  private pinchDist = 0;
  private pinchMid: [number, number] = [0, 0];
  private lastClick = { t: 0, x: 0, y: 0 };
  private keys = new Set<string>();
  /** physical key codes, so WASD panning works on any keyboard layout */
  private codes = new Set<string>();
  private hoverPos: [number, number] | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly renderer: Renderer,
  ) {
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'selbox';
    document.body.appendChild(this.boxEl);

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.cancel(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      this.codes.delete(e.code);
      if (e.code === 'Space') this.stopPaint();
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.codes.clear();
      this.stopPaint();
    });
  }

  private dev(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const d = this.renderer.dpr;
    return [(e.clientX - r.left) * d, (e.clientY - r.top) * d];
  }

  private world(sx: number, sy: number): [number, number] {
    return this.camera.toWorld(sx, sy);
  }

  /** selection pick radius: ~18 css px in world units */
  private pickRadius(): number {
    return (18 * this.renderer.dpr) / this.camera.zoom;
  }

  private down(e: PointerEvent): void {
    if (!this.game || !this.enabled) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const [x, y] = this.dev(e);
    const p: Ptr = { id: e.pointerId, type: e.pointerType, button: e.button, sx: x, sy: y, x, y, moved: false };
    this.ptrs.set(e.pointerId, p);

    if (e.pointerType === 'touch') {
      if (this.touches().length === 2) {
        this.endBox(false);
        this.startPinch();
      }
      return;
    }
    if (e.button === 2) {
      const [wx, wy] = this.world(x, y);
      this.game.commandAt(wx, wy);
    } else if (e.button === 1) {
      this.panning = true;
      e.preventDefault();
    }
  }

  private touches(): Ptr[] {
    return [...this.ptrs.values()].filter((p) => p.type === 'touch');
  }

  private startPinch(): void {
    const [a, b] = this.touches();
    this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchMid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  }

  private move(e: PointerEvent): void {
    if (!this.game) return;
    const [x, y] = this.dev(e);
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.hoverPos = [x, y];
      return;
    }
    const dx = x - p.x, dy = y - p.y;
    p.x = x;
    p.y = y;
    if (!p.moved && Math.hypot(x - p.sx, y - p.sy) > DRAG_PX * this.renderer.dpr) p.moved = true;
    if (e.pointerType === 'mouse') this.hoverPos = [x, y];

    const ts = this.touches();
    if (e.pointerType === 'touch' && ts.length >= 2) {
      const [a, b] = ts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      this.camera.pan(mid[0] - this.pinchMid[0], mid[1] - this.pinchMid[1]);
      if (this.pinchDist > 0) this.camera.zoomAt(mid[0], mid[1], dist / this.pinchDist);
      this.pinchDist = dist;
      this.pinchMid = mid;
      return;
    }

    if (this.panning) {
      this.camera.pan(dx, dy);
      return;
    }
    const isSelectDrag = (p.type === 'mouse' && p.button === 0) || p.type === 'touch' || p.type === 'pen';
    if (isSelectDrag && p.moved) {
      this.boxing = true;
      this.drawBox(p);
    }
  }

  private drawBox(p: Ptr): void {
    const d = this.renderer.dpr;
    const r = this.canvas.getBoundingClientRect();
    const x0 = Math.min(p.sx, p.x) / d + r.left, y0 = Math.min(p.sy, p.y) / d + r.top;
    const w = Math.abs(p.x - p.sx) / d, h = Math.abs(p.y - p.sy) / d;
    const s = this.boxEl.style;
    s.display = 'block';
    s.left = `${x0}px`;
    s.top = `${y0}px`;
    s.width = `${w}px`;
    s.height = `${h}px`;
  }

  private endBox(apply: boolean, p?: Ptr, additive = false): void {
    if (this.boxing && apply && p && this.game) {
      const [ax, ay] = this.world(p.sx, p.sy);
      const [bx, by] = this.world(p.x, p.y);
      this.game.selectBox(ax, ay, bx, by, additive);
    }
    this.boxing = false;
    this.boxEl.style.display = 'none';
  }

  private up(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    if (!this.game || !this.enabled) {
      this.endBox(false);
      this.panning = false;
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (p.type === 'touch') {
      if (this.touches().length > 0) {
        // finished a pinch; ignore the lifted finger
        this.pinchDist = 0;
        return;
      }
      if (this.boxing) return this.endBox(true, p, false);
      if (!p.moved) this.tap(p.x, p.y);
      return;
    }

    if (p.button === 1) {
      this.panning = false;
      return;
    }
    if (p.button !== 0) return;
    if (this.boxing) return this.endBox(true, p, additive);

    const [wx, wy] = this.world(p.x, p.y);
    const now = performance.now();
    const dbl = now - this.lastClick.t < 320 && Math.hypot(p.x - this.lastClick.x, p.y - this.lastClick.y) < 20;
    this.lastClick = { t: now, x: p.x, y: p.y };
    if (dbl) {
      this.game.selectAll();
      return;
    }
    this.game.selectAt(wx, wy, this.pickRadius(), additive);
  }

  /** Touch tap: order if something is selected, else try to select. */
  private tap(sx: number, sy: number): void {
    const g = this.game!;
    const [wx, wy] = this.world(sx, sy);
    if (!g.selection.empty) {
      g.commandAt(wx, wy);
    } else {
      g.selectAt(wx, wy, this.pickRadius() * 1.6, false);
    }
  }

  private cancel(e: PointerEvent): void {
    this.ptrs.delete(e.pointerId);
    this.endBox(false);
    this.panning = false;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.game) return;
    const [x, y] = this.dev(e);
    const k = e.deltaMode === 1 ? 0.05 : 0.0015;
    this.camera.zoomAt(x, y, Math.exp(-e.deltaY * k));
  }

  private keydown(e: KeyboardEvent): void {
    if (!this.game) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      this.onPause();
      return;
    }
    if (!this.enabled) return;
    this.keys.add(k);
    const g = this.game;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) this.codes.add(e.code);
    if (e.code === 'Space') {
      // Hold Space and sweep the cursor to paint-select (trackpad friendly).
      e.preventDefault();
      if (!e.repeat) {
        if (!e.shiftKey) g.selection.clear();
        this.painting = true;
      }
      return;
    }
    if (mod && k === 'a') {
      e.preventDefault();
      g.selectAll();
      return;
    }
    if (k >= '1' && k <= '9') {
      const n = Number(k);
      if (mod) {
        g.selection.saveGroup(n);
        e.preventDefault();
      } else if (g.selection.recallGroup(n)) {
        g.selection.prune(g.world, g.human);
        // double-tap the number to jump to it
        if (this.lastGroup === n && performance.now() - this.lastGroupT < 350) this.centerOnSelection();
        this.lastGroup = n;
        this.lastGroupT = performance.now();
      }
      return;
    }
    if (mod) return;
    switch (k) {
      case 'z':
        g.selectAll();
        break;
      case 'q':
        g.surge();
        break;
      case 'e':
        g.nova();
        break;
      case 'u':
        g.upgrade();
        break;
      case 'c':
        if (!this.centerOnSelection()) {
          const [x, y] = g.homePoint();
          this.camera.cx = x;
          this.camera.cy = y;
        }
        break;
      case 'h': {
        const [x, y] = g.homePoint();
        this.camera.cx = x;
        this.camera.cy = y;
        break;
      }
      case 'f':
        this.camera.fit();
        break;
    }
  }

  private painting = false;

  private stopPaint(): void {
    this.painting = false;
    if (this.game) this.game.brush = null;
  }

  private lastGroup = -1;
  private lastGroupT = 0;

  private centerOnSelection(): boolean {
    const c = this.game?.selectionCenter();
    if (!c) return false;
    this.camera.cx = c[0];
    this.camera.cy = c[1];
    this.camera.clampPos();
    return true;
  }

  /** per-frame: keyboard panning and hover */
  update(dt: number): void {
    if (!this.game) return;
    const sp = (900 * dt * this.renderer.dpr);
    let dx = 0, dy = 0;
    const c = this.codes;
    if (c.has('ArrowLeft') || c.has('KeyA')) dx += sp;
    if (c.has('ArrowRight') || c.has('KeyD')) dx -= sp;
    if (c.has('ArrowUp') || c.has('KeyW')) dy += sp;
    if (c.has('ArrowDown') || c.has('KeyS')) dy -= sp;
    if (dx || dy) this.camera.pan(dx, dy);

    if (this.hoverPos) {
      const [wx, wy] = this.world(this.hoverPos[0], this.hoverPos[1]);
      if (this.painting && this.enabled) {
        const r = (34 * this.renderer.dpr) / this.camera.zoom;
        this.game.brush = { x: wx, y: wy, r };
        this.game.paintSelect(wx, wy, r);
      }
      const n = this.game.nestAt(wx, wy);
      this.game.hoverNest = n ? n.id : -1;
      this.canvas.style.cursor = n ? 'pointer' : 'crosshair';
    }
  }

  reset(): void {
    this.stopPaint();
    this.ptrs.clear();
    this.keys.clear();
    this.codes.clear();
    this.endBox(false);
    this.panning = false;
  }
}
