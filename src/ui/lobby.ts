/**
 * Multiplayer screens (#162): the entry card and the room lobby. Rendering
 * only: `src/net/lobby.ts` owns the state, `main.ts` wires the two.
 */

import { creatureCanvas } from '../art/creature';
import { FACTION_HEX, FACTION_NAMES } from '../content/factions';
import { characterCreature, playerCharacter, type Character } from '../game/character';
import { randomSeed } from '../game/matchSetup';
import qrcode from 'qrcode-generator';
import { BOT_SECS, COUNTDOWN_MS, type BotSecs, type LobbyState, type SeatRow } from '../net/lobby';
import type { LinkInfo } from '../net/transport';
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

/**
 * Players' games stopped matching (#165): the match is halted. Everyone can
 * download a report; the host can send everyone the agreed world (resync)
 * or play on as is.
 */
export function desyncCard(o: {
  when: string;
  host: boolean;
  download: () => void;
  resync?: () => void;
  resume?: () => void;
  leave: () => void;
}): { el: HTMLDivElement; detail: (text: string) => void; canResync: (on: boolean) => void } {
  const m = el(`
    <div class="screen modal dim">
      <div class="card">
        <h2>The games stopped matching</h2>
        <p></p>
        <p class="hint detail">${o.host ? 'Comparing everyone’s game…' : 'Waiting for the host to compare everyone’s game…'}</p>
        <p class="hint">A report helps us find the cause: download it and send it to the developers.</p>
        <div class="menu-buttons">
          ${o.host ? '<button class="primary" data-a="resync" disabled>Resync and continue</button><button data-a="resume">Play on as is</button>' : ''}
          <button data-a="download">Download report</button>
          <button data-a="leave">Leave match</button>
        </div>
      </div>
    </div>`);
  m.querySelector('p')!.textContent = `At ${o.when}, players’ games disagreed about the match, so it has stopped for everyone.${o.host ? '' : ' The host can resync everyone, or play on.'}`;
  const detail = m.querySelector('.detail') as HTMLElement;
  const resync = m.querySelector('[data-a=resync]') as HTMLButtonElement | null;
  resync?.addEventListener('click', () => o.resync?.());
  m.querySelector('[data-a=resume]')?.addEventListener('click', () => o.resume?.());
  m.querySelector('[data-a=download]')!.addEventListener('click', o.download);
  m.querySelector('[data-a=leave]')!.addEventListener('click', o.leave);
  return {
    el: m,
    detail: (text) => (detail.textContent = text),
    canResync: (on) => {
      if (resync) resync.disabled = !on;
    },
  };
}

/** The Multiplayer entry: host a room, or paste a link to join one. */
/** A match saved when everyone lost touch (#191), as the Multiplayer menu lists it. */
export interface SavedMatchItem {
  label: string;
  open: () => void;
  del: () => void;
}

