import type { Camera } from '../render/camera';

/**
 * Tutorial demos (#17): a ghost cursor (or finger, in mobile mode) that acts
 * out the current step on the real map, looping until the step is done.
 * Purely visual: it never issues commands.
 */
export type DemoAction =
  /** box-select: press at `from`, drag to `to` (world coordinates) */
  | { t: 'drag'; from: [number, number]; to: [number, number] }
  /** send / pick: a tap, or a right-click on desktop when `order` is set */
  | { t: 'tap'; at: [number, number]; order?: boolean }
  /** a HUD button, by its data-a name */
  | { t: 'button'; a: string };

interface Phase {
  /** seconds */
  dur: number;
  /** pointer position (CSS px) at progress k of this phase */
  at: (k: number) => [number, number];
  box?: (k: number) => [number, number, number, number] | null;
  /** show a press ripple at the end, with this label */
  press?: string;
}

const MOVE = 0.7, DRAG = 1.0, PRESS = 0.45, REST = 1.4;
const MIN_BOX = 90;
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

export class DemoOverlay {
  readonly el: HTMLDivElement;
  private pointer: HTMLDivElement;
  private box: HTMLDivElement;
  private ripple: HTMLDivElement;
  private label: HTMLDivElement;
  private source: (() => DemoAction[]) | null = null;
  private phases: Phase[] = [];
  private t = 0;
  private total = 0;
  private pressed = -1;

  constructor(
    root: HTMLElement,
    private readonly camera: Camera,
    private readonly dpr: () => number,
    private readonly touch: () => boolean,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'demo';
    this.el.innerHTML = `<div class="demo-box"></div><div class="demo-ripple"></div><div class="demo-pointer"></div><div class="demo-label"></div>`;
    root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLDivElement;
    this.pointer = q('.demo-pointer');
    this.box = q('.demo-box');
    this.ripple = q('.demo-ripple');
    this.label = q('.demo-label');
  }

  /** Play this step's demo (recomputed each loop so it follows the dots), or stop with null. */
  play(source: (() => DemoAction[]) | null): void {
    this.source = source;
    this.t = 0;
    this.total = 0;
    this.phases = [];
    this.el.classList.toggle('on', !!source);
  }

  destroy(): void {
    this.el.remove();
  }

  private screen(p: [number, number]): [number, number] {
    const [x, y] = this.camera.toScreen(p[0], p[1]);
    const d = this.dpr();
    return [x / d, y / d];
  }

  private buttonAt(a: string): [number, number] | null {
    const b = document.querySelector<HTMLElement>(`.hud [data-a="${a}"]`);
    if (!b || b.offsetParent === null) return null;
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** Turn actions into timed pointer phases, starting from where the pointer appears. */
  private build(actions: DemoAction[]): void {
    const touch = this.touch();
    const phases: Phase[] = [];
    let cur: (() => [number, number]) | null = null;
    const moveTo = (to: () => [number, number]) => {
      const from = cur ?? to;
      phases.push({ dur: cur ? MOVE : 0.25, at: (k) => lerp(from(), to(), ease(k)) });
      cur = to;
    };
    for (const a of actions) {
      if (a.t === 'drag') {
        // At least MIN_BOX px across, so a tight cluster still reads as a drag.
        const corner = (sign: number) => (): [number, number] => {
          const [x0, y0] = this.screen(a.from), [x1, y1] = this.screen(a.to);
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const hw = Math.max(Math.abs(x1 - x0) / 2, MIN_BOX / 2), hh = Math.max(Math.abs(y1 - y0) / 2, MIN_BOX / 2);
          return [cx + sign * hw, cy + sign * hh];
        };
        const p0 = corner(-1), p1 = corner(1);
        moveTo(p0);
        phases.push({
          dur: DRAG,
          at: (k) => lerp(p0(), p1(), ease(k)),
          box: (k) => {
            const [x0, y0] = p0(), [x, y] = lerp(p0(), p1(), ease(k));
            return [Math.min(x0, x), Math.min(y0, y), Math.abs(x - x0), Math.abs(y - y0)];
          },
        });
        cur = p1;
      } else if (a.t === 'tap') {
        const p = () => this.screen(a.at);
        moveTo(p);
        phases.push({ dur: PRESS, at: () => p(), press: touch ? 'tap' : a.order ? 'right-click' : 'click' });
      } else {
        const p = () => this.buttonAt(a.a) ?? cur?.() ?? [innerWidth / 2, innerHeight - 60];
        moveTo(p);
        phases.push({ dur: PRESS, at: () => p(), press: touch ? 'tap' : 'click' });
      }
    }
    phases.push({ dur: REST, at: () => (cur ? cur() : [0, 0]) });
    this.phases = phases;
    this.total = phases.reduce((s, p) => s + p.dur, 0);
  }

  update(dt: number, visible: boolean): void {
    if (!this.source || !visible) {
      this.el.style.opacity = '0';
      return;
    }
    this.el.style.opacity = '';
    if (this.t >= this.total) {
      this.build(this.source());
      this.t = 0;
      this.pressed = -1;
    }
    this.t += dt;
    let t = this.t, i = 0;
    while (i < this.phases.length - 1 && t > this.phases[i].dur) t -= this.phases[i++].dur;
    const ph = this.phases[i];
    if (!ph) return;
    const k = Math.min(1, t / ph.dur);
    const [x, y] = ph.at(k);
    this.pointer.style.transform = `translate(${x}px, ${y}px)`;
    this.pointer.classList.toggle('touch', this.touch());
    // Fade out while resting between loops.
    this.el.classList.toggle('resting', i === this.phases.length - 1);
    const b = ph.box?.(k);
    this.box.style.display = b ? 'block' : 'none';
    if (b) Object.assign(this.box.style, { left: `${b[0]}px`, top: `${b[1]}px`, width: `${b[2]}px`, height: `${b[3]}px` });
    this.pointer.classList.toggle('down', !!ph.box || !!ph.press);
    if (ph.press && this.pressed !== i) {
      this.pressed = i;
      this.ripple.style.transform = `translate(${x}px, ${y}px)`;
      this.ripple.classList.remove('go');
      void this.ripple.offsetWidth;
      this.ripple.classList.add('go');
      this.label.textContent = ph.press;
      this.label.style.transform = `translate(${x + 16}px, ${y + 14}px)`;
      this.label.classList.remove('go');
      void this.label.offsetWidth;
      this.label.classList.add('go');
    }
  }
}

function lerp(a: [number, number], b: [number, number], k: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
