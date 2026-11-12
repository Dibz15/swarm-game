import { FACTION_HEX, FACTION_NAMES } from '../content/factions';
import { DIFFICULTY_NAMES, PERSONALITIES, type Personality } from '../sim/ai/bot';
import { CAVE_LEVELS, EVENT_LEVELS, MAP_LAYOUTS, TERRAIN_LEVELS, type CaveLevel, type EventLevel, type MapLayout, type MapSize, type TerrainLevel } from '../sim/mapgen';
import type { MatchSetup } from '../sim/setup';
import type { World } from '../sim/world';
import { NEUTRAL } from '../sim/constants';
import { formatTime } from './hud';
import type { AudioEngine, VolumeKind } from '../audio/engine';
import { THEMES } from '../audio/themes';
import { clearRecordings, countRecordings, downloadRecordings, recordingEnabled, setRecordingEnabled } from '../game/recordStore';
import { buildSetup, loadPrefs, MATCH_MODES, MATCH_MODE_BLURB, MATCH_MODE_LABEL, prefsProblem, randomMap, randomSeed, savePrefs, settleTeams, WAVE_NAMES, type MatchMode, type SetupPrefs } from '../game/matchSetup';
import { relayOnly, setRelayOnly, TURN_URL } from '../net/ice';
import { MISSIONS, missionUnlocked, type Mission, type NextStep, type TutorialProgress } from '../game/tutorial';
import { isMobile, setUiMode, UI_MODES, uiMode, type UiMode } from './mobile';
import { RESOLUTIONS, resolution, setResolution, type Resolution } from '../render/resolution';
import { AUDIO_QUALITIES, type AudioQuality } from '../audio/quality';
import { el } from './dom';


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
    <dt>R / F / G / T</dt><dd>Nest powers: Fortify, Barrage, Blink, Lockdown, at the cursor; G aims Blink first, showing its reach (click, or G again). They appear when you hold a Forge, Spire, Den or Bastion</dd>
    <dt>U</dt><dd>Upgrade the selected nest (feeds it nearby dots)</dd>
    <dt>N</dt><dd>Send the selected dots to your nearest nest (double-tap to look there)</dd>
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
    <dt>⌂</dt><dd>Send the selected dots to your nearest nest</dd>
    <dt>✕</dt><dd>Clear the selection</dd>
    <dt>Type chips</dt><dd>Keep only that type from your group</dd>
    <dt>Powers</dt><dd>Surge and Nova fire at once · nest powers: tap the button, then tap the target</dd>
    <dt>Upgrade</dt><dd>Select one of your nests, then tap Upgrade to feed it nearby dots</dd>
  </dl>`;

/** Controls list for the current interface mode. */
export function controlsHtml(): string {
  return isMobile() ? TOUCH_CONTROLS_HTML : CONTROLS_HTML;
}

export function mainMenu(handlers: { skirmish: () => void; multiplayer: () => void; campaign: () => void; howto: () => void; settings: () => void }): HTMLDivElement {
  const m = el(`
    <div class="screen menu">
      <button class="menu-corner" data-a="howto" title="How to play"><span aria-hidden="true">?</span> How to play</button>
      <div class="menu-inner">
        <h1 class="logo">${'SWARM'.split('').map((c, i) => `<span style="--c:${FACTION_HEX[i]}">${c}</span>`).join('')}</h1>
        <p class="tag">a tiny war of colors</p>
        <div class="menu-buttons">
          <button class="primary" data-a="skirmish">Skirmish</button>
          <button data-a="multiplayer">Multiplayer</button>
          <button data-a="campaign">Campaign</button>
          <button data-a="settings">Settings</button>
        </div>
      </div>
      <footer>v0.1 · fight for the nests</footer>
    </div>`);
  m.querySelector('[data-a=skirmish]')!.addEventListener('click', handlers.skirmish);
  m.querySelector('[data-a=multiplayer]')!.addEventListener('click', handlers.multiplayer);
  m.querySelector('[data-a=campaign]')!.addEventListener('click', handlers.campaign);
  m.querySelector('[data-a=howto]')!.addEventListener('click', handlers.howto);
  m.querySelector('[data-a=settings]')!.addEventListener('click', handlers.settings);
  return m;
}

// ---- tutorial (#17) --------------------------------------------------------

/** A card on the main menu: tutorial offer, continue, or the suggested next step. */
export function menuCard(text: string, buttons: { label: string; primary?: boolean; on: () => void }[]): HTMLDivElement {
  const m = el(`<div class="notice"><p>${text}</p><div class="row"></div></div>`);
  const row = m.querySelector('.row')!;
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `small${b.primary ? ' primary' : ''}`;
    btn.textContent = b.label;
    btn.addEventListener('click', b.on);
    row.appendChild(btn);
  }
  return m;
}

/** What the menu suggests after the tutorial's graduation match. */
export const NEXT_STEP_TEXT: Record<NextStep, string> = {
  graduate: '<b>Next step:</b> your first real match. A 1v1 against a Normal bot on a small map.',
  ffa: '<b>Next step:</b> you beat a Normal bot. Try a 4-player free-for-all, where rivals fight each other too.',
  rematch: '<b>Next step:</b> take on the Normal bot again, or warm up against Easy first.',
};

export { buildSetup, loadPrefs, quickSetup, randomSeed, type SetupPrefs } from '../game/matchSetup';

// ---- skirmish sub-menu (#43) --------------------------------------------------

const QUICK_KEY = 'swarm.quickDifficulty';

function quickDifficulty(): number {
  try {
    const v = Number(localStorage.getItem(QUICK_KEY));
    return Number.isInteger(v) && v >= 0 && v < DIFFICULTY_NAMES.length && localStorage.getItem(QUICK_KEY) !== null ? v : 1;
  } catch {
    return 1;
  }
}

/** Pick from weighted options with Math.random (menus only; the match itself is seeded). */
function weighted<T>(opts: [T, number][]): T {
  let r = Math.random() * opts.reduce((s, o) => s + o[1], 0);
  for (const [v, wt] of opts) if ((r -= wt) < 0) return v;
  return opts[opts.length - 1][0];
}

/** A random match: only the difficulty is chosen, for every bot. */
export function randomSetup(difficulty: number): MatchSetup {
  const p = loadPrefs();
  const bots = weighted<number>([[1, 3], [2, 2], [3, 4], [4, 2], [5, 2]]);
  const others = [0, 1, 2, 3, 4, 5].filter((c) => c !== p.color);
  return buildSetup(
    {
      ...p,
      ...randomMap(bots + 1),
      teams: false,
      mode: 'conquest',
      bots: others.slice(0, bots).map((faction, i) => ({ faction, difficulty, personality: 'random', team: i + 1 })),
    },
    randomSeed(),
  );
}

export function skirmishMenu(h: { quick: (difficulty: number) => void; custom: () => void; back: () => void }): HTMLDivElement {
  let difficulty = quickDifficulty();
  const m = el(`
    <div class="screen modal">
      <div class="card campaign">
        <h2>Skirmish</h2>
        <div class="menu-buttons">
          <div class="quick">
            <b>Quick match</b>
            <span>Random map and opponents</span>
            <label>Bot difficulty</label>
            <div class="seg" data-a="diff">${DIFFICULTY_NAMES.map((d, k) => `<button data-v="${k}">${d}</button>`).join('')}</div>
            <button class="primary" data-a="quick">Play quick match</button>
          </div>
          <button data-a="custom"><b>Custom skirmish</b><span>choose map, opponents and teams</span></button>
        </div>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  const segs = [...m.querySelectorAll<HTMLButtonElement>('[data-a=diff] button')];
  const mark = () => segs.forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === difficulty));
  segs.forEach((b) =>
    b.addEventListener('click', () => {
      difficulty = Number(b.dataset.v);
      try {
        localStorage.setItem(QUICK_KEY, String(difficulty));
      } catch {
        /* ignore */
      }
      mark();
    }),
  );
  mark();
  m.querySelector('[data-a=quick]')!.addEventListener('click', () => h.quick(difficulty));
  m.querySelector('[data-a=custom]')!.addEventListener('click', h.custom);
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

