import { FACTION_HEX, FACTION_NAMES } from '../content/factions';
import { DIFFICULTY_NAMES, PERSONALITIES, type Personality } from '../sim/ai/bot';
import { CAVE_LEVELS, EVENT_LEVELS, TERRAIN_LEVELS, type CaveLevel, type EventLevel, type MapSize, type TerrainLevel } from '../sim/mapgen';
import { hashString } from '../sim/rng';
import type { MatchSetup } from '../sim/setup';
import type { World } from '../sim/world';
import { NEUTRAL } from '../sim/constants';
import { formatTime } from './hud';
import type { AudioEngine, VolumeKind } from '../audio/engine';
import { isMobile, setUiMode, UI_MODES, uiMode, type UiMode } from './mobile';

function el(html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLDivElement;
}

const PERSONA_LABEL: Record<Personality | 'random', string> = {
  random: 'Random',
  rusher: 'Rusher',
  turtler: 'Turtler',
  expander: 'Expander',
  opportunist: 'Opportunist',
};

export const CONTROLS_HTML = `
  <dl class="controls">
    <dt>Drag</dt><dd>Box-select dots (and your nests)</dd>
    <dt>Hold Space + move</dt><dd>Paint-select dots under the cursor (great on trackpads)</dd>
    <dt>Click</dt><dd>Select a blob of dots · click a nest's center to select the nest</dd>
    <dt>Double-click / Z</dt><dd>Double-click a unit: all of that type on screen · empty ground or Z: all your dots</dd>
    <dt>1 / 2 / 3 / 4</dt><dd>Keep only Swarmers / Shields / Spears / Raiders from your group (or grab that type on screen). Shift+number drops the type. The type chips do the same; Tab cycles</dd>
    <dt>Right-click</dt><dd>Send dots / set the rally point of selected nests</dd>
    <dt>Q / E</dt><dd>Surge / Nova on the selected dots</dd>
    <dt>R / F / G / T</dt><dd>Nest powers: Fortify, Barrage, Blink, Lockdown (at the cursor). They appear when you hold a Forge, Spire, Den or Bastion</dd>
    <dt>U</dt><dd>Upgrade the selected nest (feeds it nearby dots)</dd>
    <dt>Ctrl+5–9, 5–9</dt><dd>Save / recall control groups</dd>
    <dt>WASD / arrows</dt><dd>Pan · wheel zooms · middle-drag pans · 0 fits the map · C centers on selection · H goes home</dd>
    <dt>Touch</dt><dd>Drag selects, tap sends, two fingers pan and zoom</dd>
  </dl>`;

export const TOUCH_CONTROLS_HTML = `
  <dl class="controls">
    <dt>Drag</dt><dd>Select your dots</dd>
    <dt>Tap</dt><dd>Send the selected dots there · tap a nest to send them onto it</dd>
    <dt>Tap a nest</dt><dd>With nothing selected: select your nest. Then tap the map to set its rally point</dd>
    <dt>Two fingers</dt><dd>Pan and pinch to zoom</dd>
    <dt>✕</dt><dd>Clear the selection</dd>
    <dt>Type chips</dt><dd>Keep only that type from your group</dd>
    <dt>Powers</dt><dd>Surge and Nova fire at once · nest powers: tap the button, then tap the target</dd>
    <dt>Upgrade</dt><dd>Select one of your nests, then tap Upgrade to feed it nearby dots</dd>
  </dl>`;

/** Controls list for the current interface mode. */
export function controlsHtml(): string {
  return isMobile() ? TOUCH_CONTROLS_HTML : CONTROLS_HTML;
}

