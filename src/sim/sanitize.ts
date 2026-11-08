import { FACTION_UNIT_CAP, NEUTRAL } from './constants';
import type { Command } from './commands';
import { clamp } from './mathx';
import type { World } from './world';

/**
 * Network commands are untrusted (#154). `sanitizeCommand` turns whatever
 * arrived into a well-formed Command, or null to drop it, before the sim
 * touches it: no NaN coordinates, no duplicate or endless unit lists, no
 * out-of-range ids, no commands for the wild swarms. Honest commands
 * (the local player's, every bot's) come through unchanged in meaning.
 * It only reads `w` and never mutates `c`.
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

const nestOk = (w: World, id: unknown): id is number => isInt(id) && id >= 0 && id < w.nests.length;

/** Map coordinates, clamped to the map; null if either isn't a finite number (`clamp` keeps NaN). */
function point(w: World, x: unknown, y: unknown): { x: number; y: number } | null {
  if (!isNum(x) || !isNum(y)) return null;
  return { x: clamp(x, 0, w.width), y: clamp(y, 0, w.height) };
}

export function sanitizeCommand(w: World, c: unknown): Command | null {
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
const QUANTUM = 16;
const snap = (v: number) => Math.round(v * QUANTUM) / QUANTUM;

/**
 * Round a command's x/y to 1/16 px. Applied where a client issues a command
 * (LocalSession.issue), never inside the sim: bots' own orders stay exact.
 */
export function quantizeCommand(c: Command): Command {
  if (!('x' in c)) return c;
  return { ...c, x: snap(c.x), y: snap(c.y) };
}