/** Single-player modes beyond skirmish, so the main menu stays short as they grow. */
export function campaignMenu(p: TutorialProgress, active: number, h: { tutorial: () => void; run: () => void; back: () => void }): HTMLDivElement {
  const done = MISSIONS.filter((ms) => p.done.includes(ms.id)).length;
  const m = el(`
    <div class="screen modal">
      <div class="card campaign">
        <h2>Campaign</h2>
        <div class="menu-buttons">
          <button class="primary" data-a="tutorial"><b>Tutorial</b><span>${done === MISSIONS.length ? 'Complete ✓ · replay any mission' : `${done} of ${MISSIONS.length} missions · about 10 minutes`}</span></button>
          <button data-a="run"><b>Procedural campaign</b><span>${active ? `${active} run${active > 1 ? 's' : ''} in progress` : 'Cross the map before the Bloom takes it · preview'}</span></button>
        </div>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  m.querySelector('[data-a=tutorial]')!.addEventListener('click', h.tutorial);
  m.querySelector('[data-a=run]')!.addEventListener('click', h.run);
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

export function tutorialMenu(p: TutorialProgress, h: { play: (i: number) => void; back: () => void }): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card tutorial">
        <h2>Tutorial <small>about 10 minutes</small></h2>
        <ol class="missions">${MISSIONS.map(
          (ms, i) => {
            // Cards you can tap (#115): done ones replay, the next one plays, later ones wait.
            const done = p.done.includes(ms.id);
            const open = missionUnlocked(p, i);
            const tag = !open ? `🔒 Finish mission ${i} first` : done ? 'Replay ↻' : 'Play ▶';
            return `<li class="${done ? 'done' : ''}${open ? '' : ' locked'}"><button data-i="${i}" ${open ? '' : 'disabled'}><span class="num">${done ? '✓' : i + 1}</span><b>${ms.title}</b><span class="what">${ms.teaches}</span><span class="play">${tag}</span></button></li>`;
          },
        ).join('')}</ol>
        <p class="hint">The last mission is a real 1v1 against a Normal bot.</p>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  m.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) => b.addEventListener('click', () => h.play(Number(b.dataset.i))));
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

export function missionBriefing(ms: Mission, i: number, h: { start: () => void; back: () => void }): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card brief">
        <small class="eyebrow">Mission ${i + 1} of ${MISSIONS.length}</small>
        <h2>${ms.title}</h2>
        <p>${ms.teaches}</p>
        <p class="hint">Follow the instructions at the top of the screen. ${isMobile() ? 'Pause' : 'Esc pauses'} any time.</p>
        <div class="row end"><button data-a="back">Back</button><button class="primary" data-a="start">Start</button></div>
      </div>
    </div>`);
  m.querySelector('[data-a=start]')!.addEventListener('click', h.start);
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

/** After a mission: what was learned, then onward (or, after the graduation 1v1, back to the menu). */
export function missionDebrief(
  ms: Mission,
  i: number,
  won: boolean,
  h: { next: () => void; retry: () => void; menu: () => void; easy?: () => void },
): HTMLDivElement {
  const last = i === MISSIONS.length - 1;
  // The graduation 1v1 (#147): no skipping it, but a warm-up against Easy when it's lost.
  const real = !!ms.real;
  const body = won
    ? `<ul class="steps">${ms.learned.map((l) => `<li>${l}</li>`).join('')}</ul>${real ? '<p><b>Tutorial complete!</b> You’re ready for anything: try a free-for-all next.</p>' : ''}`
    : real
      ? '<p>The Normal bot won this time. Try again on a new map, or warm up against an Easy bot first.</p>'
      : '<p>Your nests and dots are gone. Try again: grow first, and bring more dots than the enemy.</p>';
  // The primary way on: the next mission, the menu after graduating, a warm-up (only if the
  // caller offers one) after losing the real match, else skipping this one.
  const warmUp = real && !won ? h.easy : undefined;
  const go = won ? (real ? { label: 'Main menu', on: h.menu } : { label: 'Next mission', on: h.next }) : warmUp ? { label: 'Warm up vs Easy', on: warmUp } : real ? null : { label: 'Skip mission', on: h.next };
  const m = el(`
    <div class="screen modal dim">
      <div class="card brief ${won ? 'win' : 'lose'}">
        <small class="eyebrow">Mission ${i + 1} of ${MISSIONS.length}</small>
        <h2>${won ? (real ? 'Graduated' : 'Mission complete') : 'Defeated'}</h2>
        ${body}
        ${!last ? `<p class="hint">Next: ${MISSIONS[i + 1].title}. ${MISSIONS[i + 1].teaches}</p>` : ''}
        <div class="row end">
          ${won && real ? '' : '<button data-a="menu">Main menu</button>'}
          ${won ? '' : `<button data-a="retry"${real ? ' class="primary"' : ''}>Retry</button>`}
          ${go ? `<button${real && !won ? '' : ' class="primary"'} data-a="next">${go.label}</button>` : ''}
        </div>
      </div>
    </div>`);
  if (go) m.querySelector('[data-a=next]')!.addEventListener('click', go.on);
  m.querySelector('[data-a=menu]')?.addEventListener('click', h.menu);
  m.querySelector('[data-a=retry]')?.addEventListener('click', h.retry);
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
const RES_LABEL: Record<Resolution, string> = { sharp: 'Sharp', balanced: 'Balanced', fast: 'Fast' };
const AQ_LABEL: Record<AudioQuality, string> = { auto: 'Auto', high: 'High', low: 'Low' };

/** Interface mode + volume controls, shared by the Settings screen and the pause menu. */
function settingsFields(audio: AudioEngine, onMode: () => void): HTMLDivElement {
  const vol = (k: VolumeKind, label: string) =>
    `<label class="vol"><span>${label}</span><input type="range" min="0" max="100" value="${Math.round(audio.volumes[k] * 100)}" data-vol="${k}"></label>`;
  const m = el(`
    <div class="settings">
      <h3>Interface</h3>
      <div class="seg" data-a="mode">${UI_MODES.map((v) => `<button data-v="${v}">${MODE_LABEL[v]}</button>`).join('')}</div>
      <p class="hint">Mobile mode uses bigger touch buttons and touch instructions. Auto picks it on phones and tablets.</p>
      <h3>Resolution</h3>
      <div class="seg" data-a="res">${RESOLUTIONS.map((v) => `<button data-v="${v}">${RES_LABEL[v]}</button>`).join('')}</div>
      <p class="hint">On a high-resolution screen, Balanced and Fast draw battles and the campaign map with fewer pixels. Try them if either stutters.</p>
      <h3>Sound</h3>
      <div class="vols">
        ${vol('master', 'Master')}${vol('sfx', 'Effects')}${vol('ambience', 'Ambience')}${vol('music', 'Music')}
      </div>
      <label class="vol"><span>Theme</span><select data-a="theme">
        <option value="auto">Varied (one per match)</option>
        ${THEMES.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}
      </select></label>
      <h3>Audio quality</h3>
      <div class="seg" data-a="aq">${AUDIO_QUALITIES.map((v) => `<button data-v="${v}">${AQ_LABEL[v]}</button>`).join('')}</div>
      <p class="hint">Low uses a lighter reverb and fewer sounds at once. Try it if the sound crackles or stutters. Auto picks Low on phones.</p>
      <h3>Recording</h3>
      <label class="check"><input type="checkbox" data-a="rec"> Record my games (stays on this device)</label>
      <div class="row rec-actions">
        <span class="rec-count hint"></span>
        <button class="small" data-a="rec-dl">Download</button>
        <button class="small" data-a="rec-clear">Clear</button>
      </div>
      <p class="hint">Saves your orders, camera and selections to study how people play. Nothing is uploaded; Download gives you a file to share.</p>
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
  const res = [...m.querySelectorAll<HTMLButtonElement>('[data-a=res] button')];
  const markRes = () => res.forEach((b) => b.classList.toggle('on', b.dataset.v === resolution()));
  res.forEach((b) =>
    b.addEventListener('click', () => {
      setResolution(b.dataset.v as Resolution);
      markRes();
    }),
  );
  markRes();
  const aq = [...m.querySelectorAll<HTMLButtonElement>('[data-a=aq] button')];
  const markAq = () => aq.forEach((b) => b.classList.toggle('on', b.dataset.v === audio.quality));
  aq.forEach((b) =>
    b.addEventListener('click', () => {
      audio.setQuality(b.dataset.v as AudioQuality);
      markAq();
    }),
  );
  markAq();
  m.querySelectorAll<HTMLInputElement>('[data-vol]').forEach((inp) =>
    inp.addEventListener('input', () => audio.setVolume(inp.dataset.vol as VolumeKind, Number(inp.value) / 100)),
  );
  const theme = m.querySelector('[data-a=theme]') as HTMLSelectElement;
  theme.value = audio.themePin;
  theme.addEventListener('change', () => audio.setTheme(theme.value));
  const rec = m.querySelector('[data-a=rec]') as HTMLInputElement;
  const count = m.querySelector('.rec-count') as HTMLSpanElement;
  const dl = m.querySelector('[data-a=rec-dl]') as HTMLButtonElement;
  const clear = m.querySelector('[data-a=rec-clear]') as HTMLButtonElement;
  const refresh = () =>
    countRecordings().then((n) => {
      count.textContent = `${n} game${n === 1 ? '' : 's'} saved`;
      dl.disabled = clear.disabled = n === 0;
    });
  rec.checked = recordingEnabled();
  rec.addEventListener('change', () => setRecordingEnabled(rec.checked));
  dl.addEventListener('click', () => void downloadRecordings());
  clear.addEventListener('click', () => {
    if (confirm('Delete every saved recording on this device?')) void clearRecordings().then(refresh);
  });
  void refresh();
  return m;
}

export function settingsScreen(audio: AudioEngine, onBack: () => void): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card">
        <h2>Settings</h2>
        <div class="fields"></div>
        <div class="relay-field"></div>
        <div class="row end"><button class="primary" data-a="back">Done</button></div>
      </div>
    </div>`);
  m.querySelector('.fields')!.replaceWith(settingsFields(audio, () => {}));
  m.querySelector('.relay-field')!.replaceWith(relayField());
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
        <p>Rock blocks paths (cave maps are mostly rock, with tunnels between chambers), purple nebula slows, red rifts burn the longer you stand in them. Hold a crystal or a supply drop alone for energy. Wild swarms and the Colossus fight everyone.</p>
        <h3>The campaign</h3>
        <p>The procedural campaign has its own How to play: Campaign, then Procedural campaign, then How to play, or tap <b>?</b> on a run's map.</p>
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
            <p>Every color wants the map. <b>Nests</b> are the only way to make more dots, so capture them. Win by wiping out every rival, or by holding <b>70% of the nests for 30 seconds</b> (60% on large maps). In a team match the bar is higher, and higher still for the bigger team, since a team starts with more of the map.</p>
            <h3>Fighting</h3>
            <p>Dots fight automatically. Any dot near an enemy locks on and shoots. The thin lines are the shots. Your job is to decide where your dots go and when they go there.</p>
            <h3>Capturing</h3>
            <p>Park dots on a nest while no enemies are on it, and the ring fills. Neutral nests have gray guards, so clear them out first. A nest that's under attack stops spawning. Your dots take less damage near your own nests, so a comeback is always possible. From minute 5 those comeback bonuses fade out (<b>escalation</b>), so every match reaches an endgame.</p>
            <h3>Supply</h3>
            <p>Your army can only grow so big: <b>20 + 16 per nest you hold</b> (half that for each nest past six), plus a little for each upgrade level. Your count at the top shows army / cap. Nests slow down as you near the cap and stop at it (nothing dies), so to grow, take more nests. Escalation lifts the cap and the slowdown late in the match.</p>
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
              <li><i class="t-rift"></i><b>Rift</b> burns hotter the longer you stay: dash across, don't fight in it</li>
              <li><i class="t-crys"></i><b>Crystal</b> charges energy for whoever holds it alone</li>
            </ul>
            <h3>Map events</h3>
            <p>A <b>wild swarm</b> (red-gray) hunts the biggest army nearby, so lead it into a rival. <b>Supply drops</b> pay energy and a free nest upgrade to whoever holds them alone (the biggest army only gets the energy). The <b>Colossus</b> wanders across the map: whoever lands the killing blow gets full energy and an upgrade. Neutral nests regrow their guards, and nests nobody holds go wild again.</p>
            <p><b>Energy</b> builds up over time, and faster from kills and captures. <b>Surge</b> (30) makes your selected dots faster, stronger and tougher for 6 seconds. <b>Nova</b> (60) sacrifices some of your dots to blast everything around them.</p>
          </div>
        </div>
        <p class="hint">The procedural campaign has its own How to play, with a tour of its map: open it from the campaign's run list, or with <b>?</b> on a run's map.</p>
        <h3>Controls</h3>
        ${CONTROLS_HTML}
        <div class="row end"><button class="primary" data-a="back">Got it</button></div>
      </div>
    </div>`);
  m.querySelector('[data-a=back]')!.addEventListener('click', onBack);
  return m;
}

const CAVE_LABEL: Record<CaveLevel, string> = { off: 'Open', belt: 'Cave belt', full: 'Caves' };
const LAYOUT_LABEL: Record<MapLayout | 'random', string> = { random: 'Random', classic: 'Classic', open: 'Open center', core: 'Core', clusters: 'Clusters', lanes: 'Lanes' };

/** Fixed scenarios for recording sessions (#29), replayed on the same seeds so games compare. */
interface Scenario {
  name: string;
  seed: string;
  size: MapSize;
  caves: CaveLevel;
  bots: (Personality | 'random')[];
  /** nest share that wins by domination, if not the size's usual one (campaign domination nodes use 0.5) */
  domShare?: number;
}

const SCENARIOS: Scenario[] = [
  ...PERSONALITIES.map((p): Scenario => ({ name: `1v1 vs ${PERSONA_LABEL[p]}`, seed: `rec-duel-${p}`, size: 'small', caves: 'off', bots: [p] })),
  { name: '4-player FFA', seed: 'rec-ffa-4', size: 'medium', caves: 'off', bots: ['random', 'random', 'random'] },
  { name: '1v1 on Caves', seed: 'rec-caves', size: 'small', caves: 'full', bots: ['random'] },
  { name: '1v1 on Cave belt', seed: 'rec-belt', size: 'small', caves: 'belt', bots: ['random'] },
  { name: '6 players, large', seed: 'rec-ffa-6', size: 'large', caves: 'off', bots: ['random', 'random', 'random', 'random', 'random'] },
  { name: '3-player FFA, domination', seed: 'rec-dom-3', size: 'medium', caves: 'off', bots: ['random', 'random'], domShare: 0.5 },
];

/**
 * Multiplayer's "Hide my IP" (#163): connect only through the relay, so other
 * players never see your address. Off when this build has no relay.
 */
export function relayField(): HTMLDivElement {
  const f = el(`
    <div class="field">
      <label>Multiplayer</label>
      <label class="check"><input type="checkbox" data-a="relay"> Hide my IP from other players (relay only)</label>
      <p class="hint"></p>
    </div>`);
  const box = f.querySelector('[data-a=relay]') as HTMLInputElement;
  const hint = f.querySelector('.hint') as HTMLParagraphElement;
  box.checked = relayOnly();
  box.disabled = !TURN_URL;
  hint.textContent = TURN_URL
    ? 'Everything goes through a relay server instead of straight between players: a little more delay. Takes effect the next time you join a room.'
    : 'This version of the game has no relay, so players connect directly.';
  box.addEventListener('change', () => setRelayOnly(box.checked));
  return f;
}

/** The map's choices, as the skirmish screen and the multiplayer lobby (#162) show them. */
export interface MapChoice {
  size: MapSize;
  terrain: TerrainLevel;
  caves: CaveLevel;
  layout: SetupPrefs['layout'];
  events: EventLevel;
}

/**
 * Map size, terrain, ground, layout and events as segmented buttons.
 * `onChange` gets each pick; `render` shows a choice (and, with `readOnly`,
 * nothing can be picked: a guest's view of the host's lobby).
 */
export function mapFields(onChange: (patch: Partial<MapChoice>) => void): { el: HTMLDivElement; render: (m: MapChoice, readOnly?: boolean, fixed?: Partial<MapChoice>) => void } {
  const f = el(`
    <div class="mapfields">
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
        <label>Ground <small>open, a ring of caves around the center, or one big cave system</small></label>
        <div class="seg" data-a="caves">
          ${CAVE_LEVELS.map((t) => `<button data-v="${t}">${CAVE_LABEL[t]}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Map <small>how the nests are spread</small></label>
        <div class="seg wrap" data-a="layout">
          ${(['random', ...MAP_LAYOUTS] as const).map((t) => `<button data-v="${t}">${LAYOUT_LABEL[t]}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Events <small>wild swarms, drops, the Colossus</small></label>
        <div class="seg" data-a="events">
          ${EVENT_LEVELS.map((t) => `<button data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
      </div>
    </div>`) as HTMLDivElement;
  const keys = ['size', 'terrain', 'caves', 'layout', 'events'] as const;
  for (const k of keys) {
    f.querySelector(`[data-a=${k}]`)!.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).dataset.v;
      const b = (e.target as HTMLElement).closest('button');
      if (v && !b?.disabled) onChange({ [k]: v } as Partial<MapChoice>);
    });
  }
  /** `fixed`: fields the match type sets (#222: a fortress has open ground), shown but not pickable */
  const render = (m: MapChoice, readOnly = false, fixed: Partial<MapChoice> = {}) => {
    for (const k of keys) {
      const v = fixed[k] ?? m[k];
      f.querySelectorAll<HTMLButtonElement>(`[data-a=${k}] button`).forEach((b) => {
        b.classList.toggle('on', b.dataset.v === v);
        b.disabled = (readOnly || fixed[k] !== undefined) && b.dataset.v !== v;
      });
    }
  };
  return { el: f, render };
}

export function skirmishSetup(onStart: (setup: MatchSetup, scenario?: string) => void, onBack: () => void): HTMLDivElement {
  const prefs = loadPrefs();
  let seedText = randomSeed();
  /** the recording-session preset in use, until the player changes a setting */
  let scenario: Scenario | null = null;

  const m = el(`
    <div class="screen modal">
      <div class="card setup">
        <h2>Skirmish</h2>
        ${recordingEnabled() ? `<div class="field">
          <label>Recording session <small>fixed matchups on fixed seeds, so games compare</small></label>
          <select data-a="scenario"><option value="">Custom</option>${SCENARIOS.map((s, i) => `<option value="${i}">${s.name}</option>`).join('')}</select>
        </div>` : ''}
        <div class="field">
          <label>Your color</label>
          <div class="swatches"></div>
        </div>
        <div class="field">
          <label>Match type <small class="mode-blurb"></small></label>
          <div class="seg wrap" data-a="matchmode">
            ${MATCH_MODES.map((t) => `<button data-v="${t}">${MATCH_MODE_LABEL[t]}</button>`).join('')}
          </div>
        </div>
        <div class="field waves">
          <label>Waves <small>how big and how often; harder holds longer</small></label>
          <div class="seg" data-a="waves">
            ${WAVE_NAMES.map((t, i) => `<button data-v="${i}">${t}</button>`).join('')}
          </div>
        </div>
        <div class="field opponents">
          <label>Opponents <small>bots</small></label>
          <div class="bots"></div>
          <div class="row">
            <button class="small" data-a="add">+ Add bot</button>
            <label class="check"><input type="checkbox" data-a="teams"> Teams (you are team A)</label>
          </div>
        </div>
        <div class="mapfields"></div>
        <div class="field">
          <label>Map seed</label>
          <div class="row"><input class="seed" spellcheck="false"><button class="small icon" data-a="dice" title="Random seed">⟳</button></div>
        </div>
        <p class="problem" hidden></p>
        <div class="row end">
          <button data-a="back">Back</button>
          <button class="primary" data-a="start">Start match</button>
        </div>
      </div>
    </div>`);

  const fields = mapFields((patch) => {
    Object.assign(prefs, patch);
    render();
  });
  m.querySelector('.mapfields')!.replaceWith(fields.el);
  const swatches = m.querySelector('.swatches') as HTMLDivElement;
  const bots = m.querySelector('.bots') as HTMLDivElement;
  const seedInput = m.querySelector('.seed') as HTMLInputElement;
  const teamsBox = m.querySelector('[data-a=teams]') as HTMLInputElement;
  seedInput.value = seedText;
  teamsBox.checked = prefs.teams;

  const used = () => new Set([prefs.color, ...prefs.bots.map((b) => b.faction)]);
  const freeColor = () => [0, 1, 2, 3, 4, 5].find((c) => !used().has(c)) ?? -1;

  const scenarioSel = m.querySelector('[data-a=scenario]') as HTMLSelectElement | null;
  scenarioSel?.addEventListener('change', () => {
    scenario = SCENARIOS[Number(scenarioSel.value)] ?? null;
    if (!scenario) return render();
    const difficulty = prefs.bots[0]?.difficulty ?? 1;
    const free = [0, 1, 2, 3, 4, 5].filter((c) => c !== prefs.color);
    prefs.size = scenario.size;
    prefs.terrain = 'standard';
    prefs.caves = scenario.caves;
    prefs.layout = 'random';
    prefs.events = 'normal';
    prefs.teams = false;
    prefs.mode = 'conquest';
    teamsBox.checked = false;
    prefs.bots = scenario.bots.map((personality, i) => ({ faction: free[i], difficulty, personality, team: i + 1 }));
    seedInput.value = scenario.seed;
    render();
  });
  // Any manual change leaves the preset.
  m.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement;
      if (scenario && t.tagName !== 'SELECT' && t.closest('.seg, .swatches, .bots, [data-a=add], [data-a=dice]')) scenario = null;
    },
    { capture: true },
  );
  // Bot difficulty is part of the recorded setup, so changing it keeps the preset.
  m.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (scenario && t !== scenarioSel && t.dataset.a !== 'diff') {
      scenario = null;
      render();
    }
  });
  seedInput.addEventListener('input', () => (scenario = null));

  const render = () => {
    if (scenarioSel && !scenario) scenarioSel.value = '';
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
          ${prefs.mode === 'stronghold' ? `<button class="small icon crown${i === prefs.holder ? ' on' : ''}" data-a="holder" title="${i === prefs.holder ? 'Holds the stronghold' : 'Hold the stronghold'}">♛</button>` : ''}
          <button class="small icon" data-a="del" title="Remove" ${prefs.bots.length <= 1 ? 'disabled' : ''}>✕</button>
        </div>`,
      )
      .join('');
    (m.querySelector('[data-a=add]') as HTMLButtonElement).disabled = prefs.bots.length >= 5;
    // The match type (#222): Hold the line has no bots; fortresses have no cave rock (it could seal the gates).
    if (prefs.holder >= prefs.bots.length) prefs.holder = 0;
    m.querySelectorAll<HTMLButtonElement>('[data-a=matchmode] button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.mode));
    m.querySelectorAll<HTMLButtonElement>('[data-a=waves] button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === prefs.waves));
    (m.querySelector('.mode-blurb') as HTMLElement).textContent = MATCH_MODE_BLURB[prefs.mode];
    (m.querySelector('.waves') as HTMLElement).hidden = prefs.mode !== 'hold';
    (m.querySelector('.opponents') as HTMLElement).hidden = prefs.mode === 'hold';
    const fort = prefs.mode === 'hold' || prefs.mode === 'stronghold';
    // Hold the line's waves come from the swarm spawns: events can be anything but off (Calm, if they were)
    if (prefs.mode === 'hold' && prefs.events === 'off') prefs.events = 'calm';
    fields.render(prefs, false, fort ? { caves: 'off' } : {});
    const noEvents = fields.el.querySelector<HTMLButtonElement>('[data-a=events] button[data-v=off]')!;
    if (prefs.mode === 'hold') noEvents.disabled = true;
    const problem = prefsProblem(prefs);
    const p = m.querySelector('.problem') as HTMLElement;
    p.hidden = !problem;
    p.textContent = problem ? `${problem}: change the teams, or pick another match type.` : '';
    (m.querySelector('[data-a=start]') as HTMLButtonElement).disabled = !!problem;
  };

  m.querySelector('[data-a=matchmode]')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.v as MatchMode | undefined;
    if (!v) return;
    prefs.mode = v;
    render();
  });
  m.querySelector('[data-a=waves]')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.v;
    if (v === undefined) return;
    prefs.waves = Number(v);
    render();
  });

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
      const i = Number(row.dataset.i);
      prefs.bots.splice(i, 1);
      if (prefs.holder > i) prefs.holder--;
      render();
    } else if (t.dataset.a === 'holder') {
      prefs.holder = Number(row.dataset.i);
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
    if (t.dataset.a === 'team') {
      b.team = Number(t.value);
      render();
    }
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
  m.querySelector('[data-a=dice]')!.addEventListener('click', () => {
    seedText = randomSeed();
    seedInput.value = seedText;
  });
  m.querySelector('[data-a=back]')!.addEventListener('click', onBack);
  m.querySelector('[data-a=start]')!.addEventListener('click', () => {
    settleTeams(prefs);
    // checked as it will start (#222): a match type it can't be stays unstarted, rather than quietly Conquest
    if (prefsProblem(prefs)) return render();
    savePrefs(prefs);
    const setup = buildSetup(prefs, seedInput.value);
    if (scenario?.domShare) setup.domShare = scenario.domShare;
    onStart(setup, scenario?.name);
  });

  render();
  return m;
}

/**
 * The pause menu. In a networked match (#162) there's no restart, the title
 * says whether the match is actually stopped, and `note` (a `.note` line the
 * caller may update) says for how long; `players` lists who's in it.
 */
export function pauseMenu(h: {
  resume: () => void;
  restart?: () => void;
  quit: () => void;
  audio: AudioEngine;
  quitLabel?: string;
  teams?: string;
  title?: string;
  note?: string;
  resumeLabel?: string;
  players?: string;
  /** more buttons after Restart (a room host's End match, #183) */
  more?: { label: string; on: () => void }[];
}): HTMLDivElement {
  const m = el(`
    <div class="screen modal dim">
      <div class="card">
        <h2>${h.title ?? 'Paused'}</h2>
        <p class="note hint"${h.note ? '' : ' hidden'}>${h.note ?? ''}</p>
        <div class="menu-buttons">
          <button class="primary" data-a="resume">${h.resumeLabel ?? 'Resume'}</button>
          ${h.restart ? '<button data-a="restart">Restart match</button>' : ''}
          ${(h.more ?? []).map((b, i) => `<button data-more="${i}">${b.label}</button>`).join('')}
          <button data-a="quit">${h.quitLabel ?? 'Quit to menu'}</button>
        </div>
        ${h.players ? `<h3>Players</h3>${h.players}` : ''}
        ${h.teams ? `<h3>Teams</h3>${h.teams}` : ''}
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
  if (h.restart) m.querySelector('[data-a=restart]')!.addEventListener('click', h.restart);
  (h.more ?? []).forEach((b, i) => m.querySelector(`[data-more="${i}"]`)!.addEventListener('click', b.on));
  m.querySelector('[data-a=quit]')!.addEventListener('click', h.quit);
  return m;
}

