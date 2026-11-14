import { decodeMsg, msgKind } from './codec';
import type { MsgKind } from './protocol';

/**
 * What this page's room traffic did, for chasing a bug only real browsers
 * show (#216): every lobby message sent and received, links coming and
 * going, and sends the transport dropped. Match traffic (turns, pings…)
 * is left out: it would push the rest out in seconds. A ring of the last
 * `MAX` lines; it outlives leaving and rejoining a room, so a rejoin is
 * seen next to the visit before it. Read it with `swarm.netLog()` on a page
 * opened with `?debug`.
 */

const MAX = 1000;
const lines: string[] = [];
const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

/** the lobby's message kinds: the rest are the match's */
const LOGGED: ReadonlySet<MsgKind> = new Set(['hello', 'refuse', 'seats', 'start', 'lobby', 'pick', 'ready', 'mark', 'pass', 'host']);

/** A peer id short enough to read: its first 6 characters. */
export const short = (peer: string | null | undefined) => (peer ? peer.slice(0, 6) : '-');

export function netNote(text: string): void {
  const s = ((performance.now() - t0) / 1000).toFixed(2).padStart(8);
  lines.push(`${s}  ${text}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

/** A message that went out (`>`), came in (`<`), or was dropped on the way out (`x`, with why), if it's the lobby's. */
export function netMsg(dir: '>' | '<' | 'x', peer: string, bytes: Uint8Array, why = ''): void {
  const k = msgKind(bytes);
  if (!k || !LOGGED.has(k)) return;
  const d = detail(bytes);
  // the host sends the room again every few seconds (#214): an unchanged one says nothing new. A drop always shows
  if (k === 'lobby' && dir !== 'x') {
    const key = `${dir}${peer}`;
    if (lastRoom.get(key) === d) return;
    lastRoom.set(key, d);
  }
  netNote(`${dir} ${short(peer)} ${k}${d}${why ? `  [${why}]` : ''}`);
}

/** the last room logged each way with each peer */
const lastRoom = new Map<string, string>();

function detail(bytes: Uint8Array): string {
  const m = decodeMsg(bytes);
  if (!m) return ' (undecodable)';
  switch (m.k) {
    case 'hello':
      return m.query ? ' query' : m.token ? ' token' : ' no-token';
    case 'host':
      return ` names ${short(m.peer)}`;
    case 'refuse':
      return ` "${m.reason}"`;
    case 'pass':
      return ` to ${short(m.to)}`;
    case 'start':
      return ` seat ${m.seat} tick ${m.tick}${m.runner ? ` runner ${short(m.runner)}` : ''}`;
    case 'lobby': {
      try {
        const s = JSON.parse(m.state) as { host: string; phase: string; rows: { k: string; peer?: string }[] };
        return ` phase ${s.phase} host ${short(s.host)} [${s.rows.map((r) => (r.k === 'human' ? short(r.peer) : r.k[0])).join(' ')}] #${hash(m.state)}`;
      } catch {
        return '';
      }
    }
    case 'mark':
      return ` ${m.ready}`;
    default:
      return '';
  }
}

/** A short tag for a room state: any change gives another, and both ends of a link log the same one. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/** The log, oldest first, one line each. */
export function netLog(): string {
  return lines.join('\n');
}
