import { FACTION_NAMES } from '../content/factions';
import { hex, type GameView } from '../game/gameView';
import { isMobile } from './mobile';
import { type NestPower, dominationStatus, UNIT_STATS, DOMINATION, MAX_LEVEL, NEST_BLURB, NEST_NAMES, NEUTRAL, POWER, TICK_HZ, UPGRADE_COST } from '../sim/index';

const TIPS = [
  'Drag to select your dots, right-click to send them. Tap on touch.',
  'On a trackpad, hold Space and sweep the cursor to paint-select dots. WASD pans the map.',
  'Pick a type out of a blob with 1–4: 1 Swarmers, 2 Shields, 3 Spears, 4 Raiders. Shift+number drops that type.',
  'Click one of your nests, then right-click somewhere to set its rally point.',
  'Select a nest and press U to feed it dots and level it up.',
  'Surge (Q) makes selected dots faster, stronger and tougher. Nova (E) blasts enemies but costs some of your own dots.',
  'Hold 70% of the nests (60% on large maps) for 30 seconds to win by domination.',
  'Your count at the top is army / supply cap. Every nest you hold raises the cap; at the cap your nests stop producing.',
  'Ctrl+5–9 saves a control group, 5–9 recalls it. C centers the camera on your selection, 0 fits the map.',
  'Each nest type you hold unlocks a power: Forge → Fortify (R), Spire → Barrage (F), Den → Blink (G), Bastion → Lockdown (T).',
  'Spears pierce Shields, Shields stop Swarmers, Swarmers overrun Spears. Raiders capture nests three times faster.',
];

/** Small icons matching the in-game unit shapes. */
/** What each level adds (index = level). */
const LEVEL_PERKS = ['', '', '×1.5 spawns, a turret, faster recovery', '×2 spawns, veteran units (+35% HP), stronger nest power'];

const KIND_ICON = [
  '<svg viewBox="-9 -9 18 18"><rect x="-7" y="-6" width="6" height="6"/><rect x="1" y="-7" width="6" height="6"/><rect x="-3" y="1" width="6" height="6"/></svg>',
  '<svg viewBox="-9 -9 18 18"><rect x="-6" y="-6" width="12" height="12" class="hollow"/></svg>',
  '<svg viewBox="-9 -9 18 18"><polygon points="0,-8 3,0 0,8 -3,0"/></svg>',
  '<svg viewBox="-9 -9 18 18"><polygon points="7,0 -6,-6 -3,0 -6,6"/></svg>',
];

// What beats what, phrased for your own group and for an enemy group.
const OWN_TIPS = [
  'Swarmers overrun Spears · Shields stop them',
  'Shields stop Swarmers · Spears pierce them',
  'Spears pierce Shields · keep away from Swarmers',
  'Raiders steal nests · avoid fights',
];
const ENEMY_TIPS = [
  'Enemy Swarmers: answer with Shields',
  'Enemy Shields: answer with Spears',
  'Enemy Spears: answer with Swarmers',
  'Enemy Raiders: guard your nests',
];