export function mainMenu(handlers: { skirmish: () => void; howto: () => void; settings: () => void }): HTMLDivElement {
  const m = el(`
    <div class="screen menu">
      <div class="menu-inner">
        <h1 class="logo">${'SWARM'.split('').map((c, i) => `<span style="--c:${FACTION_HEX[i]}">${c}</span>`).join('')}</h1>
        <p class="tag">a tiny war of colors</p>
        <div class="menu-buttons">
          <button class="primary" data-a="skirmish">Skirmish</button>
          <button data-a="campaign" disabled>Campaign <small>soon</small></button>
          <button data-a="howto">How to play</button>
          <button data-a="settings">Settings</button>
        </div>
      </div>
      <footer>v0.1 · fight for the nests</footer>
    </div>`);
  m.querySelector('[data-a=skirmish]')!.addEventListener('click', handlers.skirmish);
  m.querySelector('[data-a=howto]')!.addEventListener('click', handlers.howto);
  m.querySelector('[data-a=settings]')!.addEventListener('click', handlers.settings);
  return m;
}

/** One-time heads-up when mobile mode switched itself on. */
export function mobileNotice(h: { ok: () => void; desktop: () => void }): HTMLDivElement {
  const m = el(`
    <div class="notice">
      <p><b>Looks like you're on a touch device</b>, so mobile mode is on: bigger buttons and touch instructions. You can change this any time in Settings.</p>
      <div class="row"><button class="primary small" data-a="ok">Got it</button><button class="small" data-a="desktop">Use desktop layout</button></div>
    </div>`);
  m.querySelector('[data-a=ok]')!.addEventListener('click', h.ok);
  m.querySelector('[data-a=desktop]')!.addEventListener('click', h.desktop);
  return m;
}

const MODE_LABEL: Record<UiMode, string> = { auto: 'Auto', mobile: 'Mobile', desktop: 'Desktop' };

/** Interface mode + volume controls, shared by the Settings screen and the pause menu. */
function settingsFields(audio: AudioEngine, onMode: () => void): HTMLDivElement {
  const vol = (k: VolumeKind, label: string) =>
    `<label class="vol"><span>${label}</span><input type="range" min="0" max="100" value="${Math.round(audio.volumes[k] * 100)}" data-vol="${k}"></label>`;
  const m = el(`
    <div class="settings">
      <h3>Interface</h3>
      <div class="seg" data-a="mode">${UI_MODES.map((v) => `<button data-v="${v}">${MODE_LABEL[v]}</button>`).join('')}</div>
      <p class="hint">Mobile mode uses bigger touch buttons and touch instructions. Auto picks it on phones and tablets.</p>
      <h3>Sound</h3>
      <div class="vols">
        ${vol('master', 'Master')}${vol('sfx', 'Effects')}${vol('ambience', 'Ambience')}${vol('music', 'Music')}
      </div>
    </div>`);
  const modes = [...m.querySelectorAll<HTMLButtonElement>('[data-a=mode] button')];
  const mark = () => modes.forEach((b) => b.classList.toggle('on', b.dataset.v === uiMode()));
  modes.forEach((b) =>
    b.addEventListener('click', () => {
      setUiMode(b.dataset.v as UiMode);
      mark();
      onMode();
    }),
  );
  mark();
  m.querySelectorAll<HTMLInputElement>('[data-vol]').forEach((inp) =>
    inp.addEventListener('input', () => audio.setVolume(inp.dataset.vol as VolumeKind, Number(inp.value) / 100)),
  );
  return m;
}

