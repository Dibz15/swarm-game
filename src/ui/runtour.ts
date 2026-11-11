/**
 * The run map's tour (#217): a coach card over the map that steps through
 * `TOUR`, and the procedural campaign's How to play, which can replay it.
 * The map does the looking (`TourControl`); this only drives it.
 */

import { GLOSSARY, type TourCamp, type TourFocus, type TourMark, type TourStep } from '../campaign/tour';
import type { RunState } from '../campaign/run';

/** What the map lets the tour do. */
export interface TourControl {
  focus: (f: TourFocus) => void;
  mark: (marks: TourMark[]) => void;
  /** nodes to show through the fog */
  peek: (nodes: number[]) => void;
  select: (node: number | null) => void;
  camp: (tab: TourCamp | null) => void;
  pulse: (selector: string | null) => void;
  sound: () => void;
  /** finished or skipped */
  end: () => void;
}

export interface Tour {
  stop: () => void;
}

function el(html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLDivElement;
}

/** Put the tour's card on the map and show its first step. */
export function mountTour(host: HTMLElement, steps: TourStep[], run: RunState, ctl: TourControl): Tour {
  const card = el(`
    <div class="coach on run-tour" role="dialog" aria-live="polite" aria-label="Campaign tour">
      <small></small>
      <p></p>
      <div class="coach-row">
        <span class="pips"></span>
        <span class="tour-buttons">
          <button class="small" data-a="skip">Skip tour</button>
          <button class="small" data-a="back">Back</button>
          <button class="small primary" data-a="next">Next</button>
        </span>
      </div>
    </div>`);
  const title = card.querySelector('small')!;
  const text = card.querySelector('p')!;
  const pips = card.querySelector('.pips')!;
  const back = card.querySelector('[data-a=back]') as HTMLButtonElement;
  const next = card.querySelector('[data-a=next]') as HTMLButtonElement;
  let i = 0;
  let done = false;

  const show = () => {
    const s = steps[i];
    title.textContent = `${s.title} · ${i + 1} of ${steps.length}`;
    text.textContent = s.text;
    pips.innerHTML = steps.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i>`).join('');
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    ctl.camp(s.camp ?? null);
    ctl.select(s.camp ? null : (s.select?.(run) ?? null));
    ctl.focus(s.focus(run));
    ctl.mark(s.marks?.(run) ?? []);
    ctl.peek(s.peek?.(run) ?? []);
    ctl.pulse(s.dom ?? null);
    // The camp leaves room for the card, however tall this step's text makes it.
    host.style.setProperty('--tour-h', `${card.offsetHeight}px`);
    // Replay the card's flash for each new step.
    card.classList.remove('pop');
    void card.offsetWidth;
    card.classList.add('pop');
  };
  const stop = () => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', key);
    card.remove();
    host.style.removeProperty('--tour-h');
    ctl.pulse(null);
    ctl.end();
  };
  const go = (d: number) => {
    const k = i + d;
    if (k < 0) return;
    if (k >= steps.length) return stop();
    i = k;
    ctl.sound();
    show();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Escape') stop();
    else return;
    e.preventDefault();
  };
  next.addEventListener('click', () => go(1));
  back.addEventListener('click', () => go(-1));
  card.querySelector('[data-a=skip]')!.addEventListener('click', stop);
  document.addEventListener('keydown', key);
  host.append(card);
  if (steps.length) show();
  else stop();
  return { stop };
}

/**
 * How to play the procedural campaign: its terms, and a button for the map tour.
 * `replay` is left out where there's no map to tour; `note` says why instead.
 */
export function runHowTo(h: { back: () => void; replay?: () => void; replayLabel?: string; note?: string }): HTMLDivElement {
  const m = el(`
    <div class="screen modal run-howto">
      <div class="card wide">
        <h2>Procedural campaign</h2>
        <dl class="glossary">${GLOSSARY.map((g) => `<dt>${g.term}</dt><dd>${g.text}</dd>`).join('')}</dl>
        ${h.note ? `<p class="hint">${h.note}</p>` : ''}
        <div class="row end">
          ${h.replay ? `<button data-a="replay">${h.replayLabel ?? 'Replay the map tour'}</button>` : ''}
          <button class="primary" data-a="back">Got it</button>
        </div>
      </div>
    </div>`);
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  if (h.replay) m.querySelector('[data-a=replay]')!.addEventListener('click', h.replay);
  return m;
}