export type HudAction =
  | 'all' | 'surge' | 'nova' | 'upgrade' | 'clear' | 'pause' | 'mute'
  | 'fortify' | 'barrage' | 'blink' | 'lockdown' | 'skip' | 'go';

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
  private dom: HTMLDivElement;
  private nestShare: HTMLDivElement;
  private domMark: HTMLElement;
  private nestCard: HTMLDivElement;
  private tip: HTMLDivElement;
  private aimHint: HTMLDivElement;
  private bottom: HTMLDivElement;
  private top: HTMLDivElement;
  private coach: HTMLDivElement;
  private coachKey = '';
  /** CSS px of the view covered by the top panel and the bottom bar (for the camera) */
  insetTop = 0;
  insetBottom = 0;
  private counters: HTMLDivElement;
  private kindChips: HTMLButtonElement[] = [];
  /** the match this HUD is showing (set every update) */
  private game: GameView | null = null;
  private counterCap: HTMLDivElement;
  private tipIdx = 0;
  private tipTimer = 0;
  private acc = 0;

  constructor(
    root: HTMLElement,
    private readonly actions: Record<HudAction, () => void>,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-top">
        <div class="strength" title="Army size"></div>
        <div class="nestshare" title="Nests held. Hold past the marker for 30s to win by domination"><div class="segs"></div><span class="mark"></span></div>
        <div class="chips"></div>
      </div>
      <div class="hud-tr">
        <span class="clock">0:00</span>
        <button class="icon" data-a="mute" title="Mute (M)">♪</button>
        <button class="icon" data-a="pause" title="Pause (Esc)">❚❚</button>
      </div>
      <div class="dom"><div class="dom-time"></div><div class="dom-text"></div><div class="dom-bar"><i></i></div></div>
      <div class="toasts"></div>
      <div class="nestcard"></div>
      <div class="aimhint"><span></span><button class="cancel">Cancel</button></div>
      <div class="tip"><span></span><button class="x" title="Hide tips">✕</button></div>
      <div class="coach"><small></small><p></p><div class="coach-status"></div><div class="coach-hold"><span>Paused to read</span><i><b></b></i><button class="small primary" data-a="go">Go</button></div><div class="coach-row"><span class="pips"></span><button class="small" data-a="skip">Skip mission</button></div></div>
      <div class="counters" title="Spears pierce Shields · Shields stop Swarmers · Swarmers overrun Spears">
        <svg viewBox="0 0 120 92" aria-hidden="true">
          <defs>
            <marker id="ah" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="context-stroke"></path>
            </marker>
          </defs>
          <path class="arrow" data-from="2" data-to="1" d="M68,20 Q98,30 96,56" marker-end="url(#ah)"></path>
          <path class="arrow" data-from="1" data-to="0" d="M84,76 Q60,90 36,76" marker-end="url(#ah)"></path>
          <path class="arrow" data-from="0" data-to="2" d="M22,58 Q20,30 50,20" marker-end="url(#ah)"></path>
          <g class="node" data-k="2" transform="translate(60,14)"><polygon points="0,-11 4,0 0,11 -4,0"></polygon><text x="9" y="4">3</text></g>
          <g class="node" data-k="1" transform="translate(98,70)"><rect x="-8" y="-8" width="16" height="16" class="hollow"></rect><text x="-3" y="20">2</text></g>
          <g class="node" data-k="0" transform="translate(22,70)"><rect x="-9" y="-7" width="7" height="7"></rect><rect x="1" y="-8" width="7" height="7"></rect><rect x="-4" y="1" width="7" height="7"></rect><text x="-3" y="20">1</text></g>
          <g class="node raider" data-k="3" transform="translate(60,52)"><polygon points="7,0 -6,-6 -3,0 -6,6"></polygon><text x="10" y="4">4</text></g>
        </svg>
        <div class="counter-cap"></div>
      </div>
      <div class="hud-bottom">
        <div class="selinfo"></div>
        <div class="selchips">${[0, 1, 2, 3]
          .map((k) => `<button class="kchip" data-k="${k}" title="${k + 1} or click: keep only ${UNIT_STATS[k].name}s · Shift+${k + 1} or Shift-click: drop them">${KIND_ICON[k]}<b></b><kbd>${k + 1}</kbd></button>`)
          .join('')}</div>
        <div class="energy"><div class="fill"></div><span>Energy</span></div>
        <div class="actions">
          <button data-a="all">All<kbd>Z</kbd></button>
          <button data-a="surge" class="power">Surge<kbd>Q</kbd><small>${POWER.surgeCost}</small></button>
          <button data-a="nova" class="power">Nova<kbd>E</kbd><small>${POWER.novaCost}</small></button>
          <button data-a="fortify" class="power nest" title="Selected dots take half damage but move slower. From a Forge.">Fortify<kbd>R</kbd><small>${POWER.fortifyCost}</small></button>
          <button data-a="barrage" class="power nest" title="Artillery strike at the cursor after a short warning. From a Spire.">Barrage<kbd>F</kbd><small>${POWER.barrageCost}</small></button>
          <button data-a="blink" class="power nest" title="Teleport the selected dots toward the cursor. From a Den.">Blink<kbd>G</kbd><small>${POWER.blinkCost}</small></button>
          <button data-a="lockdown" class="power nest" title="Stop an enemy nest spawning for a while. From a Bastion.">Lockdown<kbd>T</kbd><small>${POWER.lockdownCost}</small></button>
          <button data-a="upgrade" style="display:none"><span class="ulabel">Upgrade</span><kbd>U</kbd><small class="ucost"></small></button>
          <button data-a="clear" class="touch">✕</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.counters = q('.counters');
    this.kindChips = [...this.el.querySelectorAll<HTMLButtonElement>('.kchip')];
    for (const b of this.kindChips) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.game?.filterSelection(Number(b.dataset.k), e.shiftKey);
        b.blur();
      });
    }
    // Wheel icons work like chips: narrow the selection, or grab that type on screen.
    this.counters.querySelectorAll<SVGGElement>('.node').forEach((n) => {
      n.addEventListener('click', (e) => {
        e.stopPropagation();
        const g = this.game;
        if (!g) return;
        const k = Number(n.dataset.k);
        if (g.selectionMix()[k] > 0) g.filterSelection(k, e.shiftKey);
        else g.selectKindOnScreen(k);
      });
    });
    this.counterCap = q('.counter-cap');
    this.bar = q('.strength');
    this.chips = q('.chips');
    this.clock = q('.clock');
    this.sel = q('.selinfo');
    this.energyFill = q('.energy .fill');
    this.energyText = q('.energy span');
    this.toasts = q('.toasts');
    this.dom = q('.dom');
    this.nestShare = q('.nestshare .segs');
    this.domMark = q('.nestshare .mark');
    this.nestCard = q('.nestcard');
    this.tip = q('.tip');
    this.aimHint = q('.aimhint');
    this.bottom = q('.hud-bottom');
    this.top = q('.hud-top');
    this.coach = q('.coach');
    this.measure();
    q<HTMLButtonElement>('.aimhint .cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.game) this.game.aim = null;
    });
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

  /** How much of the screen the top panel and bottom bar cover. */
  measure(): void {
    const h = this.el.clientHeight || window.innerHeight;
    const topBottom = Math.max(0, this.top.getBoundingClientRect().bottom);
    this.coach.style.top = `${Math.round(topBottom + 8)}px`;
    const coach = this.coach.getBoundingClientRect();
    this.insetTop = coach.height > 0 ? Math.max(topBottom, coach.bottom) : topBottom;
    // Toasts drop below the tutorial coach while it's up.
    this.toasts.style.top = coach.height > 0 ? `${Math.round(coach.bottom + 8)}px` : '';
    const b = this.bottom.getBoundingClientRect();
    this.insetBottom = b.height > 0 ? Math.max(0, h - b.top) : 0;
  }

  /** Tutorial coach: the current step's instruction and progress (#17). */
  private updateCoach(g: GameView, mobile: boolean): void {
    const m = g.mission;
    // The live status line changes on its own; everything else only when the step does.
    const status = m?.current?.status?.({ w: g.world, human: g.human, log: g.session.log }) ?? '';
    const hold = this.coach.querySelector('.coach-hold') as HTMLElement;
    hold.style.display = g.readLeft > 0 ? '' : 'none';
    (hold.querySelector('b') as HTMLElement).style.width = `${Math.round(g.readLeft * 100)}%`;
    const st = this.coach.querySelector('.coach-status') as HTMLElement;
    if (st.innerHTML !== status) st.innerHTML = status;
    st.style.display = status ? '' : 'none';
    const key = m ? `${m.index}:${m.step}:${mobile}` : '';
    if (key === this.coachKey) return;
    this.coachKey = key;
    this.coach.classList.toggle('on', !!m);
    if (!m) {
      this.el.querySelectorAll('.coach-pulse').forEach((e) => e.classList.remove('coach-pulse'));
      return;
    }
    this.tip.style.display = 'none';
    const step = m.current;
    (this.coach.querySelector('small') as HTMLElement).textContent = `Mission ${m.index + 1} of 5 · ${m.mission.title}`;
    (this.coach.querySelector('p') as HTMLElement).innerHTML = step ? (mobile ? step.text.mobile : step.text.desktop) : 'Mission complete!';
    (this.coach.querySelector('.pips') as HTMLElement).innerHTML = m.mission.steps.map((_, i) => `<i class="${i < m.step ? 'done' : i === m.step ? 'now' : ''}"></i>`).join('');
    this.el.querySelectorAll('.coach-pulse').forEach((e) => e.classList.remove('coach-pulse'));
    if (step?.pulse) this.el.querySelector(step.pulse)?.classList.add('coach-pulse');
    this.coach.classList.remove('pop');
    void this.coach.offsetWidth;
    this.coach.classList.add('pop');
  }

  update(g: GameView, dt: number): void {
    this.game = g;
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
    const mobile = isMobile();
    this.clock.textContent = formatTime(w.tick);
    // Floating panels sit above the bottom bar, whose height depends on what's in it.
    this.el.style.setProperty('--hudb', `${this.bottom.offsetHeight}px`);
    this.updateCoach(g, mobile);
    this.measure();
    this.aimHint.classList.toggle('on', !!g.aim);
    if (g.aim) (this.aimHint.firstElementChild as HTMLElement).textContent = `Tap where to cast ${g.aim[0].toUpperCase()}${g.aim.slice(1)}`;

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
      if (f.id === g.human) {
        // Your own chip shows supply: army / cap, red while production is blocked.
        const sp = g.supply();
        (chip.children[0] as HTMLElement).textContent = `${sp.units}/${sp.cap}`;
        chip.classList.toggle('blocked', sp.blocked);
      } else (chip.children[0] as HTMLElement).textContent = String(w.unitCount[f.id]);
      (chip.children[1] as HTMLElement).textContent = `⬡${nestsOf(f.id)}`;
      chip.title =
        f.id === g.human
          ? `${FACTION_NAMES[f.id]} (you). Army / supply cap: nests stop producing at the cap. Take or upgrade nests to raise it.`
          : FACTION_NAMES[f.id];
    });

    // Nest share: one segment per faction, unheld nests left empty.
    if (this.nestShare.children.length !== active.length) {
      this.nestShare.innerHTML = active.map((f) => `<i style="background:${hex(f.id)}"></i>`).join('');
    }
    this.domMark.style.left = `${w.domShare * 100}%`;
    active.forEach((f, k) => {
      (this.nestShare.children[k] as HTMLElement).style.width = `${(100 * nestsOf(f.id)) / Math.max(1, w.nests.length)}%`;
    });

    // Domination: a big countdown nobody can miss, with what to do about it.
    const ds = dominationStatus(w);
    this.dom.style.display = ds ? 'block' : 'none';
    if (ds) {
      const mine = ds.team === w.teamOf[g.human];
      const secs = Math.ceil(ds.left / TICK_HZ);
      const col = hex(ds.face);
      this.dom.style.setProperty('--c', col);
      this.dom.classList.toggle('urgent', secs <= 10);
      this.dom.classList.toggle('mine', mine);
      (this.dom.children[0] as HTMLElement).textContent = `0:${String(secs).padStart(2, '0')}`;
      (this.dom.children[1] as HTMLElement).innerHTML = mine
        ? `<b>You are dominating</b> · hold ${ds.need} of ${w.nests.length} nests`
        : `<b>${FACTION_NAMES[ds.face]} is dominating</b> · take back ${ds.toBreak} nest${ds.toBreak > 1 ? 's' : ''} to stop it`;
      ((this.dom.children[2] as HTMLElement).children[0] as HTMLElement).style.width = `${(100 * ds.left) / DOMINATION.ticks}%`;
    }

    // Energy and buttons.
    const me = w.factions[g.human];
    const e = me ? me.energy : 0;
    this.energyFill.style.width = `${e}%`;
    let crystals = 0;
    for (const c of w.crystals) if (c.holder === g.human) crystals++;
    this.energyText.textContent = `Energy ${Math.floor(e)}${crystals ? `  ◆ crystal${crystals > 1 ? ` ×${crystals}` : ''}` : ''}`;
    const nUnits = g.selection.units.size;
    this.btn.surge.disabled = e < POWER.surgeCost || nUnits === 0;
    this.btn.nova.disabled = e < POWER.novaCost || nUnits < 4;
    this.btn.surge.classList.toggle('ready', e >= POWER.surgeCost);
    // Nest powers only show while you hold the matching nest type.
    const nestPowers: [NestPower, number, boolean][] = [
      ['fortify', POWER.fortifyCost, nUnits > 0],
      ['barrage', POWER.barrageCost, true],
      ['blink', POWER.blinkCost, nUnits > 0],
      ['lockdown', POWER.lockdownCost, true],
    ];
    for (const [p, cost, ok] of nestPowers) {
      const b = this.btn[p];
      const owned = g.canUse(p) && !g.locked.has(p);
      b.style.display = owned ? '' : 'none';
      b.disabled = e < cost || !ok;
      b.classList.toggle('ready', e >= cost);
      b.classList.toggle('aiming', g.aim === p);
    }
    this.btn.nova.classList.toggle('ready', e >= POWER.novaCost);
    const up = g.upgradeInfo();
    this.btn.upgrade.style.display = up && !g.locked.has('upgrade') ? '' : 'none';
    this.btn.surge.style.display = g.locked.has('surge') ? 'none' : '';
    this.btn.nova.style.display = g.locked.has('nova') ? 'none' : '';
    if (up) {
      (this.btn.upgrade.querySelector('.ucost') as HTMLElement).textContent = `${Math.max(0, up.cost)} dots`;
      (this.btn.upgrade.querySelector('.ulabel') as HTMLElement).textContent = up.repair ? 'Repair' : 'Upgrade';
    }
    // Mobile keeps ✕ in its grid slot (disabled) so the buttons don't shuffle.
    this.btn.clear.style.visibility = mobile || !g.selection.empty ? 'visible' : 'hidden';
    this.btn.clear.disabled = g.selection.empty;

    const nNests = g.selection.nests.size;
    const parts: string[] = [];
    if (nUnits) parts.push(`<b>${nUnits}</b> dots`);
    if (nNests) parts.push(`<b>${nNests}</b> nest${nNests > 1 ? 's' : ''}`);
    this.sel.innerHTML = parts.length
      ? parts.join(' · ') + `<small>${nUnits ? 'right-click to send' : 'right-click to set rally'}</small>`
      : '<small>Drag to select your dots</small>';

    this.updateCounters(g);

    // Type chips for the current selection.
    const mix = g.selectionMix();
    const kinds = mix.filter((c) => c > 0).length;
    this.kindChips.forEach((b, k) => {
      b.style.display = mix[k] > 0 ? '' : 'none';
      b.classList.toggle('solo', kinds === 1);
      b.querySelector('b')!.textContent = String(mix[k]);
    });

    // Hover card for nests. Touch has no hover, so mobile shows a compact card
    // for the selected nest, only while no dots are selected with it.
    let hn = w.nests[g.hoverNest];
    if (!hn && mobile && nUnits === 0) for (const id of g.selection.nests) hn = hn ?? w.nests[id];
    if (hn && mobile) {
      const next = hn.owner === g.human && hn.level < MAX_LEVEL ? `<br><small>Upgrade: ${UPGRADE_COST[hn.level]} dots → ${LEVEL_PERKS[hn.level + 1]}</small>` : '';
      this.nestCard.innerHTML = `<b style="color:${hn.owner >= 0 ? hex(hn.owner) : '#8a90a6'}">${hn.capital ? 'Capital ' : ''}${NEST_NAMES[hn.type]}</b> Lv${hn.level}/${MAX_LEVEL}${next}`;
      this.nestCard.style.display = 'block';
    } else if (hn) {
      const owner = hn.owner < 0 ? 'Unclaimed' : hn.owner === NEUTRAL ? 'Neutral' : hn.owner === g.human ? 'Yours' : FACTION_NAMES[hn.owner];
      const next = hn.level < MAX_LEVEL ? `<br>Next: <b>Lv${hn.level + 1}</b> for ${UPGRADE_COST[hn.level]} dots (U): ${LEVEL_PERKS[hn.level + 1]}` : '';
      const has = hn.level > 1 ? `<br>Lv${hn.level}: ${LEVEL_PERKS.slice(2, hn.level + 1).join('; ')}` : '';
      this.nestCard.innerHTML = `<b style="color:${hn.owner >= 0 ? hex(hn.owner) : '#8a90a6'}">${hn.capital ? 'Capital ' : ''}${NEST_NAMES[hn.type]}</b> Lv${hn.level}/${MAX_LEVEL} — ${owner}<br><small>${NEST_BLURB[hn.type]}${hn.capital ? ' Has a built-in turret and armors its defenders.' : ''}${has}${hn.owner === g.human ? next : ''}</small>`;
      this.nestCard.style.display = 'block';
    } else {
      this.nestCard.style.display = 'none';
    }
  }

  /** Light up the counter wheel for the selection or a hovered enemy group. */
  private updateCounters(g: GameView): void {
    const mix = g.focusMix(18 / Math.max(0.01, g.zoomForPick));
    const total = mix ? mix.counts.reduce((a, b) => a + b, 0) : 0;
    const on = new Set<number>();
    if (mix && total > 0) mix.counts.forEach((c, k) => c / total >= 0.2 && on.add(k));
    this.counters.classList.toggle('active', on.size > 0);
    this.counters.classList.toggle('enemy', !!mix?.enemy);
    this.counters.querySelectorAll<SVGGElement>('.node').forEach((n) => n.classList.toggle('on', on.has(Number(n.dataset.k))));
    this.counters.querySelectorAll<SVGPathElement>('.arrow').forEach((a) => {
      const from = Number(a.dataset.from), to = Number(a.dataset.to);
      a.classList.toggle('good', on.has(from));
      a.classList.toggle('bad', on.has(to) && !on.has(from));
    });
    if (!mix || on.size === 0) {
      this.counterCap.textContent = 'Spear › Shield › Swarm';
      return;
    }
    // Caption for the dominant kind.
    let k = 0;
    mix.counts.forEach((c, i) => c > mix.counts[k] && (k = i));
    this.counterCap.textContent = (mix.enemy ? ENEMY_TIPS : OWN_TIPS)[k];
  }

  destroy(): void {
    this.el.remove();
  }
}