export function settingsScreen(audio: AudioEngine, onBack: () => void): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card">
        <h2>Settings</h2>
        <div class="fields"></div>
        <div class="row end"><button class="primary" data-a="back">Done</button></div>
      </div>
    </div>`);
  m.querySelector('.fields')!.replaceWith(settingsFields(audio, () => {}));
  m.querySelector('[data-a=back]')!.addEventListener('click', onBack);
  return m;
}

/** Shorter, touch-first How to play for mobile mode. */
function howToPlayMobile(onBack: () => void): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card wide howto-mobile">
        <h2>How to play</h2>
        <h3>The goal</h3>
        <p>Capture <b>nests</b>: they're the only way to make more dots, and each one raises how big your army can get (shown at the top as army / cap). Win by wiping out every rival, or by holding most of the nests for 30 seconds.</p>
        <h3>Play</h3>
        <ul class="steps">
          <li><b>Drag</b> across your dots to select them.</li>
          <li><b>Tap</b> where they should go. They fight on their own.</li>
          <li><b>Park</b> dots on a nest with no enemies to capture it.</li>
          <li><b>Pinch</b> to zoom, <b>two fingers</b> to pan.</li>
          <li><b>✕</b> clears your selection.</li>
        </ul>
        <h3>Nests</h3>
        <ul class="nests">
          <li><i class="n-hex"></i><b>Hive</b> Swarmers</li>
          <li><i class="n-sq"></i><b>Forge</b> Shields · Fortify</li>
          <li><i class="n-dia"></i><b>Spire</b> Spears · Barrage</li>
          <li><i class="n-tri"></i><b>Den</b> Raiders · Blink</li>
          <li><i class="n-oct"></i><b>Bastion</b> turret · Lockdown</li>
        </ul>
        <p><b>Spears beat Shields, Shields beat Swarmers, Swarmers beat Spears.</b></p>
        <h3>Powers and upgrades</h3>
        <p><b>Surge</b> and <b>Nova</b> fire on your selected dots. Nest powers: tap the button, then tap the target. Tap one of your nests, then <b>Upgrade</b> to feed it dots for faster spawns and a turret.</p>
        <h3>The map</h3>
        <p>Rock blocks paths (cave maps are mostly rock, with tunnels between chambers), purple nebula slows, red rifts burn. Hold a crystal or a supply drop alone for energy. Wild swarms and the Colossus fight everyone.</p>
        <div class="row end"><button class="primary" data-a="back">Got it</button></div>
      </div>
    </div>`);
  m.querySelector('[data-a=back]')!.addEventListener('click', onBack);
  return m;
}

export function howToPlay(onBack: () => void): HTMLDivElement {
  if (isMobile()) return howToPlayMobile(onBack);
  const m = el(`
    <div class="screen modal">
      <div class="card wide">
        <h2>How to play</h2>
        <div class="howto-grid">
          <div>
            <h3>The goal</h3>
            <p>Every color wants the map. <b>Nests</b> are the only way to make more dots, so capture them. Win by wiping out every rival, or by holding <b>70% of the nests for 30 seconds</b> (60% on large maps).</p>
            <h3>Fighting</h3>
            <p>Dots fight automatically. Any dot near an enemy locks on and shoots. The thin lines are the shots. Your job is to decide where your dots go and when they go there.</p>
            <h3>Capturing</h3>
            <p>Park dots on a nest while no enemies are on it, and the ring fills. Neutral nests have gray guards, so clear them out first. A nest that's under attack stops spawning. Your dots take less damage near your own nests, so a comeback is always possible. From minute 5 those comeback bonuses fade out (<b>escalation</b>), so every match reaches an endgame.</p>
            <h3>Supply</h3>
            <p>Your army can only grow so big: <b>20 + 16 per nest you hold</b>, plus a little for each upgrade level. Your count at the top shows army / cap. At the cap your nests stop producing (nothing dies), so to grow, take more nests. Escalation raises the cap late in the match.</p>
          </div>
          <div>
            <h3>Nests</h3>
            <ul class="nests">
              <li><i class="n-hex"></i><b>Hive</b> Swarmers: stronger in packs</li>
              <li><i class="n-sq"></i><b>Forge</b> Shields: draw enemy fire · power <b>Fortify</b></li>
              <li><i class="n-dia"></i><b>Spire</b> Spears: long range, splash · power <b>Barrage</b></li>
              <li><i class="n-tri"></i><b>Den</b> Raiders: capture 3× faster · power <b>Blink</b></li>
              <li><i class="n-oct"></i><b>Bastion</b> turret, shields allies · power <b>Lockdown</b></li>
            </ul>
            <p><b>Spears pierce Shields. Shields stop Swarmers. Swarmers overrun Spears.</b> Mix your army, and take the nests that counter what you're facing. The counter wheel in the corner reminds you when you select dots.</p>
            <p><b>Upgrade</b> a nest by feeding it dots (U). Level 2 spawns faster and adds a turret; level 3 spawns tougher veterans and strengthens the nest's power. Levels survive capture, so upgraded nests are worth taking. Feeding a damaged nest repairs it first.</p>
            <h3>Terrain</h3>
            <ul class="terrain">
              <li><i class="t-wall"></i><b>Rock</b> blocks movement and shots. Gaps make chokepoints. On cave layouts, nests sit in chambers joined by tunnels</li>
              <li><i class="t-neb"></i><b>Nebula</b> slows everything inside: ambush ground</li>
              <li><i class="t-rift"></i><b>Rift</b> burns dots standing in it: a risky shortcut</li>
              <li><i class="t-crys"></i><b>Crystal</b> charges energy for whoever holds it alone</li>
            </ul>
            <h3>Map events</h3>
            <p>A <b>wild swarm</b> (red-gray) hunts the biggest army nearby, so lead it into a rival. <b>Supply drops</b> pay energy and a free nest upgrade to whoever holds them alone (the biggest army only gets the energy). The <b>Colossus</b> wanders across the map: whoever lands the killing blow gets full energy and an upgrade. Neutral nests regrow their guards, and nests nobody holds go wild again.</p>
            <p><b>Energy</b> builds up over time, and faster from kills and captures. <b>Surge</b> (30) makes your selected dots faster, stronger and tougher for 6 seconds. <b>Nova</b> (60) sacrifices some of your dots to blast everything around them.</p>
          </div>
        </div>
        <h3>Controls</h3>
        ${CONTROLS_HTML}
        <div class="row end"><button class="primary" data-a="back">Got it</button></div>
      </div>
    </div>`);
  m.querySelector('[data-a=back]')!.addEventListener('click', onBack);
  return m;
}

