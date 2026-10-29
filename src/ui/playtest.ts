import { PLAYTESTS, type Playtest } from '../campaign/playtest';

/**
 * The playtest menu (`?playtest`): jump straight into one feature, on a
 * throwaway run that is never saved.
 */
export function playtestMenu(h: { play: (p: Playtest) => void; back: () => void }): HTMLDivElement {
  const groups = [...new Set(PLAYTESTS.map((p) => p.group))];
  const m = document.createElement('div');
  m.className = 'screen modal';
  m.innerHTML = `
    <div class="card hub playtests">
      <h2>Playtests</h2>
      <p class="hint">Each one starts a throwaway run set up to show one thing. Nothing here is saved. Come back with <b>?playtest</b> in the address.</p>
      ${groups
        .map(
          (g) => `<h3>${g}</h3><div class="playtest-list">${PLAYTESTS.filter((p) => p.group === g)
            .map((p) => `<button class="playtest" data-p="${p.id}"><b>${p.title}</b><small>${p.text}</small></button>`)
            .join('')}</div>`,
        )
        .join('')}
      <div class="row end"><button data-a="back">Main menu</button></div>
    </div>`;
  m.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) =>
    b.addEventListener('click', () => h.play(PLAYTESTS.find((p) => p.id === b.dataset.p)!)),
  );
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}
