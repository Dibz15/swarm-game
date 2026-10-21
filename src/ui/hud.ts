import { FACTION_NAMES } from '../content/factions';
import { hex, type GameView } from '../game/gameView';
import { DOMINATION, MAX_LEVEL, NEST_BLURB, NEST_NAMES, NEUTRAL, POWER, TICK_HZ, UPGRADE_COST } from '../sim/index';

const TIPS = [
  'Drag to select your dots, right-click to send them. Tap on touch.',
  'Click one of your nests, then right-click somewhere to set its rally point.',
  'Select a nest and press U to feed it dots and level it up.',
  'Surge (Q) speeds up selected dots. Nova (E) blasts enemies but costs some of your own dots.',
  'Hold 70% of the nests for 30 seconds to win by domination.',
  'Ctrl+1–5 saves a control group. Press 1–5 to recall it. Space centers the camera.',
];

export function formatTime(ticks: number): string {
  const s = Math.floor(ticks / TICK_HZ);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** DOM heads-up display. Refreshed ~10x/s so it never costs layout every frame. */
export class Hud {
  readonly el: HTMLDivElement;
  private bar: HTMLDivElement;
  private chips: HTMLDivElement;
  private clock: HTMLSpanElement;
  private sel: HTMLDivElement;
  private energyFill: HTMLDivElement;
  private energyText: HTMLSpanElement;
  private btn: Record<string, HTMLButtonElement> = {};
  private toasts: HTMLDivElement;
  private banner: HTMLDivElement;
  private nestCard: HTMLDivElement;
  private tip: HTMLDivElement;
  private tipIdx = 0;
  private tipTimer = 0;
  private acc = 0;

  constructor(
    root: HTMLElement,
    private readonly actions: Record<'all' | 'surge' | 'nova' | 'upgrade' | 'clear' | 'pause' | 'mute', () => void>,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-top">
        <div class="strength"></div>
        <div class="chips"></div>
      </div>
      <div class="hud-tr">
        <span class="clock">0:00</span>
        <button class="icon" data-a="mute" title="Mute (M)">♪</button>
        <button class="icon" data-a="pause" title="Pause (Esc)">❚❚</button>
      </div>
      <div class="banner"></div>
      <div class="toasts"></div>
      <div class="nestcard"></div>
      <div class="tip"><span></span><button class="x" title="Hide tips">✕</button></div>
      <div class="hud-bottom">
        <div class="selinfo"></div>
        <div class="energy"><div class="fill"></div><span>Energy</span></div>
        <div class="actions">
          <button data-a="all">All<kbd>A</kbd></button>
          <button data-a="surge" class="power">Surge<kbd>Q</kbd><small>${POWER.surgeCost}</small></button>
          <button data-a="nova" class="power">Nova<kbd>E</kbd><small>${POWER.novaCost}</small></button>
          <button data-a="upgrade" style="display:none">Upgrade<kbd>U</kbd><small class="ucost"></small></button>
          <button data-a="clear" class="touch">✕</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.bar = q('.strength');
    this.chips = q('.chips');
    this.clock = q('.clock');
    this.sel = q('.selinfo');
    this.energyFill = q('.energy .fill');
    this.energyText = q('.energy span');
    this.toasts = q('.toasts');
    this.banner = q('.banner');
    this.nestCard = q('.nestcard');
    this.tip = q('.tip');
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => {
      const a = b.dataset.a as keyof typeof this.actions;
      this.btn[a] = b;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions[a]();
        b.blur();
      });
    });
    let hideTips = false;
    try {
      hideTips = localStorage.getItem('swarm.hideTips') === '1';
    } catch {
      /* storage unavailable */
    }
    if (hideTips) this.tip.style.display = 'none';
    q<HTMLButtonElement>('.tip .x').addEventListener('click', () => {
      this.tip.style.display = 'none';
      try {
        localStorage.setItem('swarm.hideTips', '1');
      } catch {
        /* ignore */
      }
    });
    this.showTip();
  }

  private showTip(): void {
    (this.tip.firstElementChild as HTMLElement).textContent = TIPS[this.tipIdx % TIPS.length];
  }

  setMuted(m: boolean): void {
    this.btn.mute.classList.toggle('off', m);
  }

  toast(msg: string, color = '#cfd6ff'): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.style.setProperty('--c', color);
    t.textContent = msg;
    this.toasts.prepend(t);
    while (this.toasts.children.length > 4) this.toasts.lastElementChild!.remove();
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  update(g: GameView, dt: number): void {
    this.tipTimer += dt;
    if (this.tipTimer > 9) {
      this.tipTimer = 0;
      this.tipIdx++;
      this.showTip();
    }
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;

    const w = g.world;
    this.clock.textContent = formatTime(w.tick);

    // Strength bar + chips.
    const active = w.factions.filter((f) => f.active && f.id !== NEUTRAL);
    const total = active.reduce((s, f) => s + w.unitCount[f.id], 0) || 1;
    const nestsOf = (f: number) => w.nests.filter((n) => n.owner === f).length;
    if (this.bar.children.length !== active.length) {
      this.bar.innerHTML = active.map((f) => `<i style="background:${hex(f.id)}"></i>`).join('');
      this.chips.innerHTML = active
        .map((f) => `<span class="chip${f.id === g.human ? ' me' : ''}" style="--c:${hex(f.id)}"><b></b><em></em></span>`)
        .join('');
    }
    active.forEach((f, k) => {
      const seg = this.bar.children[k] as HTMLElement;
      seg.style.flexGrow = String(w.unitCount[f.id] / total + 0.0001);
      const chip = this.chips.children[k] as HTMLElement;
      chip.classList.toggle('dead', f.eliminated);
      (chip.children[0] as HTMLElement).textContent = String(w.unitCount[f.id]);
      (chip.children[1] as HTMLElement).textContent = `⬡${nestsOf(f.id)}`;
      chip.title = `${FACTION_NAMES[f.id]}${f.id === g.human ? ' (you)' : ''}`;
    });

    // Domination warning.
    let dom = '';
    for (const f of active) {
      const t = w.domTicks[f.team];
      if (t > 0 && !f.eliminated) {
        const left = Math.max(0, DOMINATION.ticks - t);
        const mine = f.team === w.teamOf[g.human];
        dom = `<span style="color:${hex(f.id)}">${mine ? 'You are' : FACTION_NAMES[f.id] + ' is'} dominating</span> — ${formatTime(left)} left`;
        break;
      }
    }
    this.banner.innerHTML = dom;
    this.banner.style.display = dom ? 'block' : 'none';

    // Energy and buttons.
    const me = w.factions[g.human];
    const e = me ? me.energy : 0;
    this.energyFill.style.width = `${e}%`;
    this.energyText.textContent = `Energy ${Math.floor(e)}`;
    const nUnits = g.selection.units.size;
    this.btn.surge.disabled = e < POWER.surgeCost || nUnits === 0;
    this.btn.nova.disabled = e < POWER.novaCost || nUnits < 4;
    this.btn.surge.classList.toggle('ready', e >= POWER.surgeCost);
    this.btn.nova.classList.toggle('ready', e >= POWER.novaCost);
    const up = g.upgradeInfo();
    this.btn.upgrade.style.display = up ? '' : 'none';
    if (up) (this.btn.upgrade.querySelector('.ucost') as HTMLElement).textContent = `${Math.max(0, up.cost)} dots`;
    this.btn.clear.style.visibility = g.selection.empty ? 'hidden' : 'visible';

    const nNests = g.selection.nests.size;
    const parts: string[] = [];
    if (nUnits) parts.push(`<b>${nUnits}</b> dots`);
    if (nNests) parts.push(`<b>${nNests}</b> nest${nNests > 1 ? 's' : ''}`);
    this.sel.innerHTML = parts.length
      ? parts.join(' · ') + `<small>${nUnits ? 'right-click to send' : 'right-click to set rally'}</small>`
      : '<small>Drag to select your dots</small>';

    // Hover card for nests.
    const hn = w.nests[g.hoverNest];
    if (hn) {
      const owner = hn.owner < 0 ? 'Unclaimed' : hn.owner === NEUTRAL ? 'Neutral' : hn.owner === g.human ? 'Yours' : FACTION_NAMES[hn.owner];
      const lvl = hn.level < MAX_LEVEL ? ` · next level ${UPGRADE_COST[hn.level]} dots` : ' · max level';
      this.nestCard.innerHTML = `<b style="color:${hn.owner >= 0 ? hex(hn.owner) : '#8a90a6'}">${NEST_NAMES[hn.type]}</b> Lv${hn.level} — ${owner}<br><small>${NEST_BLURB[hn.type]}${hn.owner === g.human ? lvl : ''}</small>`;
      this.nestCard.style.display = 'block';
    } else {
      this.nestCard.style.display = 'none';
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