interface BotRow {
  faction: number;
  difficulty: number;
  personality: Personality | 'random';
  team: number;
}

export interface SetupPrefs {
  color: number;
  size: MapSize;
  terrain: TerrainLevel;
  caves: CaveLevel;
  events: EventLevel;
  teams: boolean;
  bots: BotRow[];
}

const CAVE_LABEL: Record<CaveLevel, string> = { off: 'Open', belt: 'Cave belt', full: 'Caves' };

const DEFAULT_PREFS: SetupPrefs = {
  color: 0,
  size: 'medium',
  terrain: 'standard',
  caves: 'off',
  events: 'normal',
  teams: false,
  bots: [
    { faction: 1, difficulty: 1, personality: 'random', team: 1 },
    { faction: 2, difficulty: 1, personality: 'random', team: 2 },
    { faction: 3, difficulty: 1, personality: 'random', team: 3 },
  ],
};

export function loadPrefs(): SetupPrefs {
  try {
    const raw = localStorage.getItem('swarm.setup');
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return structuredClone(DEFAULT_PREFS);
}

function savePrefs(p: SetupPrefs): void {
  try {
    localStorage.setItem('swarm.setup', JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function randomSeed(): string {
  const words = ['ember', 'tide', 'nova', 'moss', 'flux', 'drift', 'spark', 'hollow', 'prism', 'vale', 'echo', 'glint', 'rune', 'haze'];
  const r = () => words[Math.floor(Math.random() * words.length)];
  return `${r()}-${r()}-${Math.floor(Math.random() * 100)}`;
}

export function buildSetup(p: SetupPrefs, seedText: string): MatchSetup {
  const seed = hashString(seedText.trim() || 'swarm');
  // Resolve "random" personalities deterministically from the seed.
  let s = seed;
  const nextPers = (): Personality => {
    s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x6b43a9b5) >>> 0;
    return PERSONALITIES[s % PERSONALITIES.length];
  };
  return {
    seed,
    size: p.size,
    terrain: p.terrain,
    caves: p.caves,
    events: p.events,
    portrait: window.innerHeight > window.innerWidth * 1.15,
    players: [
      { faction: p.color, team: 0, human: true },
      ...p.bots.map((b, i) => ({
        faction: b.faction,
        team: p.teams ? b.team : i + 1,
        human: false,
        bot: { difficulty: b.difficulty, personality: b.personality === 'random' ? nextPers() : b.personality },
      })),
    ],
  };
}

export function skirmishSetup(onStart: (setup: MatchSetup) => void, onBack: () => void): HTMLDivElement {
  const prefs = loadPrefs();
  let seedText = randomSeed();

  const m = el(`
    <div class="screen modal">
      <div class="card setup">
        <h2>Skirmish</h2>
        <div class="field">
          <label>Your color</label>
          <div class="swatches"></div>
        </div>
        <div class="field">
          <label>Opponents <small>bots</small></label>
          <div class="bots"></div>
          <div class="row">
            <button class="small" data-a="add">+ Add bot</button>
            <label class="check"><input type="checkbox" data-a="teams"> Teams (you are team A)</label>
          </div>
        </div>
        <div class="field two">
          <div>
            <label>Map size</label>
            <div class="seg" data-a="size">
              <button data-v="small">Small</button><button data-v="medium">Medium</button><button data-v="large">Large</button>
            </div>
          </div>
          <div>
            <label>Terrain</label>
            <div class="seg" data-a="terrain">
              ${TERRAIN_LEVELS.map((t) => `<button data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="field">
          <label>Layout <small>open ground, a ring of caves around the center, or one big cave system</small></label>
          <div class="seg" data-a="caves">
            ${CAVE_LEVELS.map((t) => `<button data-v="${t}">${CAVE_LABEL[t]}</button>`).join('')}
          </div>
        </div>
        <div class="field two">
          <div>
            <label>Events <small>wild swarms, drops, the Colossus</small></label>
            <div class="seg" data-a="events">
              ${EVENT_LEVELS.map((t) => `<button data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
            </div>
          </div>
          <div>
            <label>Map seed</label>
            <div class="row"><input class="seed" spellcheck="false"><button class="small icon" data-a="dice" title="Random seed">⟳</button></div>
          </div>
        </div>
        <div class="row end">
          <button data-a="back">Back</button>
          <button class="primary" data-a="start">Start match</button>
        </div>
      </div>
    </div>`);

  const swatches = m.querySelector('.swatches') as HTMLDivElement;
  const bots = m.querySelector('.bots') as HTMLDivElement;
  const seedInput = m.querySelector('.seed') as HTMLInputElement;
  const teamsBox = m.querySelector('[data-a=teams]') as HTMLInputElement;
  seedInput.value = seedText;
  teamsBox.checked = prefs.teams;

  const used = () => new Set([prefs.color, ...prefs.bots.map((b) => b.faction)]);
  const freeColor = () => [0, 1, 2, 3, 4, 5].find((c) => !used().has(c)) ?? -1;

  const render = () => {
    swatches.innerHTML = FACTION_HEX.slice(0, 6)
      .map((c, i) => `<button class="sw${i === prefs.color ? ' on' : ''}" data-c="${i}" style="--c:${c}" title="${FACTION_NAMES[i]}"></button>`)
      .join('');
    bots.innerHTML = prefs.bots
      .map(
        (b, i) => `
        <div class="bot" data-i="${i}">
          <button class="sw small on" data-a="color" style="--c:${FACTION_HEX[b.faction]}" title="Change color"></button>
          <select data-a="diff">${DIFFICULTY_NAMES.map((d, k) => `<option value="${k}"${k === b.difficulty ? ' selected' : ''}>${d}</option>`).join('')}</select>
          <select data-a="pers">${(['random', ...PERSONALITIES] as const).map((p) => `<option value="${p}"${p === b.personality ? ' selected' : ''}>${PERSONA_LABEL[p]}</option>`).join('')}</select>
          <select data-a="team" ${prefs.teams ? '' : 'hidden'}>${[0, 1, 2, 3, 4, 5].map((t) => `<option value="${t}"${t === b.team ? ' selected' : ''}>Team ${'ABCDEF'[t]}${t === 0 ? ' (ally)' : ''}</option>`).join('')}</select>
          <button class="small icon" data-a="del" title="Remove" ${prefs.bots.length <= 1 ? 'disabled' : ''}>✕</button>
        </div>`,
      )
      .join('');
    (m.querySelector('[data-a=add]') as HTMLButtonElement).disabled = prefs.bots.length >= 5;
    m.querySelectorAll<HTMLButtonElement>('[data-a=size] button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.size));
    m.querySelectorAll<HTMLButtonElement>('[data-a=terrain] button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.terrain));
    m.querySelectorAll<HTMLButtonElement>('[data-a=caves] button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.caves));
    m.querySelectorAll<HTMLButtonElement>('[data-a=events] button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.events));
  };

  swatches.addEventListener('click', (e) => {
    const c = Number((e.target as HTMLElement).dataset.c);
    if (Number.isNaN(c)) return;
    // swap with a bot that had this color
    const other = prefs.bots.find((b) => b.faction === c);
    if (other) other.faction = prefs.color;
    prefs.color = c;
    render();
  });

  bots.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest('.bot') as HTMLElement | null;
    if (!row) return;
    const b = prefs.bots[Number(row.dataset.i)];
    if (t.dataset.a === 'del' && prefs.bots.length > 1) {
      prefs.bots.splice(Number(row.dataset.i), 1);
      render();
    } else if (t.dataset.a === 'color') {
      const u = used();
      for (let k = 1; k <= 6; k++) {
        const c = (b.faction + k) % 6;
        if (!u.has(c)) {
          b.faction = c;
          break;
        }
      }
      render();
    }
  });

  bots.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    const row = t.closest('.bot') as HTMLElement;
    const b = prefs.bots[Number(row.dataset.i)];
    if (t.dataset.a === 'diff') b.difficulty = Number(t.value);
    if (t.dataset.a === 'pers') b.personality = t.value as Personality | 'random';
    if (t.dataset.a === 'team') b.team = Number(t.value);
  });

  m.querySelector('[data-a=add]')!.addEventListener('click', () => {
    const c = freeColor();
    if (c < 0 || prefs.bots.length >= 5) return;
    const last = prefs.bots[prefs.bots.length - 1];
    prefs.bots.push({ faction: c, difficulty: last?.difficulty ?? 1, personality: 'random', team: prefs.bots.length + 1 });
    render();
  });
  teamsBox.addEventListener('change', () => {
    prefs.teams = teamsBox.checked;
    // Default split: alternate bots between your team (A) and team B.
    if (prefs.teams) prefs.bots.forEach((b, i) => (b.team = i % 2 === 0 ? 1 : 0));
    render();
  });
  m.querySelector('[data-a=size]')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.v as MapSize | undefined;
    if (v) {
      prefs.size = v;
      render();
    }
  });
  m.querySelector('[data-a=terrain]')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.v as TerrainLevel | undefined;
    if (v) {
      prefs.terrain = v;
      render();
    }
  });
  m.querySelector('[data-a=caves]')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.v as CaveLevel | undefined;
    if (v) {
      prefs.caves = v;
      render();
    }
  });
  m.querySelector('[data-a=events]')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.v as EventLevel | undefined;
    if (v) {
      prefs.events = v;
      render();
    }
  });
  m.querySelector('[data-a=dice]')!.addEventListener('click', () => {
    seedText = randomSeed();
    seedInput.value = seedText;
  });
  m.querySelector('[data-a=back]')!.addEventListener('click', onBack);
  m.querySelector('[data-a=start]')!.addEventListener('click', () => {
    if (prefs.teams && prefs.bots.every((b) => b.team === 0)) {
      prefs.bots[prefs.bots.length - 1].team = 1;
    }
    savePrefs(prefs);
    onStart(buildSetup(prefs, seedInput.value));
  });

  render();
  return m;
}

