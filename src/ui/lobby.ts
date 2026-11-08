/**
 * Multiplayer screens (#162): the entry card and the room lobby. Rendering
 * only: `src/net/lobby.ts` owns the state, `main.ts` wires the two.
 */

import { creatureCanvas } from '../art/creature';
import { FACTION_HEX, FACTION_NAMES } from '../content/factions';
import { characterCreature, playerCharacter, type Character } from '../game/character';
import { randomSeed } from '../game/matchSetup';
import type { LobbyState, SeatRow } from '../net/lobby';
import { DIFFICULTY_NAMES, PERSONALITIES, type Personality } from '../sim/ai/bot';
import { relayOnly } from '../net/ice';
import { mapFields, relayField, type MapChoice } from './screens';

function el(html: string): HTMLDivElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLDivElement;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TEAM = 'ABCDEF';
const PERSONA: Record<Personality | 'random', string> = { random: 'Random', rusher: 'Rusher', turtler: 'Turtler', expander: 'Expander', opportunist: 'Opportunist' };

/** A dialog with a title, a line of text and some buttons (a lost host, a refused join…). */
export function messageCard(title: string, text: string, buttons: { label: string; primary?: boolean; on: () => void }[]): HTMLDivElement {
  const m = el(`<div class="screen modal dim"><div class="card"><h2></h2><p></p><div class="row end"></div></div></div>`);
  m.querySelector('h2')!.textContent = title;
  m.querySelector('p')!.textContent = text;
  const row = m.querySelector('.row')!;
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    btn.addEventListener('click', b.on);
    row.appendChild(btn);
  }
  return m;
}

