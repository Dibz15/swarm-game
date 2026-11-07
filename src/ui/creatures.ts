/**
 * Dev grid for the creature generator (#72), opened with `?creatures`: every
 * temper × silhouette in the faction colours, a few big animated portraits,
 * and toggles for tier, plating, wounds and marks, to judge variety.
 */

import { MARKS, creature, creatureCanvas, type CreatureTraits } from '../art/creature';
import { FACTION_NAMES } from '../content/factions';
import { PERSONALITIES, type Personality } from '../sim/ai/bot';
import { Kind } from '../sim/constants';

const FOCI: { label: string; focus?: number }[] = [
  { label: 'any' },
  { label: 'Swarmer', focus: Kind.Dot },
  { label: 'Shield', focus: Kind.Tank },
  { label: 'Spear', focus: Kind.Lancer },
  { label: 'Raider', focus: Kind.Swift },
];
const TEMPERS: (Personality | undefined)[] = [undefined, ...PERSONALITIES];

export function creatureGrid(): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'creature-grid';
  let base = 1;
  let tier = 1;
  let plating = 0;
  let wounded = false;
  let mark = false;

  const draw = () => {
    const extra = (): Partial<CreatureTraits> => ({ tier, plating, wounded, marks: mark ? Object.keys(MARKS) : [] });
    root.innerHTML = `
      <header>
        <h2>CREATURES</h2>
        <button data-a="reroll">Reroll</button>
        ${[0, 1, 2, 3].map((t) => `<button class="small${t === tier ? ' on' : ''}" data-tier="${t}">Tier ${t}</button>`).join('')}
        <button class="small${plating ? ' on' : ''}" data-a="plating">Plating</button>
        <button class="small${wounded ? ' on' : ''}" data-a="wounded">Wounded</button>
        <button class="small${mark ? ' on' : ''}" data-a="mark">Marks</button>
        <span class="hint">seed ${base}</span>
      </header>
      <div class="big"></div>
      <div class="grid"></div>`;
    const big = root.querySelector('.big')!;
    for (let i = 0; i < 4; i++) {
      const c = creature(base * 7919 + i, i % 6, { temper: PERSONALITIES[i], ...extra() });
      const f = document.createElement('figure');
      f.append(creatureCanvas(c, 160, true), `${c.name} · ${PERSONALITIES[i]}`);
      big.append(f);
    }
    const grid = root.querySelector('.grid')!;
    grid.append(document.createElement('span'));
    for (const f of FOCI) grid.append(Object.assign(document.createElement('b'), { textContent: f.label }));
    TEMPERS.forEach((temper, row) => {
      grid.append(Object.assign(document.createElement('b'), { textContent: temper ?? 'none' }));
      FOCI.forEach((f, col) => {
        const cell = document.createElement('div');
        cell.className = 'cell';
        for (let j = 0; j < 3; j++) {
          const color = (row + col + j) % 6;
          const c = creature(base * 104729 + row * 97 + col * 13 + j, color, { temper, focus: f.focus, ...extra() });
          const cv = creatureCanvas(c, 64);
          cv.title = `${c.name} · ${FACTION_NAMES[color]} · ${c.body.shape} · ${c.pattern}`;
          cell.append(cv);
        }
        grid.append(cell);
      });
    });
    root.querySelector('[data-a=reroll]')!.addEventListener('click', () => {
      base++;
      draw();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((b) =>
      b.addEventListener('click', () => {
        tier = Number(b.dataset.tier);
        draw();
      }),
    );
    root.querySelector('[data-a=plating]')!.addEventListener('click', () => {
      plating = plating ? 0 : 1;
      draw();
    });
    root.querySelector('[data-a=wounded]')!.addEventListener('click', () => {
      wounded = !wounded;
      draw();
    });
    root.querySelector('[data-a=mark]')!.addEventListener('click', () => {
      mark = !mark;
      draw();
    });
  };
  draw();
  return root;
}