export function pauseMenu(h: { resume: () => void; restart: () => void; quit: () => void; audio: AudioEngine }): HTMLDivElement {
  const m = el(`
    <div class="screen modal dim">
      <div class="card">
        <h2>Paused</h2>
        <div class="menu-buttons">
          <button class="primary" data-a="resume">Resume</button>
          <button data-a="restart">Restart match</button>
          <button data-a="quit">Quit to menu</button>
        </div>
        <div class="fields"></div>
        <h3>Controls</h3>
        <div class="ctl"></div>
      </div>
    </div>`);
  const ctl = m.querySelector('.ctl')!;
  const showControls = () => (ctl.innerHTML = controlsHtml());
  m.querySelector('.fields')!.replaceWith(settingsFields(h.audio, showControls));
  showControls();
  m.querySelector('[data-a=resume]')!.addEventListener('click', h.resume);
  m.querySelector('[data-a=restart]')!.addEventListener('click', h.restart);
  m.querySelector('[data-a=quit]')!.addEventListener('click', h.quit);
  return m;
}

export function endScreen(
  w: World,
  human: number,
  victory: boolean,
  h: { rematch: () => void; newMap: () => void; quit: () => void },
): HTMLDivElement {
  const rows = w.factions
    .filter((f) => f.active && f.id !== NEUTRAL)
    .map(
      (f) => `<tr class="${f.id === human ? 'me' : ''}${f.eliminated ? ' dead' : ''}">
        <td><i style="background:${FACTION_HEX[f.id]}"></i>${FACTION_NAMES[f.id]}${f.id === human ? ' (you)' : ''}</td>
        <td>${f.stats.spawned}</td><td>${f.stats.kills}</td><td>${f.stats.lost}</td><td>${f.stats.captured}</td><td>${f.stats.peak}</td>
        <td>${f.eliminated ? formatTime(f.eliminatedTick) : '—'}</td></tr>`,
    )
    .join('');
  const m = el(`
    <div class="screen modal dim">
      <div class="card wide end ${victory ? 'win' : 'lose'}">
        <h1 class="result">${victory ? 'Victory' : 'Defeat'}</h1>
        <p class="sub">${how(w, human)} · match time ${formatTime(w.tick)}</p>
        <canvas class="chart"></canvas>
        <table class="stats">
          <thead><tr><th></th><th>Spawned</th><th>Kills</th><th>Lost</th><th>Captures</th><th>Peak</th><th>Out at</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="row end">
          <button data-a="quit">Menu</button>
          <button data-a="newmap">New map</button>
          <button class="primary" data-a="rematch">Rematch</button>
        </div>
      </div>
    </div>`);
  m.querySelector('[data-a=rematch]')!.addEventListener('click', h.rematch);
  m.querySelector('[data-a=newmap]')!.addEventListener('click', h.newMap);
  m.querySelector('[data-a=quit]')!.addEventListener('click', h.quit);
  requestAnimationFrame(() => drawChart(m.querySelector('.chart') as HTMLCanvasElement, w));
  return m;
}