/** The Multiplayer entry: host a room, or paste a link to join one. */
export function multiplayerMenu(h: { host: () => void; join: (link: string) => void; back: () => void }): HTMLDivElement {
  const m = el(`
    <div class="screen modal">
      <div class="card">
        <h2>Multiplayer</h2>
        <p class="hint">Play with friends over the internet, up to six of you. Host a room and send them the link: no accounts, no server.</p>
        <div class="menu-buttons">
          <button class="primary" data-a="host">Host a game</button>
        </div>
        <div class="field">
          <label>Join a game <small>paste the link your host sent</small></label>
          <div class="row"><input class="join" spellcheck="false" placeholder="https://…#room=…"><button class="small" data-a="join">Join</button></div>
        </div>
        <div class="relay-field"></div>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  m.querySelector('.relay-field')!.replaceWith(relayField());
  const input = m.querySelector('.join') as HTMLInputElement;
  m.querySelector('[data-a=host]')!.addEventListener('click', h.host);
  m.querySelector('[data-a=join]')!.addEventListener('click', () => h.join(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') h.join(input.value);
  });
  m.querySelector('[data-a=back]')!.addEventListener('click', h.back);
  return m;
}

export interface LobbyHandlers {
  leave: () => void;
  /** your seat, team and character */
  pick: (seat: number, team: number, char: number) => void;
  host?: {
    map: (patch: Partial<MapChoice>) => void;
    teams: (on: boolean) => void;
    seed: (text: string) => void;
    row: (seat: number, row: Exclude<SeatRow, { k: 'human' }>) => void;
    kick: (seat: number) => void;
    start: () => void;
  };
}

export interface LobbyView {
  el: HTMLDivElement;
  render: (s: LobbyState | null, me: string, canStart: boolean) => void;
  /** a line under the title: connecting, waiting, refused… (`error` makes it stand out) */
  status: (text: string, error?: boolean) => void;
}

/** The room: invite link, your character, the seats, the map, and Start (host) or a wait (guests). */
export function lobbyScreen(link: string, choices: Character[], h: LobbyHandlers): LobbyView {
  const isHost = !!h.host;
  const m = el(`
    <div class="screen modal">
      <div class="card setup lobby">
        <h2>${isHost ? 'Your room' : 'Joining a room'}</h2>
        <p class="status hint"></p>
        <div class="field">
          <label>Invite friends <small>anyone with this link can join${relayOnly() ? ' · your IP stays hidden (relay only)' : ''}</small></label>
          <div class="row"><input class="link" readonly spellcheck="false"><button class="small" data-a="copy">Copy</button>${'share' in navigator ? '<button class="small" data-a="share">Share</button>' : ''}</div>
        </div>
        <div class="field">
          <label>You play as</label>
          <div class="chars"></div>
        </div>
        <div class="field">
          <label>Players <small>${isHost ? 'fill empty colours with bots, or close them' : 'click an open colour to move there'}</small></label>
          <div class="seats"></div>
          <label class="check"${isHost ? '' : ' hidden'}><input type="checkbox" data-a="teams"> Teams</label>
        </div>
        <div class="mapfields"></div>
        <div class="field">
          <label>Map seed</label>
          <div class="row"><input class="seed" spellcheck="false"${isHost ? '' : ' readonly'}>${isHost ? '<button class="small icon" data-a="dice" title="Random seed">⟳</button>' : ''}</div>
        </div>
        <div class="row end">
          <button data-a="leave">Leave</button>
          ${isHost ? '<button class="primary" data-a="start" disabled>Start match</button>' : '<span class="hint wait">The host starts the match</span>'}
        </div>
      </div>
    </div>`);
  const status = m.querySelector('.status') as HTMLParagraphElement;
  const linkInput = m.querySelector('.link') as HTMLInputElement;
  const chars = m.querySelector('.chars') as HTMLDivElement;
  const seats = m.querySelector('.seats') as HTMLDivElement;
  const seedInput = m.querySelector('.seed') as HTMLInputElement;
  const teamsBox = m.querySelector('[data-a=teams]') as HTMLInputElement;
  const fields = mapFields((patch) => h.host?.map(patch));
  m.querySelector('.mapfields')!.replaceWith(fields.el);
  linkInput.value = link;

  let state: LobbyState | null = null;
  let me = '';
  const myRow = () => (state ? state.rows.findIndex((r) => r.k === 'human' && r.peer === me) : -1);
  const myTeam = () => {
    const i = myRow();
    return i >= 0 ? state!.rows[i].team : 0;
  };
  const myChar = () => {
    const r = state?.rows[myRow()];
    return r?.k === 'human' ? r.char : choices[0].seed;
  };

  // ---- invite link
  m.querySelector('[data-a=copy]')!.addEventListener('click', async (e) => {
    const b = e.target as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(link);
      b.textContent = 'Copied';
    } catch {
      linkInput.select();
      b.textContent = 'Select & copy';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  });
  m.querySelector('[data-a=share]')?.addEventListener('click', () => {
    void navigator.share?.({ title: 'SWARM', text: 'Join my SWARM match', url: link }).catch(() => undefined);
  });

  // ---- characters
  chars.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-char]') as HTMLElement | null;
    if (!b || b.classList.contains('taken') || myRow() < 0) return;
    h.pick(myRow(), myTeam(), Number(b.dataset.char));
  });

  // ---- seats
  seats.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest('[data-seat]') as HTMLElement | null;
    if (!row || !state) return;
    const i = Number(row.dataset.seat);
    const r = state.rows[i];
    const a = t.dataset.a;
    if (a === 'sit') h.pick(i, myTeam(), myChar());
    else if (a === 'bot') h.host?.row(i, { k: 'bot', team: r.team, difficulty: 1, personality: 'random' });
    else if (a === 'close') h.host?.row(i, { k: 'closed', team: r.team });
    else if (a === 'open') h.host?.row(i, { k: 'open', team: r.team });
    else if (a === 'kick') h.host?.kick(i);
  });
  seats.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    const row = t.closest('[data-seat]') as HTMLElement | null;
    if (!row || !state) return;
    const i = Number(row.dataset.seat);
    const r = state.rows[i];
    if (t.dataset.a === 'team') {
      if (r.k === 'human') h.pick(i, Number(t.value), r.char);
      else h.host?.row(i, { ...r, team: Number(t.value) });
    }
    if (r.k === 'bot' && t.dataset.a === 'diff') h.host?.row(i, { ...r, difficulty: Number(t.value) });
    if (r.k === 'bot' && t.dataset.a === 'pers') h.host?.row(i, { ...r, personality: t.value as Personality | 'random' });
  });

  // ---- host controls
  teamsBox?.addEventListener('change', () => h.host?.teams(teamsBox.checked));
  seedInput.addEventListener('change', () => h.host?.seed(seedInput.value));
  m.querySelector('[data-a=dice]')?.addEventListener('click', () => {
    seedInput.value = randomSeed();
    h.host?.seed(seedInput.value);
  });
  m.querySelector('[data-a=start]')?.addEventListener('click', () => h.host?.start());
  m.querySelector('[data-a=leave]')!.addEventListener('click', h.leave);

  const teamSelect = (r: SeatRow, editable: boolean) =>
    state!.teams
      ? `<select data-a="team"${editable ? '' : ' disabled'}>${[0, 1, 2, 3, 4, 5].map((t) => `<option value="${t}"${t === r.team ? ' selected' : ''}>Team ${TEAM[t]}</option>`).join('')}</select>`
      : '';

  const seatHtml = (r: SeatRow, i: number): string => {
    const mine = r.k === 'human' && r.peer === me;
    const sw = `<i class="sw on" style="--c:${FACTION_HEX[i]}" title="${FACTION_NAMES[i]}"></i>`;
    let who = '';
    let actions = '';
    if (r.k === 'human') {
      const c = playerCharacter(r.char);
      const tags = [mine ? 'you' : '', r.peer === state!.host ? 'host' : ''].filter(Boolean).join(', ');
      who = `<span class="portrait" data-p="${i}"></span><b>${esc(c.name)}</b>${tags ? ` <small>(${tags})</small>` : ''}`;
      if (isHost && !mine) actions = '<button class="small" data-a="kick" title="Remove from the room">Remove</button>';
    } else if (r.k === 'bot') {
      who = isHost
        ? `<select data-a="diff">${DIFFICULTY_NAMES.map((d, k) => `<option value="${k}"${k === r.difficulty ? ' selected' : ''}>${d}</option>`).join('')}</select>
           <select data-a="pers">${(['random', ...PERSONALITIES] as const).map((p) => `<option value="${p}"${p === r.personality ? ' selected' : ''}>${PERSONA[p]}</option>`).join('')}</select>`
        : `Bot · ${DIFFICULTY_NAMES[r.difficulty]} · ${PERSONA[r.personality]}`;
      if (isHost) actions = '<button class="small" data-a="open">Remove bot</button>';
    } else if (r.k === 'open') {
      who = '<span class="hint">Open</span>';
      actions = `<button class="small" data-a="sit">Sit here</button>${isHost ? '<button class="small" data-a="bot">+ Bot</button><button class="small" data-a="close">Close</button>' : ''}`;
    } else {
      who = '<span class="hint">Closed</span>';
      if (isHost) actions = '<button class="small" data-a="open">Open</button>';
    }
    const teamEditable = mine || (isHost && r.k !== 'human');
    return `<div class="seat${mine ? ' me' : ''} ${r.k}" data-seat="${i}">${sw}<span class="who">${who}</span>${teamSelect(r, teamEditable)}<span class="acts">${actions}</span></div>`;
  };

  const renderChars = () => {
    const mine = myChar();
    const color = Math.max(0, myRow());
    const taken = new Set(state ? state.rows.filter((r) => r.k === 'human' && r.peer !== me).map((r) => playerCharacter((r as { char: number }).char).name) : []);
    const list = choices.some((c) => c.seed === mine) ? choices : [playerCharacter(mine), ...choices];
    chars.innerHTML = list
      .map((c) => `<button class="char${c.seed === mine ? ' on' : ''}${taken.has(c.name) ? ' taken' : ''}" data-char="${c.seed}" title="${taken.has(c.name) ? 'Someone in the room has this name' : esc(c.word)}"><span class="portrait"></span><b>${esc(c.name)}</b><small>${esc(c.word)}</small></button>`)
      .join('');
    chars.querySelectorAll<HTMLElement>('[data-char]').forEach((b) => {
      const c = playerCharacter(Number(b.dataset.char));
      b.querySelector('.portrait')!.replaceChildren(creatureCanvas(characterCreature(c, color), 44));
    });
  };

  let lastJson = '';
  const render = (s: LobbyState | null, self: string, canStart: boolean) => {
    me = self;
    const json = JSON.stringify(s);
    const startBtn = m.querySelector('[data-a=start]') as HTMLButtonElement | null;
    if (startBtn) startBtn.disabled = !canStart;
    if (json === lastJson) return;
    lastJson = json;
    state = s;
    m.classList.toggle('waiting', !s);
    if (!s) return;
    seats.innerHTML = s.rows.map(seatHtml).join('');
    seats.querySelectorAll<HTMLElement>('[data-p]').forEach((slot) => {
      const r = s.rows[Number(slot.dataset.p)];
      if (r.k === 'human') slot.replaceChildren(creatureCanvas(characterCreature(playerCharacter(r.char), Number(slot.dataset.p)), 28));
    });
    renderChars();
    fields.render(s.map, !isHost);
    if (teamsBox) teamsBox.checked = s.teams;
    if (document.activeElement !== seedInput) seedInput.value = s.seed;
  };

  return {
    el: m,
    render,
    status: (text, error = false) => {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('error', error);
    },
  };
}
