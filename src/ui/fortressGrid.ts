import { FACTION_HEX } from '../content/factions';
import { FORTRESS_LABEL } from '../sim/fortify';
import { generateMap, type MapSize } from '../sim/mapgen';
import { drawBattleMap } from './runmapfx';

/**
 * Dev grid (`?fortress`): 24 fortresses side by side, to review how varied
 * they come out (#67). Player 1 (the second colour) is the one walled in.
 */
export function fortressGrid(): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'creature-grid fortress-grid';
  let base = 0;
  let size: MapSize = 'medium';
  const draw = () => {
    root.innerHTML = `
      <header>
        <h2>FORTRESSES</h2>
        <button data-a="reroll">Next 24</button>
        ${(['small', 'medium', 'large'] as MapSize[]).map((s) => `<button class="small${s === size ? ' on' : ''}" data-size="${s}">${s}</button>`).join('')}
        <span class="hint">seeds ${base}–${base + 23}</span>
      </header>
      <div class="grid"></div>`;
    const grid = root.querySelector('.grid')!;
    for (let k = 0; k < 24; k++) {
      const seed = base + k;
      const m = generateMap({ seed, size, players: 3, terrain: 'standard', fortress: 1 });
      const cell = document.createElement('figure');
      const cv = document.createElement('canvas');
      const px = 220, dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = px, h = Math.round((px * m.height) / m.width);
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
      cap.textContent = `${seed} · ${m.fortress ? FORTRESS_LABEL[m.fortress.style] : 'no walls'}`;
      cell.appendChild(cap);
      grid.appendChild(cell);
    }
    root.querySelector('[data-a=reroll]')!.addEventListener('click', () => {
      base += 24;
      draw();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((b) =>
      b.addEventListener('click', () => {
        size = b.dataset.size as MapSize;
        draw();
      }),
    );
  };
  draw();
  return root;
}