/** "You won by domination", "Magenta won by elimination", ... */
function how(w: World, human: number): string {
  if (w.winnerTeam < 0 || !w.winReason) return w.factions[human]?.eliminated ? 'You were eliminated' : 'Match over';
  const mine = w.winnerTeam === w.teamOf[human];
  const face = w.factions.find((f) => f.active && f.id !== NEUTRAL && f.team === w.winnerTeam && !f.eliminated) ?? w.factions.find((f) => f.team === w.winnerTeam);
  const who = mine ? (w.factions.filter((f) => f.active && f.team === w.winnerTeam).length > 1 ? 'Your team' : 'You') : face ? FACTION_NAMES[face.id] : 'A rival';
  return `${who} won by <b>${w.winReason}</b>`;
}

/** Army size over time per faction. */
function drawChart(c: HTMLCanvasElement, w: World): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext('2d');
  if (!g) return;
  g.scale(dpr, dpr);
  const series = w.factions.filter((f) => f.active && f.id !== NEUTRAL).map((f) => ({ f: f.id, h: w.history[f.id] }));
  const len = Math.max(2, ...series.map((s) => s.h.length));
  const max = Math.max(10, ...series.flatMap((s) => s.h));
  g.strokeStyle = 'rgba(120,140,200,0.15)';
  g.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    const y = (H * k) / 4;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  for (const s of series) {
    g.strokeStyle = FACTION_HEX[s.f];
    g.lineWidth = 2;
    g.shadowColor = FACTION_HEX[s.f];
    g.shadowBlur = 8;
    g.beginPath();
    s.h.forEach((v, i) => {
      const x = (i / (len - 1)) * W;
      const y = H - (v / max) * (H - 6) - 3;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }
}
