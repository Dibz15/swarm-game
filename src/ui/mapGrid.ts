import { FACTION_HEX } from '../content/factions';
import { CAVE_LEVELS, generateMap, MAP_FORMS, type CaveLevel, type MapForm, type MapSize } from '../sim/mapgen';
import type { MatchSetup } from '../sim/setup';
import { drawBattleMap } from './runmapfx';

/**
 * Dev grid (`?maps`): 24 generated maps side by side at their true shape, to
 * review how varied they come out (#98): aspect, density, layout, form. Click
 * one to play it against Normal bots.
 */
export function mapGrid(play: (setup: MatchSetup) => void): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'creature-grid fortress-grid';
  let base = 0;
  let size: MapSize = 'medium';
  let players = 2;
  let caves: CaveLevel = 'off';
  let form: MapForm | 'random' = 'random';
  const draw = () => {
    const opts = <T extends string | number>(key: string, list: readonly T[], now: T) =>
      list.map((v) => `<button class="small${v === now ? ' on' : ''}" data-${key}="${v}">${v}</button>`).join('');
    root.innerHTML = `
      <header>
        <h2>MAPS</h2>
        <button data-a="reroll">Next 24</button>
        ${opts('size', ['small', 'medium', 'large'] as MapSize[], size)}
        ${opts('players', [2, 3, 4, 6], players)}
        ${opts('caves', CAVE_LEVELS, caves)}
        ${opts('form', ['random', ...MAP_FORMS] as (MapForm | 'random')[], form)}
        <span class="hint">seeds ${base}–${base + 23}</span>
      </header>
      <div class="grid"></div>`;
    const grid = root.querySelector('.grid')!;
    for (let k = 0; k < 24; k++) {
      const seed = base + k;
      const m = generateMap({ seed, size, players, terrain: 'standard', caves, form });
      const cell = document.createElement('figure');
      const cv = document.createElement('canvas');
      // Same scale for every map, so size and shape compare at a glance.
      const s = 0.13, dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(m.width * s), h = Math.round(m.height * s);
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const g = cv.getContext('2d');
      if (g) {
        g.fillStyle = '#0a0d1c';
        g.fillRect(0, 0, cv.width, cv.height);
        drawBattleMap(g, m, (p) => (p >= 0 ? FACTION_HEX[p] : '#e6eaff'), 0, 0, cv.width / m.width, true);
      }
      cell.appendChild(cv);
      const cap = document.createElement('figcaption');
      cap.textContent = `${seed} · ${m.form}${m.topology && m.form !== 'caves' ? ` (${m.topology})` : ''}${m.fill === 'noise' ? ' + noise' : ''} · ${m.layout} · ${m.aspect!.toFixed(1)}:1 · density ${m.density!.toFixed(2)} · ${m.nests.length} nests`;
      cell.appendChild(cap);
      cell.style.cursor = 'pointer';
      cell.title = 'Play this map';
      cell.addEventListener('click', () =>
        play({
          seed,
          size,
          terrain: 'standard',
          caves,
          form,
          events: 'calm',
          players: Array.from({ length: players }, (_, k) => (k === 0 ? { faction: 0, team: 0, human: true } : { faction: k, team: k, human: false, bot: { difficulty: 1, personality: 'expander' } })),
        }),
      );
      grid.appendChild(cell);
    }
    root.querySelector('[data-a=reroll]')!.addEventListener('click', () => {
      base += 24;
      draw();
    });
    const pick = (key: string, set: (v: string) => void) =>
      root.querySelectorAll<HTMLButtonElement>(`[data-${key}]`).forEach((b) =>
        b.addEventListener('click', () => {
          set(b.dataset[key]!);
          draw();
        }),
      );
    pick('size', (v) => (size = v as MapSize));
    pick('players', (v) => (players = Number(v)));
    pick('caves', (v) => (caves = v as CaveLevel));
    pick('form', (v) => (form = v as MapForm | 'random'));
  };
  draw();
  return root;
}
