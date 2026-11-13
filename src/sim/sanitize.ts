import { FACTION_UNIT_CAP, NEUTRAL } from './constants';
import type { Command } from './commands';
import { clamp } from './mathx';

/**
 * What sanitizing needs to know about the match. A World satisfies it; a
 * sequencer that runs no sim (a relay) can fill it in from the map.
 */
export interface CommandLimits {
  readonly width: number;
  readonly height: number;
  readonly nests: { readonly length: number };
  readonly endless?: boolean;
}

/** The limits of a world, as plain data (for a sequencer, or to send to one). */
export function limitsOf(w: CommandLimits): CommandLimits {
  return { width: w.width, height: w.height, nests: { length: w.nests.length }, endless: !!w.endless };
}

/**
 * Network commands are untrusted (#154). `sanitizeCommand` turns whatever
 * arrived into a well-formed Command, or null to drop it, before the sim
 * touches it: no NaN coordinates, no duplicate or endless unit lists, no
 * out-of-range ids, no commands for the wild swarms. Honest commands
 * (the local player's, every bot's) come through unchanged in meaning.
 * It only reads `w` (a World or plain `CommandLimits`) and never mutates `c`.
 */

/** Seconds a `summon` may bring the next swarm forward to. */
export const SUMMON_SECS = { min: 1, max: 600 } as const;
/** Boon offers hold three choices. */
const BOON_CHOICES = 3;

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Integers only, first occurrence kept, at most `cap`; null if not an array. */
function idList(v: unknown, cap: number): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const u of v) {
    if (out.length >= cap) break;
    if (!isInt(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

const nestOk = (w: CommandLimits, id: unknown): id is number => isInt(id) && id >= 0 && id < w.nests.length;

/** Map coordinates, clamped to the map; null if either isn't a finite number (`clamp` keeps NaN). */
function point(w: CommandLimits, x: unknown, y: unknown): { x: number; y: number } | null {
  if (!isNum(x) || !isNum(y)) return null;
  return { x: clamp(x, 0, w.width), y: clamp(y, 0, w.height) };
}

export function sanitizeCommand(w: CommandLimits, c: unknown): Command | null {
  if (typeof c !== 'object' || c === null) return null;
  const r = c as Record<string, unknown>;
  const p = r.p;
  // Factions 0..5 only: NEUTRAL (the wild swarms) is always active, and no player commands it.
  if (!isInt(p) || p < 0 || p >= NEUTRAL) return null;
  const units = () => idList(r.units, FACTION_UNIT_CAP);

  switch (r.t) {
    case 'move': {
      const u = units(), at = point(w, r.x, r.y);
      if (!u || !at) return null;
      return { t: 'move', p, units: u, x: at.x, y: at.y, nest: nestOk(w, r.nest) ? r.nest : -1 };
    }
    case 'rally': {
      const nests = idList(r.nests, w.nests.length), at = point(w, r.x, r.y);
      if (!nests || !at || !nests.every((id) => nestOk(w, id))) return null;
      return { t: 'rally', p, nests, x: at.x, y: at.y };
    }
    case 'upgrade':
    case 'lockdown':
      return nestOk(w, r.nest) ? { t: r.t, p, nest: r.nest } : null;
    case 'surge':
    case 'nova':
    case 'fortify': {
      const u = units();
      return u ? { t: r.t, p, units: u } : null;
    }
    case 'barrage': {
      const at = point(w, r.x, r.y);
      return at ? { t: 'barrage', p, x: at.x, y: at.y } : null;
    }
    case 'blink': {
      const u = units(), at = point(w, r.x, r.y);
      return u && at ? { t: 'blink', p, units: u, x: at.x, y: at.y } : null;
    }
    case 'summon':
      if (!w.endless || !isNum(r.secs)) return null;
      return { t: 'summon', p, secs: clamp(r.secs, SUMMON_SECS.min, SUMMON_SECS.max) };
    case 'boon':
      return isInt(r.k) && r.k >= 0 && r.k < BOON_CHOICES ? { t: 'boon', p, k: r.k } : null;
    default:
      return null;
  }
}

/** Coordinates snap to this grid at issue time, so the log, the recorder and the wire agree bit for bit. */
export const QUANTUM = 16;
const snap = (v: number) => Math.round(v * QUANTUM) / QUANTUM;

/** Ascending with no repeats already? */
function canonical(ids: number[]): boolean {
  for (let k = 1; k < ids.length; k++) if (ids[k] <= ids[k - 1]) return false;
  return true;
}

const sortedIds = (ids: number[]) => (canonical(ids) ? ids : [...new Set(ids)].sort((a, b) => a - b));

/**
 * The canonical form of a command, applied where a client issues it
 * (LocalSession.issue, NetSession.issue) and never inside the sim, so bots'
 * own orders stay exact:
 * - x/y snap to 1/16 px;
 * - unit and nest lists are sorted ascending, without repeats (the wire
 *   sends them delta-coded, #157).
 * The log, the recorder and the wire then hold the same command. Returns `c`
 * itself when it is already canonical.
 */
export function normalizeCommand(c: Command): Command {
  let out = c;
  if ('x' in c && (snap(c.x) !== c.x || snap(c.y) !== c.y)) out = { ...c, x: snap(c.x), y: snap(c.y) };
  if ('units' in c && !canonical(c.units)) out = { ...out, units: sortedIds(c.units) } as Command;
  if ('nests' in c && !canonical(c.nests)) out = { ...out, nests: sortedIds(c.nests) } as Command;
  return out;
}
