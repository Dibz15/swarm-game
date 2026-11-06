/**
 * Who's on your team (#74): the factions of a match grouped by team, yours
 * first, for the start banner, the HUD strip, the pause menu and the
 * domination text. Free-for-all (every team a single faction) reads as no
 * teams at all, so none of that changes. Allies always carry a shape (◆) or a
 * letter, never colour alone.
 */

import { FACTION_HEX, FACTION_NAMES } from '../content/factions';
import { NEUTRAL } from '../sim/index';
import type { World } from '../sim/world';

/** the mark an ally wears in text: a shape, so it doesn't rely on colour */
export const ALLY_MARK = '◆';

export interface TeamGroup {
  team: number;
  /** A for yours, then B, C… */
  letter: string;
  mine: boolean;
  members: number[];
}

export interface TeamLayout {
  /** some team has more than one faction: a team match */
  team: boolean;
  groups: TeamGroup[];
}

/** The match's factions grouped by team, your team first and lettered A. */
export function teamLayout(w: World, human: number): TeamLayout {
  const byTeam = new Map<number, number[]>();
  for (const f of w.factions) {
    if (!f.active || f.id === NEUTRAL) continue;
    const t = w.teamOf[f.id];
    byTeam.set(t, [...(byTeam.get(t) ?? []), f.id]);
  }
  const mineT = human >= 0 ? w.teamOf[human] : -1;
  const teams = [...byTeam.keys()].sort((a, b) => (a === mineT ? -1 : b === mineT ? 1 : a - b));
  const groups = teams.map((t, k) => {
    const members = byTeam.get(t)!;
    // You lead your own group.
    if (t === mineT) members.sort((a, b) => (a === human ? -1 : b === human ? 1 : a - b));
    return { team: t, letter: 'ABCDEF'[k] ?? '?', mine: t === mineT, members };
  });
  return { team: groups.some((g) => g.members.length > 1), groups };
}

/** Is `f` on your team (and not you)? */
export const isAlly = (w: World, human: number, f: number): boolean =>
  f !== human && f >= 0 && f !== NEUTRAL && human >= 0 && w.teamOf[f] === w.teamOf[human];

/** Which side a faction is on, from your seat: null for nobody's (unclaimed, neutral). */
export type Side = 'you' | 'ally' | 'enemy';
export function sideOf(w: World, human: number, f: number): Side | null {
  if (f < 0 || f === NEUTRAL) return null;
  return f === human ? 'you' : isAlly(w, human, f) ? 'ally' : 'enemy';
}

/**
 * A side's name for text, and whether it takes a plural verb: "You" (in
 * free-for-all) or "Your team" for yours; "Magenta + Lime" for a team of
 * several; "Magenta" when it stands alone.
 */
export function teamName(w: World, human: number, f: number, layout: TeamLayout = teamLayout(w, human)): { name: string; plural: boolean } {
  if (human >= 0 && w.teamOf[f] === w.teamOf[human]) return layout.team ? { name: 'Your team', plural: false } : { name: 'You', plural: true };
  const members = layout.groups.find((g) => g.team === w.teamOf[f])?.members ?? [f];
  return { name: members.map((m) => FACTION_NAMES[m]).join(' + '), plural: members.length > 1 };
}

/** "is"/"are", "leads"/"lead" and "Magenta's"/"Your" for a team name. */
export const verb = (t: { plural: boolean }, one: string, many: string): string => (t.plural ? many : one);
export const possessive = (t: { name: string }): string => (t.name === 'You' ? 'Your' : `${t.name}'s`);

/** One faction in team text: a swatch and its name, ◆ for an ally, struck through once out. */
function member(w: World, human: number, f: number): string {
  const out = w.factions[f].eliminated;
  const tag = f === human ? ' (you)' : isAlly(w, human, f) ? ` ${ALLY_MARK}` : '';
  return `<span class="tm${out ? ' out' : ''}" style="--c:${FACTION_HEX[f]}"><i></i>${FACTION_NAMES[f]}${tag}</span>`;
}

/** The teams in one line, for the start banner: "Your team (A): … vs B: …". */
export function teamsLine(w: World, human: number): string {
  return teamLayout(w, human)
    .groups.map((g) => `<span class="tg${g.mine ? ' mine' : ''}"><b>${g.mine ? `Your team (${g.letter})` : g.letter}:</b> ${g.members.map((f) => member(w, human, f)).join(' · ')}</span>`)
    .join('<em>vs</em>');
}

/** The teams as a list, for the pause menu and the strip's popover, with each side's army and nests. */
export function teamsList(w: World, human: number): string {
  const nests = (f: number) => w.nests.filter((n) => n.owner === f).length;
  return `<ul class="teams">${teamLayout(w, human)
    .groups.map(
      (g) =>
        `<li class="${g.mine ? 'mine' : ''}"><b>${g.mine ? `Team ${g.letter} · you` : `Team ${g.letter}`}</b>${g.members
          .map((f) => `<span>${member(w, human, f)} <small>${w.factions[f].eliminated ? 'out' : `${w.unitCount[f]} dots · ⬡${nests(f)}`}</small></span>`)
          .join('')}</li>`,
    )
    .join('')}</ul>`;
}