export function multiplayerMenu(h: { host: () => void; join: (link: string) => void; back: () => void; saved?: SavedMatchItem[] }): HTMLDivElement {
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
        <div class="field saved-matches" hidden>
          <label>Saved matches <small>picked up where everyone lost touch</small></label>
          <div class="saved-list"></div>
        </div>
        <div class="relay-field"></div>
        <div class="row end"><button data-a="back">Back</button></div>
      </div>
    </div>`);
  m.querySelector('.relay-field')!.replaceWith(relayField());
  // matches saved when everyone lost touch (#191): open the room again, or forget it
  const saved = h.saved ?? [];
  const list = m.querySelector('.saved-list')!;
  (m.querySelector('.saved-matches') as HTMLElement).hidden = saved.length === 0;
  for (const s of saved) {
    const row = el(`<div class="row saved-match"><span class="grow"></span><button class="small primary" data-a="open">Open</button><button class="small" data-a="del">Delete</button></div>`);
    row.querySelector('span')!.textContent = s.label;
    row.querySelector('[data-a=open]')!.addEventListener('click', s.open);
    row.querySelector('[data-a=del]')!.addEventListener('click', s.del);
    list.appendChild(row);
  }
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
  /** a guest: ready for the next match, or not (#184) */
  ready?: (on: boolean) => void;
  /** after a failed join: try the same link again */
  retry?: () => void;
  /** Start's countdown ticked: 3, 2, 1, then 0 for go (#184) */
  tick?: (n: number) => void;
  host?: {
    map: (patch: Partial<MapChoice>) => void;
    teams: (on: boolean) => void;
    /** how long a dropped player's seat idles before an Easy bot takes it (#164) */
    botSecs: (s: BotSecs) => void;
    seed: (text: string) => void;
    row: (seat: number, row: Exclude<SeatRow, { k: 'human' }>) => void;
    kick: (seat: number) => void;
    start: () => void;
    /** stop Start's countdown (#184) */
    cancel: () => void;
    /** "Everyone's here" (true), or let newcomers in again (#184) */
    lock: (on: boolean) => void;
    fillBots: () => void;
    /** Quick match: a new random map at each Start (#184) */
    randomMap: (on: boolean) => void;
    /** "Runs the match" (#190): a player by peer id, or null for Auto */
    runner: (peer: string | null) => void;
  };
}

export interface LobbyView {
  el: HTMLDivElement;
  render: (s: LobbyState | null, me: string, canStart: boolean) => void;
  /** a line under the title: connecting, waiting… (`error` makes it stand out) */
  status: (text: string, error?: boolean) => void;
  /** the room couldn't be joined, or is gone: a card over the screen, with Try again (when it may help) and Back */
  fail: (title: string, text: string, retry?: boolean) => void;
  /** a short note that fades: "Gloamfang joined" (#184) */
  notice: (text: string, color?: string) => void;
  /** how our links to the others are doing, by peer (#184) */
  links: (info: ReadonlyMap<string, LinkInfo>) => void;
}

type Tab = 'room' | 'players' | 'match';

/** The invite link as a QR code: dark modules as one SVG path, drawn in the text colour. */
function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + 4} ${n + 4}" role="img" aria-label="QR code of the invite link" shape-rendering="crispEdges"><rect width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#05060d"/></svg>`;
}

/**
 * The room (#184): a screen of its own, nothing running behind it. Tabs for
 * the room (invite, your character) and the match (map settings); the
 * roster of players is a side panel on wide screens and a third tab on
 * phones. The host's Start (or a guest's Ready) sits in a bar at the bottom.
 */