export function endScreen(
  w: World,
  human: number,
  victory: boolean,
  h: { rematch: () => void; newMap: () => void; quit: () => void },
  /** a networked match (#162): players' character names, and its own buttons in place of rematch / new map / menu */
  net?: { names: Record<number, string>; buttons: { label: string; primary?: boolean; on: () => void }[]; note?: string },
): HTMLDivElement {
  const nameOf = (id: number) => net?.names[id] ?? FACTION_NAMES[id];
  const rows = w.factions
    .filter((f) => f.active && f.id !== NEUTRAL)
    .map(
      (f) => `<tr class="${f.id === human ? 'me' : ''}${f.eliminated ? ' dead' : ''}">
        <td><i style="background:${FACTION_HEX[f.id]}"></i>${nameOf(f.id)}${f.id === human ? ' (you)' : ''}</td>
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
  if (net) {
    const row = m.querySelector('.row.end')!;
    row.innerHTML = net.note ? `<span class="hint">${net.note}</span>` : '';
    for (const b of net.buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      btn.addEventListener('click', b.on);
      row.appendChild(btn);
    }
  } else {
    m.querySelector('[data-a=rematch]')!.addEventListener('click', h.rematch);
    m.querySelector('[data-a=newmap]')!.addEventListener('click', h.newMap);
    m.querySelector('[data-a=quit]')!.addEventListener('click', h.quit);
  }
  requestAnimationFrame(() => drawChart(m.querySelector('.chart') as HTMLCanvasElement, w));
  return m;
}

/** "You won by domination", "Magenta won by elimination", ... */
function how(w: World, human: number): string {
  if (w.winReason === 'fallen') return 'The line broke: <b>your capital fell</b>';
  if (w.winnerTeam < 0 || !w.winReason) return w.factions[human]?.eliminated ? 'You were eliminated' : 'Match over';
  const mine = w.winnerTeam === w.teamOf[human];
  const face = w.factions.find((f) => f.active && f.id !== NEUTRAL && f.team === w.winnerTeam && !f.eliminated) ?? w.factions.find((f) => f.team === w.winnerTeam);
  const who = mine ? (w.factions.filter((f) => f.active && f.team === w.winnerTeam).length > 1 ? 'Your team' : 'You') : face ? FACTION_NAMES[face.id] : 'A rival';
  if (w.winReason === 'heart') return `${who} destroyed <b>the Bloom's heart</b>`;
  if (w.winReason === 'citadel') return `${who} took <b>the citadel</b>`;
  if (w.winReason === 'held') return `${who} <b>held the line</b>`;
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