export function lobbyScreen(link: string, choices: Character[], h: LobbyHandlers): LobbyView {
  const isHost = !!h.host;
  const m = el(`
    <div class="screen lobby-screen opaque" data-tab="room">
      <div class="lobby-bg" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <header class="lobby-head">
        <div class="lobby-title"><h2>${isHost ? 'Your room' : 'Joining a room'}</h2><span class="pill in" hidden>You’re in</span></div>
        <button class="small" data-a="leave">Leave</button>
        <p class="status hint"></p>
      </header>
      <nav class="lobby-tabs" role="tablist">
        <button data-tab="room" class="on">Room</button>
        <button data-tab="players">Players <b class="count"></b></button>
        <button data-tab="match">Match</button>
      </nav>
      <div class="connecting" role="status"><i class="spin" aria-hidden="true"></i><p class="cstatus">Connecting to the room…</p><p class="hint">This can take a few seconds.</p></div>
      <div class="lobby-body">
        <main class="lobby-main">
          <section data-pane="room">
            <div class="field invite">
              <label>${isHost ? 'Invite friends' : 'Invite more'} <small class="lockline"></small></label>
              <div class="invite-row">
                ${isHost ? '<div class="qr"></div>' : ''}
                <div class="invite-link">
                  <input class="link" readonly spellcheck="false">
                  <div class="row"><button class="small" data-a="copy">Copy link</button>${'share' in navigator ? '<button class="small" data-a="share">Share</button>' : ''}</div>
                  <p class="hint">Anyone with this link can join${relayOnly() ? ' · your IP stays hidden (relay only)' : ''}.${isHost ? ' A phone can scan the code.' : ''}</p>
                </div>
              </div>
            </div>
            <div class="field">
              <label>Choose your character</label>
              <div class="chars"></div>
            </div>
            ${
              isHost
                ? `<div class="field">
              <label>If a player drops <small>their colour idles, then an Easy bot plays it until they're back</small></label>
              <select data-a="botsecs">${BOT_SECS.map((s) => `<option value="${s}">Easy bot after ${s < 60 ? `${s} s` : `${s / 60} min`}</option>`).join('')}</select>
            </div>
            <div class="field">
              <label>Runs the match <small>whose browser keeps the match’s clock. You keep pause, restart and the room either way</small></label>
              <select data-a="runner"></select>
            </div>`
                : ''
            }
          </section>
          <section data-pane="match">
            ${isHost ? '' : '<p class="hint">The host chooses the map.</p>'}
            <label class="check quick"><input type="checkbox" data-a="random"${isHost ? '' : ' disabled'}> Quick match <small class="hint">a new random map at each start, sized for the players</small></label>
            <div class="mapfields"></div>
            <label class="check"><input type="checkbox" data-a="teams"${isHost ? '' : ' disabled'}> Teams <small class="hint">choose each colour’s team in the roster</small></label>
            <div class="field">
              <label>Map seed</label>
              <div class="row"><input class="seed" spellcheck="false"${isHost ? '' : ' readonly'}>${isHost ? '<button class="small icon" data-a="dice" title="Random seed">⟳</button>' : ''}</div>
            </div>
          </section>
        </main>
        <aside class="roster" data-pane="players">
          <h3>Players <span class="count"></span></h3>
          <div class="seats"></div>
          ${
            isHost
              ? `<div class="roster-foot">
                  <div class="row"><button data-a="lock"></button><button data-a="fill">Fill with bots</button></div>
                  <p class="hint lockhint"></p>
                </div>`
              : ''
          }
        </aside>
      </div>
      <footer class="lobby-bar">
        <span class="hint barnote"></span>
        ${isHost ? '<button class="primary" data-a="start" disabled>Start match</button>' : '<button data-a="ready" disabled>I’m ready</button>'}
      </footer>
      <div class="toasts"></div>
      <div class="countdown" hidden><b></b><small>Get ready</small></div>
      <div class="lobby-fail" hidden><div class="card"><h2></h2><p></p><div class="row end"><button data-a="back">Back to menu</button><button class="primary" data-a="retry">Try again</button></div></div></div>
    </div>`);
  const $ = <T extends Element = HTMLElement>(q: string) => m.querySelector(q) as T;
  const status = $<HTMLParagraphElement>('.status');
  const linkInput = $<HTMLInputElement>('.link');
  const chars = $<HTMLDivElement>('.chars');
  const seats = $<HTMLDivElement>('.seats');
  const seedInput = $<HTMLInputElement>('.seed');
  const teamsBox = $<HTMLInputElement>('[data-a=teams]');
  const randomBox = $<HTMLInputElement>('[data-a=random]');
  const botBox = m.querySelector('[data-a=botsecs]') as HTMLSelectElement | null;
  const runnerBox = m.querySelector('[data-a=runner]') as HTMLSelectElement | null;
  const toasts = $<HTMLDivElement>('.toasts');
  const countdown = $<HTMLDivElement>('.countdown');
  const fail = $<HTMLDivElement>('.lobby-fail');
  const fields = mapFields((patch) => h.host?.map(patch));
  $('.mapfields').replaceWith(fields.el);
  linkInput.value = link;
  try {
    m.querySelector('.qr')?.insertAdjacentHTML('beforeend', qrSvg(link));
  } catch {
    m.querySelector('.qr')?.remove(); // too long for a code: the link and Share do
  }

  let state: LobbyState | null = null;
  let me = '';
  let links: ReadonlyMap<string, LinkInfo> = new Map();
  const myRow = () => (state ? state.rows.findIndex((r) => r.k === 'human' && r.peer === me) : -1);
  const myTeam = () => {
    const i = myRow();
    return i >= 0 ? state!.rows[i].team : 0;
  };
  const myChar = () => {
    const r = state?.rows[myRow()];
    return r?.k === 'human' ? r.char : choices[0].seed;
  };

  // ---- tabs: the roster is one only on narrow screens (CSS hides the button otherwise)
  const setTab = (t: Tab) => {
    m.dataset.tab = t;
    m.querySelectorAll<HTMLElement>('.lobby-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'players') m.querySelector('.lobby-tabs .count')?.classList.remove('bump');
  };
  $('.lobby-tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
    if (b) setTab(b.dataset.tab as Tab);
  });

  // ---- invite link
  $('[data-a=copy]').addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(link);
      b.textContent = 'Copied';
    } catch {
      linkInput.select();
      b.textContent = 'Select & copy';
    }
    setTimeout(() => (b.textContent = 'Copy link'), 1500);
  });
  m.querySelector('[data-a=share]')?.addEventListener('click', () => {
    void navigator.share?.({ title: 'SWARM', text: 'Join my SWARM match', url: link }).catch(() => undefined);
  });

  // ---- characters
  chars.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-char]') as HTMLElement | null;
    if (!b || b.classList.contains('taken') || myRow() < 0 || state?.phase !== 'lobby') return;
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
  teamsBox.addEventListener('change', () => h.host?.teams(teamsBox.checked));
  randomBox.addEventListener('change', () => h.host?.randomMap(randomBox.checked));
  botBox?.addEventListener('change', () => h.host?.botSecs(Number(botBox.value) as BotSecs));
  runnerBox?.addEventListener('change', () => h.host?.runner(runnerBox.value || null));
  seedInput.addEventListener('change', () => h.host?.seed(seedInput.value));
  m.querySelector('[data-a=dice]')?.addEventListener('click', () => {
    seedInput.value = randomSeed();
    h.host?.seed(seedInput.value);
  });
  m.querySelector('[data-a=start]')?.addEventListener('click', () => (state?.phase === 'starting' ? h.host?.cancel() : h.host?.start()));
  m.querySelector('[data-a=lock]')?.addEventListener('click', () => h.host?.lock(!state?.locked));
  m.querySelector('[data-a=fill]')?.addEventListener('click', () => h.host?.fillBots());
  m.querySelector('[data-a=ready]')?.addEventListener('click', () => {
    const r = state?.rows[myRow()];
    if (r?.k === 'human') h.ready?.(!r.ready);
  });
  $('[data-a=leave]').addEventListener('click', h.leave);
  fail.querySelector('[data-a=back]')!.addEventListener('click', h.leave);
  fail.querySelector('[data-a=retry]')!.addEventListener('click', () => h.retry?.());

  const teamSelect = (r: SeatRow, editable: boolean) =>
    state!.teams
      ? `<select data-a="team"${editable ? '' : ' disabled'}>${[0, 1, 2, 3, 4, 5].map((t) => `<option value="${t}"${t === r.team ? ' selected' : ''}>Team ${TEAM[t]}</option>`).join('')}</select>`
      : '';

  const netHtml = (peer: string) => {
    const l = links.get(peer);
    if (!l || (l.rtt === undefined && l.relay === undefined)) return '';
    const ms = l.rtt === undefined ? '' : `${l.rtt} ms`;
    const cls = l.rtt === undefined ? '' : l.rtt < 120 ? 'good' : l.rtt < 250 ? 'ok' : 'bad';
    return `<span class="${cls}" title="Round trip from you${l.relay ? ', through the relay' : ''}">${ms}</span>${l.relay ? ' <i class="relay" title="Through the relay">relay</i>' : ''}`;
  };

  const seatHtml = (r: SeatRow, i: number): string => {
    const mine = r.k === 'human' && r.peer === me;
    const open = state!.phase === 'lobby';
    const sw = `<i class="sw on" style="--c:${FACTION_HEX[i]}" title="${FACTION_NAMES[i]}"></i>`;
    let who = '';
    let actions = '';
    let side = '';
    if (r.k === 'human') {
      const c = playerCharacter(r.char);
      const tags = [mine ? 'you' : '', r.peer === state!.host ? 'host' : ''].filter(Boolean).join(', ');
      who = `<span class="portrait" data-p="${i}"></span><b>${esc(c.name)}</b>${tags ? ` <small>(${tags})</small>` : ''}`;
      side = `${r.peer !== state!.host ? `<span class="rdy${r.ready ? ' on' : ''}" title="${r.ready ? 'Ready' : 'Not ready yet'}">${r.ready ? '✓ Ready' : ''}</span>` : ''}<span class="net" data-net="${esc(r.peer)}">${mine ? '' : netHtml(r.peer)}</span>`;
      if (isHost && !mine && open) actions = '<button class="small" data-a="kick" title="Remove from the room">Remove</button>';
    } else if (r.k === 'bot') {
      who = isHost
        ? `<span class="bot-tag">Bot</span><select data-a="diff">${DIFFICULTY_NAMES.map((d, k) => `<option value="${k}"${k === r.difficulty ? ' selected' : ''}>${d}</option>`).join('')}</select>
           <select data-a="pers">${(['random', ...PERSONALITIES] as const).map((p) => `<option value="${p}"${p === r.personality ? ' selected' : ''}>${PERSONA[p]}</option>`).join('')}</select>`
        : `<span class="bot-tag">Bot</span> ${DIFFICULTY_NAMES[r.difficulty]} · ${PERSONA[r.personality]}`;
      if (isHost && open) actions = '<button class="small" data-a="open" title="Remove the bot">✕</button>';
    } else if (r.k === 'open') {
      who = `<span class="hint" title="${state!.locked ? 'Empty: the room is closed' : 'A player who joins sits here'}">${state!.locked ? 'Empty' : 'Open'}</span>`;
      if (open) actions = `${myRow() >= 0 ? '<button class="small" data-a="sit" title="Switch to this colour">Play this colour</button>' : ''}${isHost ? '<button class="small" data-a="bot">+ Bot</button><button class="small" data-a="close">Close</button>' : ''}`;
    } else {
      who = '<span class="hint">Closed</span>';
      if (isHost && open) actions = '<button class="small" data-a="open">Open</button>';
    }
    const teamEditable = open && (mine || (isHost && r.k !== 'human'));
    return `<div class="seat${mine ? ' me' : ''} ${r.k}" data-seat="${i}">${sw}<span class="who">${who}</span>${side}${teamSelect(r, teamEditable)}<span class="acts">${actions}</span></div>`;
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

  // ---- the countdown: 3, 2, 1 from when this screen saw Start, by our own clock
  let counting: ReturnType<typeof setInterval> | null = null;
  const stopCount = () => {
    if (counting) clearInterval(counting);
    counting = null;
    countdown.hidden = true;
  };
  const startCount = () => {
    if (counting) return;
    const from = performance.now();
    let shown = -1;
    const show = () => {
      const n = Math.max(0, Math.ceil((COUNTDOWN_MS - (performance.now() - from)) / 1000));
      if (n === shown) return;
      shown = n;
      countdown.querySelector('b')!.textContent = n > 0 ? String(n) : 'Go';
      countdown.querySelector('b')!.classList.remove('pop');
      void (countdown.querySelector('b') as HTMLElement).offsetWidth;
      countdown.querySelector('b')!.classList.add('pop');
      h.tick?.(n);
    };
    countdown.hidden = false;
    show();
    counting = setInterval(show, 100);
  };

  /** the bottom bar and the roster's footer: what can be done now, and why not */
  const renderBar = (canStart: boolean) => {
    const s = state;
    const note = $('.barnote');
    const startBtn = m.querySelector('[data-a=start]') as HTMLButtonElement | null;
    const readyBtn = m.querySelector('[data-a=ready]') as HTMLButtonElement | null;
    if (!s) {
      if (startBtn) startBtn.disabled = true;
      if (readyBtn) readyBtn.disabled = true;
      note.textContent = '';
      return;
    }
    const guests = s.rows.filter((r): r is Extract<SeatRow, { k: 'human' }> => r.k === 'human' && r.peer !== s.host);
    const ready = guests.filter((r) => r.ready).length;
    const sides = s.rows.filter((r) => r.k === 'human' || r.k === 'bot').length;
    if (startBtn) {
      const starting = s.phase === 'starting';
      startBtn.disabled = !starting && !canStart;
      startBtn.textContent = starting ? 'Cancel' : 'Start match';
      startBtn.classList.toggle('primary', !starting);
      note.textContent = starting ? 'Starting…' : sides < 2 ? 'Add a player or a bot to start' : guests.length ? `${ready}/${guests.length} ready` : 'Just you and bots';
    }
    if (readyBtn) {
      const r = s.rows[myRow()];
      const on = r?.k === 'human' && !!r.ready;
      readyBtn.disabled = s.phase !== 'lobby' || myRow() < 0;
      readyBtn.textContent = on ? '✓ Ready' : 'I’m ready';
      readyBtn.classList.toggle('primary', !on);
      readyBtn.classList.toggle('on', on);
      note.textContent = s.phase === 'starting' ? 'Starting…' : on ? 'Waiting for the host to start' : 'Tell the host you’re set';
    }
    const lock = m.querySelector('[data-a=lock]') as HTMLButtonElement | null;
    if (lock) {
      lock.textContent = s.locked ? 'Reopen room' : 'Everyone’s here';
      lock.classList.toggle('primary', !s.locked);
      lock.disabled = s.phase !== 'lobby';
      const fill = $<HTMLButtonElement>('[data-a=fill]');
      fill.hidden = !s.rows.some((r) => r.k === 'open');
      fill.disabled = s.phase !== 'lobby';
      $('.lockhint').textContent = s.locked ? 'The room is closed to new players.' : 'Anyone with the link can join. When everyone’s in, close the room, then fill the empty seats with bots or leave them empty.';
    }
    $('.lockline').textContent = s.locked ? '· the room is closed to new players' : '';
    m.classList.toggle('locked', s.locked);
  };

  /** the folded list of empty colours: open on wide screens, closed on phones, then as the player leaves it */
  let emptiesOpen = !(document.body.classList.contains('mobile') || matchMedia('(max-width: 899px)').matches);
  seats.addEventListener(
    'toggle',
    (e) => {
      if ((e.target as HTMLElement).classList.contains('empties')) emptiesOpen = (e.target as HTMLDetailsElement).open;
    },
    true,
  );

  let lastJson = '';
  const render = (s: LobbyState | null, self: string, canStart: boolean) => {
    me = self;
    const json = JSON.stringify(s);
    state = s;
    renderBar(canStart);
    if (json === lastJson) return;
    lastJson = json;
    m.classList.toggle('waiting', !s);
    if (!s) return;
    if (!isHost) {
      const host = s.rows.find((r) => r.k === 'human' && r.peer === s.host);
      $('h2').textContent = host?.k === 'human' ? `${playerCharacter(host.char).name}’s room` : 'The room';
      $('.pill.in').hidden = myRow() < 0;
    }
    const sides = s.rows.filter((r) => r.k === 'human' || r.k === 'bot').length;
    m.querySelectorAll('.count').forEach((c) => (c.textContent = `${sides}/${s.rows.filter((r) => r.k !== 'closed').length}`));
    // the players (and bots) first; empty and closed colours fold away under them, closed by default on phones
    const filled = s.rows.map((r, i) => (r.k === 'human' || r.k === 'bot' ? seatHtml(r, i) : '')).join('');
    const empty = s.rows.map((r, i) => (r.k === 'open' || r.k === 'closed' ? seatHtml(r, i) : '')).join('');
    const nEmpty = s.rows.filter((r) => r.k === 'open' || r.k === 'closed').length;
    const nOpen = s.rows.filter((r) => r.k === 'open').length;
    seats.innerHTML = `<div class="filled">${filled}</div>${
      nEmpty ? `<details class="empties"${emptiesOpen ? ' open' : ''}><summary>${nOpen ? `${nOpen} open colour${nOpen > 1 ? 's' : ''}` : 'No open colours'}${nEmpty > nOpen ? ` · ${nEmpty - nOpen} closed` : ''}</summary><div class="empty-list">${empty}</div></details>` : ''
    }`;
    seats.querySelectorAll<HTMLElement>('[data-p]').forEach((slot) => {
      const r = s.rows[Number(slot.dataset.p)];
      if (r.k === 'human') slot.replaceChildren(creatureCanvas(characterCreature(playerCharacter(r.char), Number(slot.dataset.p)), 28));
    });
    renderChars();
    // Quick match rolls the map at Start: the fields show it, but there's nothing to choose
    fields.render(s.map, !isHost || s.phase !== 'lobby' || s.randomMap);
    randomBox.checked = s.randomMap;
    m.classList.toggle('random-map', s.randomMap);
    seedInput.readOnly = !isHost || s.randomMap;
    teamsBox.checked = s.teams;
    if (botBox && document.activeElement !== botBox) botBox.value = String(s.botSecs);
    if (runnerBox && document.activeElement !== runnerBox) {
      // Auto, then each player in the room
      const opts = [`<option value="">Auto: the best-connected player</option>`];
      for (const r of s.rows) if (r.k === 'human') opts.push(`<option value="${esc(r.peer)}">${esc(playerCharacter(r.char).name)}${r.peer === me ? ' (you)' : ''}</option>`);
      runnerBox.innerHTML = opts.join('');
      runnerBox.value = s.runner && s.rows.some((r) => r.k === 'human' && r.peer === s.runner) ? s.runner : '';
    }
    // a field you can't type in shows the host's seed even while focused: skipped now, it would stay stale (#215)
    if (seedInput.readOnly || document.activeElement !== seedInput) seedInput.value = s.seed;
    if (s.phase === 'starting') startCount();
    else stopCount();
  };

  return {
    el: m,
    render,
    status: (text, error = false) => {
      // before we're in, the connecting card says it big; after, the line under the title
      if (!state && text && !error) $('.cstatus').textContent = text;
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('error', error);
    },
    fail: (title, text, retry = false) => {
      stopCount();
      fail.querySelector('h2')!.textContent = title;
      fail.querySelector('p')!.textContent = text;
      (fail.querySelector('[data-a=retry]') as HTMLElement).hidden = !retry || !h.retry;
      fail.hidden = false;
    },
    notice: (text, color = 'var(--accent)') => {
      const t = document.createElement('div');
      t.className = 'toast';
      t.style.setProperty('--c', color);
      t.textContent = text;
      toasts.prepend(t);
      while (toasts.children.length > 4) toasts.lastElementChild!.remove();
      setTimeout(() => t.classList.add('out'), 2600);
      setTimeout(() => t.remove(), 3200);
      // a phone on another tab: the roster tab's count says so
      if (m.dataset.tab !== 'players') m.querySelector('.lobby-tabs .count')?.classList.add('bump');
    },
    links: (info) => {
      links = info;
      seats.querySelectorAll<HTMLElement>('[data-net]').forEach((n) => {
        if (n.dataset.net !== me) n.innerHTML = netHtml(n.dataset.net!);
      });
    },
  };
}
